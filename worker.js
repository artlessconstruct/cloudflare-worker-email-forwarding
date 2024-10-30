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

    // Matches if starts with a non-alphanumeric

    startsWithNonAlphanumericRegExp: /^[^A-Z0-9]/i,

    // Prepends to the base with prepend if the regexp matches
    prepend(base, prependConditions) {
        for (const prependCondition of prependConditions) {
            const shouldPrepend =
                typeof prependCondition.test === 'string'
                && base.startsWith(prependCondition.test)
                || prependCondition.test instanceof RegExp
                && prependCondition.test.test(base);
            if (shouldPrepend)
                return prependCondition.prepend + base;
        }
        return base;
    }
};

class PrimaryDestinationResult {
    constructor(successful, successfulDestination, unverifiedDestinationsCount, unverifiedDestinations, errorMessages, errors) {
        this.successful = successful;
        this.successfulDestination = successfulDestination;
        this.unverifiedDestinationsCount = unverifiedDestinationsCount;
        this.unverifiedDestinations = unverifiedDestinations;
        this.errorMessages = errorMessages;
        this.errors = errors;
    }
};

class OverallFailureError extends Error {
    constructor(errors, message) {
        super(message);
        this.name = 'OverallFailureError';
        this.errors = errors;
    }
};

export const DEFAULTS = {
    ///////////////////////////////////////////////////////////////////////////
    // Overrideable only by environment configuration

    // Control whether different categories of stored configuration will be
    // loaded from the Cloudflare KV-based key-value store
    //
    USE_STORED_ADDRESS_CONFIGURATION: "true",
    USE_STORED_USER_CONFIGURATION: "true",

    CONSOLE_LOG_ENABLED: "false",

    ///////////////////////////////////////////////////////////////////////////
    // Overrideable by stored and environment configuration
    // (in priority order)

    // Address configuration
    // If USE_STORED_ADDRESS_CONFIGURATION is enabled then
    // this stored address configuration will be loaded
    //
    DESTINATION: "",
    REJECT_TREATMENT: ": Invalid recipient",
    SUBADDRESSES: "*",
    USERS: "",

    ///////////////////////////////////////////////////////////////////////////
    // Overrideable only by environment configuration

    // Format configuration
    // REQUIREMENT: The 4 separators
    // - MUST all be different
    // - MUST not be '*' or '@'
    // - MUST not be any character used in a user, subaddress or destination
    //   domain
    // RECOMMENDATION: The primary address, redundant address and reject separators SHOULD
    // - be either 
    //     - a space ' ', OR
    //     - one of the special characters '"(),:;<>[\]'
    // which are not allowed in the unquoted local-part of an email address.
    // See [Email address - Wikipedia](https://en.wikipedia.org/wiki/Email_address#Local-part).
    // Quoted local-parts in email addresses are not supported here as it would
    // add complexity and as they are used infrequently not many systems support
    // them in any case.
    //
    FORMAT_PRIMARY_ADDRESS_SEPARATOR: ",",
    FORMAT_REDUNDANT_ADDRESS_SEPARATOR: ":",
    FORMAT_LOCAL_PART_SEPARATOR: "+",
    FORMAT_REJECT_SEPARATOR: ";",
    FORMAT_VALID_CUSTOM_HEADER_REGEXP: "X-.*",
    // Source: [HTML Standard](https://html.spec.whatwg.org/multipage/input.html#input.email.attrs.value.multiple)
    FORMAT_VALID_EMAIL_ADDRESS_REGEXP: "^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$",

    // Custom header configuration
    //
    CUSTOM_HEADER: "X-My-Email-Forwarding",
    CUSTOM_HEADER_FAIL: "fail",
    CUSTOM_HEADER_PASS: "pass",

    // Error message configuration
    //
    UNVERIFIED_DESTINATION_ERROR_MESSAGE: "destination address not verified",

    // Cloudflare KV key-value store
    MAP: new Map(),

    ////////////////////////////////////////////////////////////////////////////
    // Overrideable implementation methods

    // Returns the user and subaddress parts of the local address
    // in lower case
    addressLocalParts(localPart, formatLocalPartSeparator) {
        // 1. Convert to lower case
        // 2. Split this on first instance of formatLocalPartSeparator only
        // into a 2 element array
        const lowerCaseLocalPart = localPart.toLowerCase();
        const firstLocalPartSeparatorIndex = lowerCaseLocalPart.indexOf(formatLocalPartSeparator);
        return firstLocalPartSeparatorIndex >= 0
            ? [lowerCaseLocalPart.slice(0, firstLocalPartSeparatorIndex),
            lowerCaseLocalPart.slice(firstLocalPartSeparatorIndex + formatLocalPartSeparator.length)]
            : [lowerCaseLocalPart, ''];
    },
    // Returns a description of a message 
    emailImage(message) {
        return {
            messageId: message.headers.get('Message-ID'),
            date: message.headers.get('Date'),
            from: message.from,
            to: message.to,
            size: message.rawSize,
        };
    },
    consoleLog(message, configuration) {
        if (configuration.consoleLogEnabled)
            console.log(message);
    },
    // Forward to a primaryDestination by attempting to forward to
    // each redundantDestination sequentially, stopping when the first forward succeeds. 
    // Exceptions caught for unverified destinations will not trigger any
    // exception to be propagated but may cause a message to be rejected if all
    // other verified destinations fail (or there are none).
    // Treating an unverified destination as a failure and throwing an
    // exception leads to the message sender repeatedly resending the message
    // which serves no purpose as until the destination is verified forwarding
    // will always fail.
    // Returns a PrimaryDestinationResult summarising all attempts.
    async forwardPrimaryDestination(
        message, primaryDestination, primaryDestinationId, customHeaders, emailImage, configuration) {
        let unverifiedDestinationsCount = 0;
        let unverifiedDestinations = [];
        let errorMessages = [];
        let errors = [];
        let s = 0;
        let successful = false;
        for (const redundantDestination of primaryDestination) {
            const redundantDestinationId = [primaryDestinationId, s + 1];
            const log = (successful, errorMessage) => {
                configuration.consoleLog({
                    email: emailImage,
                    action: 'RedundantForward',
                    redundantDestinationId: redundantDestinationId,
                    redundantDestination: redundantDestination,
                    successful: successful,
                    errorMessage: errorMessage,
                }, configuration);
            };
            try {
                await message.forward(redundantDestination, customHeaders);
                successful = true;
                log(successful, null);
                break;
            }
            catch (error) {
                if (error.message === configuration.UNVERIFIED_DESTINATION_ERROR_MESSAGE) {
                    unverifiedDestinationsCount += 1;
                    unverifiedDestinations.push(redundantDestinationId);
                } else {
                    errors.push(error);
                    errorMessages.push({
                        redundantDestinationId: redundantDestinationId,
                        errorMessage: error.message
                    });
                }
                log(successful, error.message);
            }
            s++;
        }
        const primaryDestinationResult = new PrimaryDestinationResult(
            successful || errors.length === 0,
            successful ? primaryDestination.at(s) : null,
            unverifiedDestinationsCount,
            unverifiedDestinations,
            errorMessages,
            errors
        );
        return primaryDestinationResult;
    },
    // Concurrently forwards a message to zero or more destinations and returns the list
    // of destinations that were successfully forwarded to.
    // Throws if there is failure to forward to a verified destination but
    // only after all destinations have been attempted.
    // If the forwarding request is to only one destination then the same
    // exception caught from message.forward will be rethrown,
    // otherwise a new aggregate exception will be thrown including the error
    // messages and errors of all failing verified destinations.
    async forward(message, actionType, primaryDestinations, customHeaders, emailImage, configuration) {
        const primaryDestinationResults = await Promise.all(
            primaryDestinations.map((primaryDestination, primaryDestinationIndex) =>
                configuration.forwardPrimaryDestination(
                    message, primaryDestination,
                    primaryDestinationIndex + 1,
                    customHeaders, emailImage, configuration)
            ));
        const successful = primaryDestinationResults.map(
            result => result.successful).every(Boolean);
        const successfulDestinations = primaryDestinationResults
            .map(result => result.successfulDestination).filter(Boolean);
        const errorMessages = primaryDestinationResults
            .flatMap(result => result.errorMessages);
        const errors = primaryDestinationResults
            .flatMap(result => result.errors);
        console.info({
            email: emailImage,
            action: actionType,
            primaryDestinations: primaryDestinations,
            successful: successful,
            successfulDestinations: successfulDestinations,
            errorMessages: errorMessages
        });
        if (!successful) {
            if (primaryDestinations.length === 1 && primaryDestinations[0].length === 1)
                throw errors.at(0);
            const errorMessage =
                `${FIXED.overallFailureErrorMessagePrefix}: ${JSON.stringify(errorMessages)}`;
            throw new OverallFailureError(errors, errorMessage);
        }
        return successfulDestinations;
    },
    isValidEmailAddress(address, validAddressRegExp) {
        return validAddressRegExp.test(address);
    }
};

