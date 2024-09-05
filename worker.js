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

// Global helper functions to increase readability
//

String.prototype.removeWhitespace = function () {
    return this.replace(/\s+/g, '');
};

// Fixed configuration for helper functions and for testing

export const FIXED = {
    overallFailureErrorMessagePrefix: 'Forwarding overall failure',

    // Matches if it is a valid custom header, i.e.starts with 'X-'
    validCustomHeaderRegExp: /X-.*/,

    // Matches if starts with a non-alphanumeric

    startsWithNonAlphanumericRegExp: /^[^A-Z0-9]/i,

    // Prepends to the base with prepend if the regexp matches
    prepend(base, prependIsRequiredRegExp, prepend) {
        return prependIsRequiredRegExp.test(base)
            ? prepend + base
            : base;
    }
};

export const DEFAULTS = {
    // Control whether different categories of stored configuration will be
    // loaded from the Cloudflare KV-based key-value store

    // For loading of stored BASIC configuration:
    //
    USE_STORED_ADDRESS_CONFIGURATION: "true",
    USE_STORED_USER_CONFIGURATION: "true",

    // For loading of stored ADVANCED configuration:
    //
    USE_STORED_ERROR_MESSAGE_CONFIGURATION: "false",
    USE_STORED_FORMAT_CONFIGURATION: "false",
    USE_STORED_HEADER_CONFIGURATION: "false",

    // BASIC configuration

    // If USE_STORED_ADDRESS_CONFIGURATION is enabled then
    // this stored address configuration will be loaded
    //
    DESTINATION: "",
    REJECT_TREATMENT: ": Invalid recipient",
    SUBADDRESSES: "*",
    USERS: "",

    // ADVANCED configuration

    // If USE_STORED_FORMAT_CONFIGURATION is enabled then
    // this stored format configuration will be loaded
    // REQUIREMENT: The three separators
    // - MUST all be different
    // - MUST not be '*' or '@'
    // - MUST not be any character used in a user, subaddress or destination
    //   domain
    // RECOMMENDATION: The address and failure separators SHOULD
    // - be either 
    //     - a space ' ', OR
    //     - one of the special characters '"(),:;<>[\]'
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
    FORMAT_VALID_EMAIL_ADDRESS_REGEXP: "^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$",

    // If USE_STORED_HEADER_CONFIGURATION is enabled then
    // this stored custom header configuration will be loaded
    //
    CUSTOM_HEADER: "X-My-Email-Forwarding",
    CUSTOM_HEADER_FAIL: "fail",
    CUSTOM_HEADER_PASS: "pass",

    // If USE_STORED_ERROR_MESSAGE_CONFIGURATION is enabled then
    // this stored error message configuration will be loaded
    //
    UNVERIFIED_DESTINATION_ERROR_MESSAGE: "destination address not verified",

    // Cloudflare KV key-value store
    MAP: new Map(),

    // Helper constants and methods
    //

    // Overrideable implementation methods
    //

    // Returns the user and subaddress parts of the local address 
    addressLocalParts(localPart, formatLocalPartSeparator) {
        // In case localPart does not contain a formatLocalPartSeparator
        // use concat and slice to ensure that a 2 element array is always
        // returned with the 2nd element '' in this case
        return localPart.split(formatLocalPartSeparator, 2).concat('').slice(0, 2);
    },

    // Returns a description of a message 
    messageDetails(message) {
        return `{from:${message.from}, to:${message.to}, size:${message.rawSize}}`;
    },

    // Forwards a message to zero or more destinations and returns the list
    // of destinations that were successfully forwarded to.
    // Throws if there is failure to forward to a verified destination but
    // only after all destinations have been attempted.
    // Exceptions caught for unverified destinations will not trigger any
    // exception to be propagated but may cause a message to be rejected if all
    // other verified destinations fail (or there are none).
    // Treating an unverified destination as a failure and throwing an
    // exception leads to the message sender repeatedly resending the message
    // which serves no purpose as until the destination is verified forwarding
    // will always fail.
    // If the forwarding request is to only one destination then the same
    // exception caught from message.forward (EmailMessage) will be rethrown,
    // otherwise a new overall exception will be thrown including the error
    // messages of all failing verified destinations.
    async forward(message, destinations, customHeaders, messageDetails, configuration) {
        let successfulDestinations = [];
        let failedDestinationsCount = 0;
        let unverifiedDestinationsCount = 0;
        let unverifiedDestinations = '';
        let errorMessages = '';
        for (let d = 0; d < destinations.length; d++) {
            const destination = destinations.at(d);
            const forwardDetails =
                `destination#:[${d + 1}]/${destinations.length} destination:${destination}`;
            try {
                await message.forward(destination, customHeaders);
                successfulDestinations.push(destination);
                console.log(`Forwarding success on ${forwardDetails}`);
            }
            catch (error) {
                const errorDetail = `${forwardDetails} email:${messageDetails} error:'${error.message}'`;
                if (error.message === configuration.UNVERIFIED_DESTINATION_ERROR_MESSAGE) {
                    unverifiedDestinationsCount++;
                    unverifiedDestinations += `[${d + 1}]`;
                    console.warn(`Forwarding destination unverified on ${errorDetail}`);
                } else {
                    // If there is only one destination then just rethrow
                    if (destinations.length === 1) {
                        throw error;
                    }
                    failedDestinationsCount++;
                    errorMessages += `[${d + 1}]:` + error.message;
                    console.error(`Forwarding failure on ${errorDetail}`);
                }
            }
        }
        if (failedDestinationsCount > 0) {
            const errorDetail =
                `${FIXED.overallFailureErrorMessagePrefix} with totalDestinations#:${destinations.length} successfulDestinations#:${successfulDestinations.length} unverifiedDestinations#:${unverifiedDestinationsCount} failedDestinations#:${failedDestinationsCount} email:${messageDetails} unverifiedDestinations:${unverifiedDestinations} errors:'${errorMessages}'`;
            throw new Error(errorDetail);
        }
        return successfulDestinations;
    },
    isValidEmailAddress(address, validAddressRegExp) {
        return validAddressRegExp.test(address);
    }
};

