/**
 * A Cloudflare Email Worker which can be configured with routes to forward 
 * from an address using subaddressing (o.k.a. subaddress extension [RFC 5233];
 * a.k.a. detailed addressing, plus addresses, tagged addresses, mail
 * extension, etc.) to one or more destination addresses
 *
 * Copyright (C) 2024 Jeremy Harnois
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import escape from 'regexp.escape';

export const DEFAULTS = {
    // Control whether different categories of stored configuration will be
    // loaded from the Cloudflare KV-based key-value store

    // For loading of stored BASIC configuration:
    //
    USE_STORED_USER_CONFIGURATION: "true",
    USE_STORED_ADDRESS_GLOBAL_CONFIGURATION: "true",

    // For loading of stored ADVANCED configuration:
    //
    USE_STORED_FORMAT_GLOBAL_CONFIGURATION: "false",
    USE_STORED_FORWARD_RETRY_GLOBAL_CONFIGURATION: "false",
    USE_STORED_HEADER_GLOBAL_CONFIGURATION: "false",

    // BASIC configuration

    // If USE_STORED_ADDRESS_CONFIGURATION is enabled then
    // this stored address global configuration will be loaded
    //
    DESTINATION: "",
    REJECT_TREATMENT: ": Invalid recipient",
    SUBADDRESSES: "*",
    USERS: "",

    // ADVANCED configuration

    // If USE_STORED_FORMAT_CONFIGURATION is enabled then
    // this stored address global configuration will be loaded
    // REQUIREMENT: The three separators
    //     - MUST all be different
    //     - MUST not appear in your destinations or failure treatments
    // RECOMMENDATION: The address and failure separators SHOULD be either
    //     - a space ' ', OR
    //     - one of the special characters '"(),:;<>@[\]'
    // which are not allowed in the unquoted local-part of an email address.
    // See [Email address - Wikipedia](https://en.wikipedia.org/wiki/Email_address#Local-part).
    // Quoted local-parts in email addresses are not supported here as it would
    // add complexity and as they are used infrequently not many systems support
    // them in any case.
    //
    FORMAT_ADDRESS_SEPARATOR: ",",
    FORMAT_FAILURE_SEPARATOR: ";",
    FORMAT_LOCAL_PART_SEPARATOR: "+",
    // Source: [HTML Standard](https://html.spec.whatwg.org/multipage/input.html#input.email.attrs.value.multiple)
    FORMAT_VALID_EMAIL_ADDRESS_REGEX: "^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$",

    // If USE_STORED_HEADER_CONFIGURATION is enabled then
    // this stored address global configuration will be loaded
    //
    CUSTOM_HEADER: "X-My-Email-Subaddressing",
    CUSTOM_HEADER_FAIL: "fail",
    CUSTOM_HEADER_PASS: "pass",

    // If USE_STORED_FORWARD_RETRY_GLOBAL_CONFIGURATION is enabled then
    // this stored address global configuration will be loaded
    //
    FORWARD_DESTINATION_NOT_VERIFIED_ERROR_MESSAGE: "destination address not verified",
    FORWARD_RETRYING_MAX_RETRIES: "3",
    FORWARD_RETRYING_TIMEOUT_MILLISECONDS: "1000",

    // Cloudflare KV key-value store
    MAP: new Map(),

    // Returns the user and subaddress parts of the local address 
    addressLocalParts(localPart, formatLocalPartSeparator) {
        // In case localPart does not contain a formatLocalPartSeparator
        // use concat and slice to ensure that a 2 element array is always
        // returned with the 2nd element '' in this case
        return localPart.split(formatLocalPartSeparator, 2).concat('').slice(0, 2);
    },

    // Returns a description of a message 
    messageDetails(message) {
        return `from:${message.from} to:${message.to} size:${message.rawSize}`;
    },

    // Forwards a message with custom headers to a set of destinations,
    // possibly retrying maxRetries times, with retryTimeoutMilliseconds delay
    // between retries 
    async forwardRetrying(message, destinations, customHeaders,
        messageDetails,
        maxRetries, retryTimeoutMilliseconds, unverifiedDestinationErrorMessage) {
        let retryCount = 0;
        // Array indexed by destination indicating whether the processing for a
        // particular destination is complete, ie. the forward succeeded OR
        // the forward failed due to invalid configuration for that destination
        // which means there is no reason to retry that destination
        let destinationProcessed = new Array(destinations.length).fill(false);
        // Count of destinations which were successfully forwarded to
        let successfullyForwardedDestinations = [];
        // Count of desinations where the forward request was invalid
        let invalidDestinationsCount = 0;
        let failingDestinationsCount = 0;
        while (retryCount < maxRetries) {
            failingDestinationsCount = 0;
            const retryDetails = `retry#:(${retryCount + 1}/${maxRetries})`;
            for (let d = 0; d < destinations.length; d++) {
                const destination = destinations.at(d);
                const forwardDetails = `${retryDetails} destination#:(${d + 1}/${destinations.length}) destination:${destination}`;
                try {
                    // Only forward if the processing has not been previously
                    // completed
                    if (!destinationProcessed[d]) {
                        await message.forward(destination, customHeaders);
                        // No error thrown so we successfully forwarded
                        destinationProcessed[d] = true;
                        successfullyForwardedDestinations.push(destination);
                        console.log(`Forward succeeded on ${forwardDetails}`);
                    }
                }
                catch (error) {
                    const errorDetail = `${forwardDetails} with error:'${error.message}' for email ${messageDetails}`;
                    if (error.message === unverifiedDestinationErrorMessage) {
                        console.warn(`Forward failed and will not be retried due to an invalid destination on ${errorDetail}`);
                        destinationProcessed[d] = true;
                        invalidDestinationsCount++;
                    } else {
                        console.error(`Forward failed on ${errorDetail}`);
                        failingDestinationsCount++;
                    }
                }
            }
            // Exit the retry loop if no destinations need retrying
            // or the retry limit has been reached
            if (failingDestinationsCount === 0 || retryCount === maxRetries) {
                break;
            }
            retryCount++;
            // Delay before retrying
            await new Promise(resolve => setTimeout(resolve, retryTimeoutMilliseconds));
        }
        if (failingDestinationsCount > 0) {
            throw new Error(`Aborting forward after reaching limit maxRetries:${maxRetries} with successfulDestinations#:${successfullyForwardedDestinations.length} failingDestinations#:${failingDestinationsCount} invalidDestinations#:${invalidDestinationsCount} totalDestinations#:${destinations.length} for email ${messageDetails}`);
        }
        return successfullyForwardedDestinations;
    },
    isValidEmailAddress(address, validAddressRegex) {
        return validAddressRegex.test(address);
    }
}

// Global helper functions to increase readability
String.prototype.removeWhitespace = function () {
    return this.replace(/\s+/g, '');
};

export default {
    async email(message, environment, context
    ) {
        // Environment-based configuration falls back to `DEFAULTS`.
        const {
            // Loading control configuration
            USE_STORED_USER_CONFIGURATION,
            USE_STORED_ADDRESS_GLOBAL_CONFIGURATION,
            USE_STORED_FORMAT_GLOBAL_CONFIGURATION,
            USE_STORED_FORWARD_RETRY_GLOBAL_CONFIGURATION,
            USE_STORED_HEADER_GLOBAL_CONFIGURATION,

            // Address configuration
            DESTINATION,
            REJECT_TREATMENT,
            SUBADDRESSES,
            USERS,

            // Format configuration
            FORMAT_ADDRESS_SEPARATOR,
            FORMAT_FAILURE_SEPARATOR,
            FORMAT_LOCAL_PART_SEPARATOR,
            FORMAT_VALID_EMAIL_ADDRESS_REGEX,

            // Header configuration
            CUSTOM_HEADER,
            CUSTOM_HEADER_FAIL,
            CUSTOM_HEADER_PASS,

            // Forward retry configuration
            FORWARD_DESTINATION_NOT_VERIFIED_ERROR_MESSAGE: FORWARD_RETRYING_UNVERIFIED_DESTINATION_ERROR_MESSAGE,
            FORWARD_RETRYING_MAX_RETRIES,
            FORWARD_RETRYING_TIMEOUT_MILLISECONDS,

            // KV map
            MAP,

            // Implementation methods
            addressLocalParts,
            messageDetails,
            forwardRetrying,
            isValidEmailAddress
        } = { ...DEFAULTS, ...environment };

        // Static configuration.
        //
        // Separates local part and absolute domain of an email address
        const formatDomainSeparator = '@';
        // Matches if it is a valid custom header, i.e.starts with 'X-'
        const validCustomHeaderRegex = /X-.*/;
        // Matches if starts with a non-alphanumeric
        const startsWithNonAlphanumericRegex = /^[^A-Z0-9]/i;

        // Helper methods
        function booleanFromString(stringBoolean) {
            return ['true', '1']
                .includes(stringBoolean.trim().toLowerCase());
        }
        async function storedConfigurationValue(shouldLoad, key) {
            // MAP.get(key) returns null if key is not stored so '?? undefined'
            // coalesces null to undefined but leaves '' unchanged
            // which is important because '' is used to indicate that
            // the global configured should be used for that destination
            return shouldLoad ? (await MAP.get(key) ?? undefined) : undefined;
        }
        function validatedCustomHeader(customHeader) {
            const customHeaderNoWhitespace = customHeader.removeWhitespace();
            if (validCustomHeaderRegex.test(customHeaderNoWhitespace))
                return customHeaderNoWhitespace;
            else
                throw (`Invalid custom header ${customHeaderNoWhitespace}`);
        }
        function prepend(base, prependIsRequiredRegex, prepend) {
            return prependIsRequiredRegex.test(base)
                ? prepend + base
                : base;
        }
        // Return an object with valid, invalid and duplicate destinations after
        // - removing all whitespace
        // - prepend the user to the destination if it matches shouldPrependUserRegex
        function validatedDestinations(destinations, shouldPrependUserRegex, user) {
            return destinations.reduce((validatedDestinations, destination) => {
                destination = prepend(destination.removeWhitespace(),
                    shouldPrependUserRegex, user);
                if (isValidEmailAddress(destination, formatValidEmailAddressRegex)) {
                    if (!validatedDestinations.valid.includes(destination)) {
                        validatedDestinations.valid.push(destination);
                    } else {
                        validatedDestinations.duplicate.push(destination);
                    }
                } else {
                    if (destination !== '') {
                        validatedDestinations.invalid.push(destination);
                    }
                }
                return validatedDestinations;
            }, { valid: [], invalid: [], duplicate: [] });
        }
        function warnAboutBadDestinations(validatedDestinations, destinationType) {
            [
                { description: 'invalidly formatted', destinations: validatedDestinations.invalid },
                { description: 'duplicate', destinations: validatedDestinations.duplicate },
            ].map(issue => {
                if (issue.destinations.length > 0)
                    console.warn(
                        `Ignoring ${issue.description} ${destinationType} destinations: '${issue.destinations.join(formatAddressSeparator)}'`);
            });
        }
        // Controls to load different stored configuration
        const useStoredUserConfiguration =
            booleanFromString(USE_STORED_USER_CONFIGURATION);
        const useStoredAddressGlobalConfiguration =
            booleanFromString(USE_STORED_ADDRESS_GLOBAL_CONFIGURATION);
        const useStoredFormatGlobalConfiguration =
            booleanFromString(USE_STORED_FORMAT_GLOBAL_CONFIGURATION);
        const useStoredForwardRetryingConfiguration =
            booleanFromString(USE_STORED_FORWARD_RETRY_GLOBAL_CONFIGURATION);
        const useStoredHeaderGlobalConfiguration =
            booleanFromString(USE_STORED_HEADER_GLOBAL_CONFIGURATION);

        // If useStoredAddressGlobalConfiguration
        // load stored address global configuration
        // which overrides environment-based configuration (and defaults)
        const globalDestination = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@DESTINATION')
            ?? DESTINATION
        ).removeWhitespace();
        const globalFailureTreatment = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@REJECT_TREATMENT')
            ?? REJECT_TREATMENT
        ).trim();
        const globalSubaddresses = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@SUBADDRESSES')
            ?? SUBADDRESSES
        ).removeWhitespace();
        const globalUsers = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@USERS')
            ?? USERS
        ).removeWhitespace();
        // If useStoredFormatGlobalConfiguration
        // load stored format global configuration
        // which overrides environment-based configuration (and defaults)
        const formatAddressSeparator = (
            await storedConfigurationValue(useStoredFormatGlobalConfiguration,
                '@FORMAT_ADDRESS_SEPARATOR')
            ?? FORMAT_ADDRESS_SEPARATOR
        ).removeWhitespace();
        const formatFailureSeparator = (
            await storedConfigurationValue(useStoredFormatGlobalConfiguration,
                '@FORMAT_FAILURE_SEPARATOR')
            ?? FORMAT_FAILURE_SEPARATOR
        ).removeWhitespace();
        const formatLocalPartSeparator = (
            await storedConfigurationValue(useStoredFormatGlobalConfiguration,
                '@FORMAT_LOCAL_PART_SEPARATOR')
            ?? FORMAT_LOCAL_PART_SEPARATOR
        ).removeWhitespace();
        const formatValidEmailAddressRegex =
            new RegExp(
                await (storedConfigurationValue(useStoredFormatGlobalConfiguration,
                    '@FORMAT_VALID_EMAIL_ADDRESS_REGEX'))
                ?? FORMAT_VALID_EMAIL_ADDRESS_REGEX);
        // If useStoredHeaderGlobalConfiguration
        // load stored header global configuration
        // which overrides environment-based configuration (and defaults)
        const customHeader =
            validatedCustomHeader(
                await storedConfigurationValue(useStoredHeaderGlobalConfiguration,
                    '@CUSTOM_HEADER')
                ?? CUSTOM_HEADER);
        const customHeaderFail = (
            await storedConfigurationValue(useStoredHeaderGlobalConfiguration,
                '@CUSTOM_HEADER_FAIL')
            ?? CUSTOM_HEADER_FAIL
        ).trim();
        const customHeaderPass = (
            await storedConfigurationValue(useStoredHeaderGlobalConfiguration,
                '@CUSTOM_HEADER_PASS')
            ?? CUSTOM_HEADER_PASS
        ).trim();
        // If useStoredForwardRetryingConfiguration
        // load stored forward retry global configuration
        // which overrides environment-based configuration (and defaults)
        const forwardDestinationNotVerifiedErrorMessage =
            await storedConfigurationValue(useStoredForwardRetryingConfiguration, '@FORWARD_RETRYING_UNVERIFIED_DESTINATION_ERROR_MESSAGE')
            ?? FORWARD_RETRYING_UNVERIFIED_DESTINATION_ERROR_MESSAGE;
        const forwardRetryingMaxRetries =
            Number(
                await storedConfigurationValue(useStoredForwardRetryingConfiguration, '@FORWARD_RETRYING_MAX_RETRIES')
                ?? FORWARD_RETRYING_MAX_RETRIES);
        const forwardRetryingTimeoutMilliseconds =
            Number(
                await storedConfigurationValue(useStoredForwardRetryingConfiguration, '@FORWARD_RETRYING_TIMEOUT_MILLISECONDS')
                ?? FORWARD_RETRYING_TIMEOUT_MILLISECONDS);

        // Matches if starts with formatDomainSeparator or formatLocalPartSeparator
        const startsWithLocalPartOrDomainSeparatorRegex =
            new RegExp(`^(${escape(formatDomainSeparator)}|${escape(formatLocalPartSeparator)})`);

        // Given from RFC 5233 that the email address has the syntax:
        //     `${LocalPart}${formatDomainSeparator}${AbsoluteDomain}`
        // and LocalPart has the syntax
        //     `${user}${formatLocalPartSeparator}${subaddress}`
        // obtain the LocalPart first by splitting the message's 'to'
        // address using separator formatDomainSeparator and then use the addressLocalParts
        // implementation to split this again into user and subaddress using
        // separator formatLocalPartSeparator
        const messageLocalPart = message.to.split(formatDomainSeparator)[0];
        const [messageUser, messageSubaddress] = addressLocalParts(messageLocalPart, formatLocalPartSeparator);
        const theMessageDetails = messageDetails(message);

        // If useStoredUserConfiguration
        // load stored user global configuration
        // which overrides environment-based configuration (and defaults)
        const userDestinationWithFailureTreatment
            = await storedConfigurationValue(useStoredUserConfiguration, messageUser);
        const userSubaddresses =
            (await storedConfigurationValue(useStoredUserConfiguration, `${messageUser}${formatLocalPartSeparator}`))?.removeWhitespace()
            ?? globalSubaddresses;

        // Given userDestinationWithFailureTreatment has the syntax:
        //     `${destination}${formatFailureSeparator}${failureTreatment}`
        // then split userDestinationWithFailureTreatment into destination and failureTreatment
        const userDestination =
            userDestinationWithFailureTreatment?.split(formatFailureSeparator).at(0).removeWhitespace()
            || globalDestination;
        const userFailureTreatment =
            userDestinationWithFailureTreatment?.split(formatFailureSeparator).at(1)?.trim()
            || globalFailureTreatment;

        // Validate the messageUser
        const userIsAllowed =
            userDestinationWithFailureTreatment !== undefined
            || globalUsers === '*'
            || globalUsers.split(formatAddressSeparator).includes(messageUser);
        // Validate messageSubaddress 
        const subaddressIsAllowed =
            messageSubaddress === ''
                ? !/^\+/.test(userSubaddresses)
                : ['*', '+*'].includes(userSubaddresses)
                || userSubaddresses.replace(/^\+/, '').split(formatAddressSeparator).includes(messageSubaddress);

        // Accept forward if the the user and subaddress are valid
        let successfulAcceptDestinations = [];
        if (userIsAllowed && subaddressIsAllowed) {
            const validatedAcceptDestinations =
                validatedDestinations(userDestination.split(formatAddressSeparator), startsWithLocalPartOrDomainSeparatorRegex, messageUser);
            warnAboutBadDestinations(validatedAcceptDestinations, 'accept forward');
            console.info(
                `Accept forwarding to destinations:'${validatedAcceptDestinations.valid.join(formatAddressSeparator)}'`);
            // Forward with custom header set to customHeaderPass
            successfulAcceptDestinations =
                await forwardRetrying(
                    message,
                    validatedAcceptDestinations.valid,
                    new Headers({ [customHeader]: customHeaderPass }),
                    theMessageDetails,
                    forwardRetryingMaxRetries,
                    forwardRetryingTimeoutMilliseconds,
                    forwardDestinationNotVerifiedErrorMessage
                );
        }

        // If no accept forwards succeeded then reject forward
        if (successfulAcceptDestinations.length === 0) {
            const validatedRejectDestinations =
                validatedDestinations(userFailureTreatment.split(formatAddressSeparator), startsWithLocalPartOrDomainSeparatorRegex, messageUser);
            let successfulRejectDestinations = [];
            // Reject forward if there are some valid reject forward destinations
            if (validatedRejectDestinations.valid.length > 0) {
                warnAboutBadDestinations(validatedRejectDestinations, 'reject forward');
                console.info(
                    `Reject forwarding to destinations:'${validatedRejectDestinations.valid.join(formatAddressSeparator)}'`);
                successfulRejectDestinations = await forwardRetrying(
                    message,
                    validatedRejectDestinations.valid,
                    new Headers({ [customHeader]: customHeaderFail }),
                    theMessageDetails,
                    forwardRetryingMaxRetries,
                    forwardRetryingTimeoutMilliseconds,
                    forwardDestinationNotVerifiedErrorMessage
                );
            }

            // If no reject forwards succeeded then direct reject
            if (successfulRejectDestinations.length === 0) {
                const failureReason =
                    prepend(userFailureTreatment, startsWithNonAlphanumericRegex, messageLocalPart);
                console.info(`Direct rejecting with failureReason:'${failureReason}' for email ${theMessageDetails}`);
                message.setReject(failureReason);
            }
        }
    }
}