export default {
    async email(message, environment, context) {
        // Environment-based configuration which overrides `DEFAULTS`
        //
        const {
            USE_STORED_ADDRESS_CONFIGURATION,
            USE_STORED_USER_CONFIGURATION,
            CONSOLE_LOG_ENABLED,

            DESTINATION,
            REJECT_TREATMENT,
            SUBADDRESSES,
            USERS,

            UNVERIFIED_DESTINATION_ERROR_MESSAGE,

            FORMAT_PRIMARY_ADDRESS_SEPARATOR,
            FORMAT_REDUNDANT_ADDRESS_SEPARATOR,
            FORMAT_LOCAL_PART_SEPARATOR,
            FORMAT_REJECT_SEPARATOR,
            FORMAT_VALID_CUSTOM_HEADER_REGEXP,
            FORMAT_VALID_EMAIL_ADDRESS_REGEXP,

            CUSTOM_HEADER,
            CUSTOM_HEADER_FAIL,
            CUSTOM_HEADER_PASS,

            MAP,

            addressLocalParts,
            emailImage,
            consoleLog,
            forwardPrimaryDestination,
            forward,
            isValidEmailAddress
        } = { ...DEFAULTS, ...environment };

        // Helper methods independent of configuration
        //

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

        // Load and validate stored and environment configuration
        //

        const useStoredAddressGlobalConfiguration =
            booleanFromString(USE_STORED_ADDRESS_CONFIGURATION);
        const useStoredUserConfiguration =
            booleanFromString(USE_STORED_USER_CONFIGURATION);

        const consoleLogEnabled =
            booleanFromString(CONSOLE_LOG_ENABLED);

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
        ).removeWhitespace().toLowerCase();
        const globalUsers = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@USERS')
            ?? USERS
        ).removeWhitespace().toLowerCase();

        const formatValidEmailAddressRegExp =
            new RegExp(FORMAT_VALID_EMAIL_ADDRESS_REGEXP.trim());
        const formatValidCustomHeaderRegExp =
            new RegExp(FORMAT_VALID_CUSTOM_HEADER_REGEXP.trim());

        const customHeader =
            validateCustomHeader(CUSTOM_HEADER);
        const customHeaderFail =
            CUSTOM_HEADER_FAIL.trim();
        const customHeaderPass =
            CUSTOM_HEADER_PASS.trim();

        const CONFIGURATION = {
            UNVERIFIED_DESTINATION_ERROR_MESSAGE: UNVERIFIED_DESTINATION_ERROR_MESSAGE,
            consoleLogEnabled: consoleLogEnabled,
            consoleLog: consoleLog,
            forwardPrimaryDestination: forwardPrimaryDestination
        };

        // Derived constants
        //

        const startsWithLocalPartSeparatorRegExp =
            new RegExp(`^${escape(FORMAT_LOCAL_PART_SEPARATOR)}`);
        const startsWithLocalPartOrDomainSeparatorRegExp =
            new RegExp(`^(${escape('@')}|${escape(FORMAT_LOCAL_PART_SEPARATOR)})`);

        // Helper methods dependent on configuration
        //

        function validateCustomHeader(customHeader) {
            const customHeaderNoWhitespace = customHeader.removeWhitespace();
            if (formatValidCustomHeaderRegExp.test(customHeaderNoWhitespace))
                return customHeaderNoWhitespace;
            else
                throw (`Invalid custom header ${customHeaderNoWhitespace}`);
        }
        // Return an object with valid, invalid redundant addresses for a primary
        // destination after
        // - removing all whitespace
        // - prepend the message's user to the destination if it begins with
        //   either FORMAT_LOCAL_PART_SEPARATOR or '@'
        function validatePrimaryDestination(primaryDestinationText) {
            return primaryDestinationText.split(FORMAT_REDUNDANT_ADDRESS_SEPARATOR).reduce(
                (newPrimaryDestination, destination) => {
                    destination = FIXED.prepend(destination.removeWhitespace(),
                        [{ test: FORMAT_LOCAL_PART_SEPARATOR, prepend: messageUser },
                        { test: '@', prepend: messageUser }]
                    );
                    if (isValidEmailAddress(destination, formatValidEmailAddressRegExp)) {
                        newPrimaryDestination.valid.push(destination);
                    } else if (destination !== '') {
                        newPrimaryDestination.invalid.push(destination);
                    }
                    return newPrimaryDestination;
                },
                { valid: [], invalid: [] }
            );
        }
        function validateDestination(destinationText) {
            return destinationText.split(FORMAT_PRIMARY_ADDRESS_SEPARATOR).reduce(
                (newPrimaryDestinations, primaryDestinationText) => {
                    const nonDedupedprimaryDestination =
                        validatePrimaryDestination(primaryDestinationText);
                    const dedupedPrimaryDestination = nonDedupedprimaryDestination.valid.reduce(
                        (newPrimaryDestination, destination) => {
                            if (!newPrimaryDestinations.validOrdinary.includes(destination)) {
                                newPrimaryDestinations.validOrdinary.push(destination);
                                newPrimaryDestination.push(destination);
                            } else {
                                newPrimaryDestinations.duplicateOrdinary.push(destination);
                            };
                            return newPrimaryDestination;
                        }, []);
                    if (dedupedPrimaryDestination.length > 0)
                        newPrimaryDestinations.validPrimary.push(dedupedPrimaryDestination);
                    newPrimaryDestinations.invalidOrdinary.concat(nonDedupedprimaryDestination.invalid);
                    return newPrimaryDestinations;
                },
                { validPrimary: [], validOrdinary: [], invalidOrdinary: [], duplicateOrdinary: [] }
            );
        }
        function warnAboutBadDestinations(messageUser, validatedPrimaryDestinations, destinationType) {
            [
                {
                    description: 'invalidly formatted',
                    destinations: validatedPrimaryDestinations.invalidOrdinary
                },
                {
                    description: 'duplicate',
                    destinations: validatedPrimaryDestinations.duplicateOrdinary
                },
            ].map(issue => {
                if (issue.destinations.length > 0)
                    console.warn({
                        messageUser: messageUser,
                        issue: issue.description,
                        destinationType: destinationType,
                        destinations: issue.destinations,
                    });
            });
        }
        function primaryDestinationsImage(validatedPrimaryDestinations) {
            return validatedPrimaryDestinations.map(
                primaryDestination =>
                    primaryDestination.join(FORMAT_REDUNDANT_ADDRESS_SEPARATOR)
            ).join(FORMAT_PRIMARY_ADDRESS_SEPARATOR);
        }

        // Given from RFC 5233 that the email address has the syntax:
        //     `${LocalPart}@${AbsoluteDomain}`
        // and LocalPart has the syntax
        //     `${user}${FORMAT_LOCAL_PART_SEPARATOR}${subaddress}`
        // extract the user and subaddrress
        //
        const messageLocalPart = message.to.split('@')[0];
        const [messageUser, messageSubaddress] = addressLocalParts(messageLocalPart, FORMAT_LOCAL_PART_SEPARATOR);

        // For logging
        const theEmailImage = emailImage(message);

        // If useStoredUserConfiguration
        // load stored user configuration
        // which overrides environment-based configuration (and defaults)
        const userDestinationWithRejectTreatment
            = await storedConfigurationValue(useStoredUserConfiguration, messageUser);
        // An empty string is valid (no subaddresses allowed) and the ??
        // operator will prevent this value from stored configuration from being
        // overriden as '' ?? x evaluates to ''
        const userSubaddresses =
            (await storedConfigurationValue(useStoredUserConfiguration, `${messageUser}${FORMAT_LOCAL_PART_SEPARATOR}`))?.removeWhitespace().toLowerCase()
            ?? globalSubaddresses;
        const userRequiresSubaddress = userSubaddresses.startsWith(FORMAT_LOCAL_PART_SEPARATOR);
        const userConcreteSubaddresses = userSubaddresses.replace(startsWithLocalPartSeparatorRegExp, '');

        // Given userDestinationWithRejectTreatment has the syntax:
        //     `${destination}${FORMAT_REJECT_SEPARATOR}${rejectTreatment}`
        // extract destination and rejectTreatment.
        // Empty strings for these constants indicate that the global
        // configuration should override the user configuration
        // and the || operator allows such an override as '' is falsy
        // and so '' || x evaluates to x 
        //
        const userDestination =
            userDestinationWithRejectTreatment?.split(FORMAT_REJECT_SEPARATOR).at(0).removeWhitespace()
            || globalDestination;
        const userRejectTreatment =
            userDestinationWithRejectTreatment?.split(FORMAT_REJECT_SEPARATOR).at(1)?.trim()
            || globalRejectTreatment;

        // The message user is allowed if:
        // - the specific message user was found in the user store, or
        // - the global user configuration is a wildcard, or
        // - the message user is in the set of allowed global users
        const messageUserIsAllowed =
            userDestinationWithRejectTreatment !== undefined
            || globalUsers === '*'
            || globalUsers.split(FORMAT_PRIMARY_ADDRESS_SEPARATOR).includes(messageUser);
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
                    .split(FORMAT_PRIMARY_ADDRESS_SEPARATOR).includes(messageSubaddress);

        // Accept forward if the the message user and subaddress are allowed
        let acceptForwardWasSuccessful = false;
        if (messageUserIsAllowed && messageSubaddressIsAllowed) {
            const acceptPrimaryDestinations =
                validateDestination(userDestination);
            warnAboutBadDestinations(messageUser, acceptPrimaryDestinations, 'AcceptForward');
            consoleLog({
                email: theEmailImage,
                action: 'AcceptForwarding',
                destinations: acceptPrimaryDestinations.validPrimary,
            }, CONFIGURATION);
            // Forward with custom header set to customHeaderPass
            acceptForwardWasSuccessful = (
                await forward(
                    message,
                    'AcceptForwarding',
                    acceptPrimaryDestinations.validPrimary,
                    new Headers({ [customHeader]: customHeaderPass }),
                    theEmailImage,
                    CONFIGURATION
                )).length > 0;
        }

        // If no accept forwards succeeded then reject forward
        if (!acceptForwardWasSuccessful) {
            const rejectPrimaryDestinations =
                validateDestination(userRejectTreatment);
            let rejectForwardWasSuccessful = false;
            // Reject forward if there are some valid reject forward destinations
            if (rejectPrimaryDestinations.validPrimary.length > 0) {
                warnAboutBadDestinations(messageUser, rejectPrimaryDestinations, 'RejectForward');
                rejectForwardWasSuccessful =
                    (await forward(
                        message,
                        'RejectForwarding',
                        rejectPrimaryDestinations.validPrimary,
                        new Headers({ [customHeader]: customHeaderFail }),
                        theEmailImage,
                        CONFIGURATION
                    )).length > 0;
            }

            // If no reject forwards succeeded or were attempted then direct reject
            if (!rejectForwardWasSuccessful) {
                const userRejectReason =
                    !userRejectTreatment.includes('@') && userRejectTreatment
                    || !globalRejectTreatment.includes('@') && globalRejectTreatment
                    || !REJECT_TREATMENT.includes('@') && REJECT_TREATMENT.trim()
                    || DEFAULTS.REJECT_TREATMENT.trim();
                // Prepend the message's local part if the reject reason begin's
                // with a non-alphanumeric
                const fullRejectReason = FIXED.prepend(
                    userRejectReason,
                    [{ test: FIXED.startsWithNonAlphanumericRegExp, prepend: messageLocalPart }]
                );
                message.setReject(fullRejectReason);
                console.info({
                    email: theEmailImage,
                    action: 'DirectRejecting',
                    rejectReason: fullRejectReason,
                });
            }
        }
    }
}