export default {
    async email(message, environment, context) {
        // Environment-based configuration falls back to `DEFAULTS`.
        const {
            // Loading control for basic configuration
            USE_STORED_ADDRESS_CONFIGURATION,
            USE_STORED_USER_CONFIGURATION,

            // Loading control for advanced configuration
            USE_STORED_ERROR_MESSAGE_CONFIGURATION,
            USE_STORED_FORMAT_CONFIGURATION,
            USE_STORED_HEADER_CONFIGURATION,

            // Address configuration
            DESTINATION,
            REJECT_TREATMENT,
            SUBADDRESSES,
            USERS,

            // Error message configuration
            UNVERIFIED_DESTINATION_ERROR_MESSAGE,

            // Format configuration
            FORMAT_ADDRESS_SEPARATOR,
            FORMAT_FAILURE_SEPARATOR,
            FORMAT_LOCAL_PART_SEPARATOR,
            FORMAT_VALID_EMAIL_ADDRESS_REGEXP,

            // Header configuration
            CUSTOM_HEADER,
            CUSTOM_HEADER_FAIL,
            CUSTOM_HEADER_PASS,

            // KV map
            MAP,

            // Implementation methods
            addressLocalParts,
            messageDetails,
            forward,
            isValidEmailAddress
        } = { ...DEFAULTS, ...environment };

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
            if (FIXED.validCustomHeaderRegExp.test(customHeaderNoWhitespace))
                return customHeaderNoWhitespace;
            else
                throw (`Invalid custom header ${customHeaderNoWhitespace}`);
        }
        // Return an object with valid, invalid and duplicate destinations after
        // - removing all whitespace
        // - prepend the user to the destination if it matches regexp
        function validatedDestinations(destinations, shouldPrependUserRegExp, user) {
            return destinations.reduce((validatedDestinations, destination) => {
                destination = FIXED.prepend(destination.removeWhitespace(),
                    shouldPrependUserRegExp, user);
                if (isValidEmailAddress(destination, formatValidEmailAddressRegExp)) {
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
        const useStoredAddressGlobalConfiguration =
            booleanFromString(USE_STORED_ADDRESS_CONFIGURATION);
        const useStoredUserConfiguration =
            booleanFromString(USE_STORED_USER_CONFIGURATION);
        const useStoredErrorMessageConfiguration =
            booleanFromString(USE_STORED_ERROR_MESSAGE_CONFIGURATION);
        const useStoredFormatGlobalConfiguration =
            booleanFromString(USE_STORED_FORMAT_CONFIGURATION);
        const useStoredHeaderGlobalConfiguration =
            booleanFromString(USE_STORED_HEADER_CONFIGURATION);

        // If useStoredAddressGlobalConfiguration
        // load stored address configuration
        // which overrides environment-based configuration (and defaults)
        const globalDestination = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@DESTINATION')
            ?? DESTINATION
        ).removeWhitespace();
        const globalRejectTreatment = (
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
        // If useStoredErrorMessageConfiguration
        // load stored error message configuration
        // which overrides environment-based configuration (and defaults)
        const unverifiedDestinationErrorMessage =
            await storedConfigurationValue(useStoredErrorMessageConfiguration, '@UNVERIFIED_DESTINATION_ERROR_MESSAGE')
            ?? UNVERIFIED_DESTINATION_ERROR_MESSAGE;
        // If useStoredFormatGlobalConfiguration
        // load stored format configuration
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
        const formatValidEmailAddressRegExp =
            new RegExp(
                await (storedConfigurationValue(useStoredFormatGlobalConfiguration,
                    '@FORMAT_VALID_EMAIL_ADDRESS_REGEXP'))
                ?? FORMAT_VALID_EMAIL_ADDRESS_REGEXP);
        // If useStoredHeaderGlobalConfiguration
        // load stored header configuration
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

        // Derived configuration
        const startsWithLocalPartSeparatorRegExp =
            new RegExp(`^${escape(formatLocalPartSeparator)}`);
        const startsWithLocalPartOrDomainSeparatorRegExp =
            new RegExp(`^(${escape('@')}|${escape(formatLocalPartSeparator)})`);

        // Given from RFC 5233 that the email address has the syntax:
        //     `${LocalPart}@${AbsoluteDomain}`
        // and LocalPart has the syntax
        //     `${user}${formatLocalPartSeparator}${subaddress}`
        // obtain the LocalPart first by splitting the message's 'to'
        // address using separator '@' and then use the addressLocalParts
        // implementation to split this again into user and subaddress using
        // separator formatLocalPartSeparator
        const messageLocalPart = message.to.split('@')[0];
        const [messageUser, messageSubaddress] = addressLocalParts(messageLocalPart, formatLocalPartSeparator);
        const theMessageDetails = messageDetails(message);

        // If useStoredUserConfiguration
        // load stored user configuration
        // which overrides environment-based configuration (and defaults)
        const userDestinationWithRejectTreatment
            = await storedConfigurationValue(useStoredUserConfiguration, messageUser);
        const userSubaddresses =
            (await storedConfigurationValue(useStoredUserConfiguration, `${messageUser}${formatLocalPartSeparator}`))?.removeWhitespace()
            ?? globalSubaddresses;
        const userRequiresSubaddress = userSubaddresses.startsWith(formatLocalPartSeparator);
        const userConcreteSubaddresses = userSubaddresses.replace(startsWithLocalPartSeparatorRegExp, '');

        // Given userDestinationWithRejectTreatment has the syntax:
        //     `${destination}${formatFailureSeparator}${rejectTreatment}`
        // then split userDestinationWithRejectTreatment into destination and rejectTreatment.
        // Empty strings indicate that the global configuration should be used
        // so the '||' operator is used to achieve this.
        const userDestination =
            userDestinationWithRejectTreatment?.split(formatFailureSeparator).at(0).removeWhitespace()
            || globalDestination;
        const userRejectTreatment =
            userDestinationWithRejectTreatment?.split(formatFailureSeparator).at(1)?.trim()
            || globalRejectTreatment;

        // The message user is allowed if:
        // - the specific message user was found in the user store, or
        // - the global user configuration is a wildcard, or
        // - the message user is in the set of allowed global users
        const messageUserIsAllowed =
            userDestinationWithRejectTreatment !== undefined
            || globalUsers === '*'
            || globalUsers.split(formatAddressSeparator).includes(messageUser);
        // The subaddress is allowed if:
        // - the message user either
        //     - has no subaddress and users do not require one, or
        //     - has a subaddress and the subaddress configuration is either
        //       a wildcard or the user in the set of allowed subaddresses 
        const messageSubaddressIsAllowed =
            messageSubaddress === ''
                ? !userRequiresSubaddress
                : userConcreteSubaddresses === '*'
                || userConcreteSubaddresses
                    .split(formatAddressSeparator).includes(messageSubaddress);

        // Accept forward if the the message user and subaddress are allowed
        let acceptForwardWasSuccessful = false;
        if (messageUserIsAllowed && messageSubaddressIsAllowed) {
            const validatedAcceptDestinations =
                validatedDestinations(userDestination.split(formatAddressSeparator), startsWithLocalPartOrDomainSeparatorRegExp, messageUser);
            warnAboutBadDestinations(validatedAcceptDestinations, 'accept forward');
            console.info(
                `Accept forwarding to destinations:'${validatedAcceptDestinations.valid.join(formatAddressSeparator)}'`);
            // Forward with custom header set to customHeaderPass
            acceptForwardWasSuccessful = (
                await forward(
                    message,
                    validatedAcceptDestinations.valid,
                    new Headers({ [customHeader]: customHeaderPass }),
                    theMessageDetails,
                    { UNVERIFIED_DESTINATION_ERROR_MESSAGE: unverifiedDestinationErrorMessage }
                )).length > 0;
        }

        // If no accept forwards succeeded then reject forward
        if (!acceptForwardWasSuccessful) {
            const validatedRejectDestinations =
                validatedDestinations(userRejectTreatment.split(formatAddressSeparator), startsWithLocalPartOrDomainSeparatorRegExp, messageUser);
            let rejectForwardWasSuccessful = false;
            // Reject forward if there are some valid reject forward destinations
            if (validatedRejectDestinations.valid.length > 0) {
                warnAboutBadDestinations(validatedRejectDestinations, 'reject forward');
                console.info(
                    `Reject forwarding to destinations:'${validatedRejectDestinations.valid.join(formatAddressSeparator)}'`);
                rejectForwardWasSuccessful =
                    (await forward(
                        message,
                        validatedRejectDestinations.valid,
                        new Headers({ [customHeader]: customHeaderFail }),
                        theMessageDetails,
                        { UNVERIFIED_DESTINATION_ERROR_MESSAGE: unverifiedDestinationErrorMessage }
                    )).length > 0;
            }

            // If no reject forwards succeeded or were attempted then direct reject
            if (!rejectForwardWasSuccessful) {
                const userRejectReason =
                    !userRejectTreatment.includes('@') && userRejectTreatment
                    || !globalRejectTreatment.includes('@') && globalRejectTreatment
                    || !REJECT_TREATMENT.includes('@') && REJECT_TREATMENT.trim()
                    || DEFAULTS.REJECT_TREATMENT.trim();
                const expandedRejectReason = FIXED.prepend(
                    userRejectReason, FIXED.startsWithNonAlphanumericRegExp, messageLocalPart);
                console.info(`Direct rejecting with failureReason:'${expandedRejectReason}'`);
                message.setReject(expandedRejectReason);
            }
        }
    }
}