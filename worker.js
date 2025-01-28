/**
 * A Cloudflare email worker providing configurable email forwarding with email
 * subaddressing (a.k.a. subaddress extension, tagged addressing, plus
 * addressing, etc.) support, including to multiple destinations simultaneously,
 * where each such destination is a redundant list of simple addresses attempted
 * sequentially until one succeeds.
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

// Fixed configuration for helper functions and for testing

export const FIXED = {

    // Implementation errors caught
    RECOVERABLE_FORWARD_IMPLEMENTATION_ERROR_MESSAGE_1: 'could not send email: Unknown error: transient error',

    // Interface error messages thrown
    RECOVERABLE_FORWARD_INTERFACE_ERROR_MESSAGE: 'Recoverable Forward Failure',

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

class RedundantDestinationResult {
    constructor(wasSuccessful, hadRecoverableError, successfulDestination, errorMessages, errors) {
        this.wasSuccessful = wasSuccessful;
        this.hadRecoverableError = hadRecoverableError;
        this.successfulDestination = successfulDestination;
        this.errorMessages = errorMessages;
        this.errors = errors;
    }
};

class RecoverableForwardError extends Error {
    constructor(errors) {
        super(FIXED.RECOVERABLE_FORWARD_INTERFACE_ERROR_MESSAGE);
        this.name = 'RecoverableForwardError';
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
    // RECOMMENDATION: The multi address, redundant address and reject separators SHOULD
    // - be either 
    //     - a space ' ', OR
    //     - one of the special characters '"(),:;<>[\]'
    // which are not allowed in the unquoted local-part of an email address.
    // See [Email address - Wikipedia](https://en.wikipedia.org/wiki/Email_address#Local-part).
    // Quoted local-parts in email addresses are not supported here as it would
    // add complexity and as they are used infrequently not many systems support
    // them in any case.
    //
    FORMAT_REDUNDANT_ADDRESS_SEPARATOR: ",",
    FORMAT_SIMPLE_ADDRESS_SEPARATOR: ":",
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
    RECOVERABLE_FORWARD_IMPLEMENTATION_ERROR_REGEXP: `(^${escape(FIXED.RECOVERABLE_FORWARD_IMPLEMENTATION_ERROR_MESSAGE_1)})`,

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
    // Forward to a redundantDestination by attempting to forward to
    // each included simpleDestination sequentially the forward is successful.
    // Implementation exceptions are not propagated but aggregated as a 
    // RedundantDestinationResult which aggregates the results of all forwards
    // attempted.
    async forwardToRedundantDestination(
        message, redundantDestination, redundantDestinationId, customHeaders, emailImage, configuration) {
        let s = 0;
        let wasSuccessful = false;
        let hadRecoverableError = false;
        let errorMessages = [];
        let errors = [];
        for (const simpleDestination of redundantDestination) {
            const simpleDestinationId = s + 1;
            const log = (wasSuccessful, errorMessage) => {
                configuration.consoleLog({
                    email: emailImage,
                    action: 'RedundantForward',
                    redundantDestinationId: redundantDestinationId,
                    simpleDestinationId: simpleDestinationId,
                    simpleDestination: simpleDestination,
                    wasSuccessful: wasSuccessful,
                    errorMessage: errorMessage,
                }, configuration);
            };
            try {
                await message.forward(simpleDestination, customHeaders);
                wasSuccessful = true;
                log(wasSuccessful, null);
                break;
            }
            catch (error) {
                log(wasSuccessful, error.message);
                errorMessages.push({
                    redundantDestinationId: redundantDestinationId,
                    simpleDestinationId: simpleDestinationId,
                    simpleDestination: simpleDestination,
                    errorMessage: error.message
                });
                errors.push(error);
                if (configuration.recoverableForwardImplementationErrorRegExp.test(error.message)) {
                    hadRecoverableError = true;
                }
            }
            s++;
        }
        return new RedundantDestinationResult(
            wasSuccessful,
            hadRecoverableError,
            wasSuccessful ? redundantDestination.at(s) : null,
            errorMessages,
            errors,
        );
    },
    // Forwards to a multiaddress which is an array of zero or more redundant
    // destinations, by simultaneously fowarding to each redundant destination.
    // Throws if one or more redundant destinations had a recoverable error
    // and all other redundant destinations were successful.
    // Otherwise returns whether forwarding to all redundant destinations was
    // successful and there was at least one redundant destination.
    // Errors caught when attempting to forward to a redundant destination are
    // classified as either:
    // - recoverable: a.k.a. "transient", "temporary" or "soft" errors,
    //     which are often resolved after a period of time without any
    //     intervention by an administrator.
    // - unrecoverable: a.k.a. "permanent", "persistent" or "hard" errors,
    //     which are likely to persist until an administrator intervenes and
    //     rectifies the underlying fault.
    // Throwing an exception causes an error email to be returned
    // to the original sender, which usually will retry sending
    // the email periodically until it is successfully delivered or a time limit
    // or maximum number of retry attempts has been reached.
    // In the case of a unrecoverable error this resending serves no purpose as
    // the forward is likely to continue to fail until the underlying fault is
    // rectified and for this reason no exception is thrown.
    async forwardToMultiDestination(message, actionType, multiDestination, customHeaders, emailImage, configuration) {
        const redundantDestinationResults = await Promise.all(
            multiDestination.map((redundantDestination, redundantDestinationIndex) =>
                configuration.forwardToRedundantDestination(
                    message, redundantDestination,
                    redundantDestinationIndex + 1,
                    customHeaders, emailImage, configuration)
            ));
        const wasSuccessful = multiDestination.length > 0
            && redundantDestinationResults.map(
                result => result.wasSuccessful).every(Boolean);
        const allRedundantDestinationsWereSuccessfulOrHadARecoverableError
            = multiDestination.length > 0
            && redundantDestinationResults.map(
                result => (result.wasSuccessful || result.hadRecoverableError)).every(Boolean);
        const successfulDestinations = redundantDestinationResults
            .map(result => result.successfulDestination).filter(Boolean);
        const errorMessages = redundantDestinationResults
            .flatMap(result => result.errorMessages);
        const errors = redundantDestinationResults
            .flatMap(result => result.errors);
        let status = wasSuccessful
            ? 'SuccessfulForwarding'
            : (allRedundantDestinationsWereSuccessfulOrHadARecoverableError
                ? 'RecoverableErrorForwarding'
                : 'FailureForwarding');
        console.info({
            email: emailImage,
            action: actionType,
            multiDestination: multiDestination,
            status: status,
            successfulDestinations: successfulDestinations,
            errorMessages: errorMessages
        });
        if (!wasSuccessful && allRedundantDestinationsWereSuccessfulOrHadARecoverableError) {
            throw new RecoverableForwardError(errors);
        }
        return wasSuccessful;
    },
    isValidEmailAddress(address, validAddressRegExp) {
        return validAddressRegExp.test(address);
    }
};

export default {
    // Handle the forwarding of an email based on the message's `to` attribute. 
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

            RECOVERABLE_FORWARD_IMPLEMENTATION_ERROR_REGEXP,

            FORMAT_REDUNDANT_ADDRESS_SEPARATOR,
            FORMAT_SIMPLE_ADDRESS_SEPARATOR,
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
            forwardToRedundantDestination,
            forwardToMultiDestination,
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
        ).trim();
        const globalRejectTreatment = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@REJECT_TREATMENT')
            ?? REJECT_TREATMENT
        ).trim();
        const globalSubaddresses = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@SUBADDRESSES')
            ?? SUBADDRESSES
        ).trim().toLowerCase();
        const globalUsers = (
            await storedConfigurationValue(useStoredAddressGlobalConfiguration,
                '@USERS')
            ?? USERS
        ).trim().toLowerCase();

        const recoverableForwardImplementationErrorRegExp =
            new RegExp(RECOVERABLE_FORWARD_IMPLEMENTATION_ERROR_REGEXP);

        const formatValidEmailAddressRegExp =
            new RegExp(FORMAT_VALID_EMAIL_ADDRESS_REGEXP);
        const formatValidCustomHeaderRegExp =
            new RegExp(FORMAT_VALID_CUSTOM_HEADER_REGEXP);

        const customHeader =
            validateCustomHeader(CUSTOM_HEADER);
        const customHeaderFail =
            CUSTOM_HEADER_FAIL.trim();
        const customHeaderPass =
            CUSTOM_HEADER_PASS.trim();

        const CONFIGURATION = {
            recoverableForwardImplementationErrorRegExp: recoverableForwardImplementationErrorRegExp,
            consoleLogEnabled: consoleLogEnabled,
            consoleLog: consoleLog,
            forwardToRedundantDestination: forwardToRedundantDestination,
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
            const customHeaderTrimmed = customHeader.trim();
            if (formatValidCustomHeaderRegExp.test(customHeaderTrimmed))
                return customHeaderTrimmed;
            else
                throw (`Invalid custom header ${customHeaderTrimmed}`);
        }
        // Return an object with valid and invalid simple addresses for a redundant
        // destination after
        // - trimming whitespace
        // - prepend the message's user to the destination if it begins with
        //   either FORMAT_LOCAL_PART_SEPARATOR or '@'
        function validateRedundantDestination(redundantDestinationText) {
            return redundantDestinationText.split(FORMAT_SIMPLE_ADDRESS_SEPARATOR).reduce(
                (newRedundantDestination, basicDestination) => {
                    let simpleDestination = FIXED.prepend(basicDestination.trim(),
                        [{ test: FORMAT_LOCAL_PART_SEPARATOR, prepend: messageUser },
                        { test: '@', prepend: messageUser }]
                    );
                    if (isValidEmailAddress(simpleDestination, formatValidEmailAddressRegExp)) {
                        newRedundantDestination.validSimple.push(simpleDestination);
                    } else if (simpleDestination !== '') {
                        newRedundantDestination.invalidSimple.push(simpleDestination);
                    }
                    return newRedundantDestination;
                },
                { validSimple: [], invalidSimple: [] }
            );
        }
        function validateMultiDestination(multiDestinationText) {
            return multiDestinationText.split(FORMAT_REDUNDANT_ADDRESS_SEPARATOR).reduce(
                (newMultiDestination, redundantDestinationText) => {
                    const nonDedupedredundantDestination =
                        validateRedundantDestination(redundantDestinationText);
                    const dedupedRedundantDestination = nonDedupedredundantDestination.validSimple.reduce(
                        (newRedundantDestination, destination) => {
                            if (!newMultiDestination.validSimple.includes(destination)) {
                                newMultiDestination.validSimple.push(destination);
                                newRedundantDestination.push(destination);
                            } else {
                                newMultiDestination.duplicateSimple.push(destination);
                            };
                            return newRedundantDestination;
                        }, []);
                    if (dedupedRedundantDestination.length > 0)
                        newMultiDestination.validRedundant.push(dedupedRedundantDestination);
                    newMultiDestination.invalidSimple.concat(nonDedupedredundantDestination.invalidSimple);
                    return newMultiDestination;
                },
                { validRedundant: [], validSimple: [], invalidSimple: [], duplicateSimple: [] }
            );
        }
        function warnAboutBadDestinations(messageUser, validatedMultiDestination, destinationType) {
            [
                {
                    description: 'invalidly formatted',
                    destinations: validatedMultiDestination.invalidSimple
                },
                {
                    description: 'duplicate',
                    destinations: validatedMultiDestination.duplicateSimple
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
        function multiDestinationImage(validatedMultiDestination) {
            return validatedMultiDestination.map(
                redundantDestination =>
                    redundantDestination.join(FORMAT_SIMPLE_ADDRESS_SEPARATOR)
            ).join(FORMAT_REDUNDANT_ADDRESS_SEPARATOR);
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
            (await storedConfigurationValue(
                useStoredUserConfiguration,
                messageUser + FORMAT_LOCAL_PART_SEPARATOR))
                ?.trim().toLowerCase()
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
            userDestinationWithRejectTreatment?.split(FORMAT_REJECT_SEPARATOR).at(0).trim()
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
            || globalUsers.split(FORMAT_REDUNDANT_ADDRESS_SEPARATOR)
                .map(s => s.trim()).includes(messageUser);
        // The subaddress is allowed if:
        // - the message user either
        //     - has no subaddress and users do not require one, or
        //     - has a subaddress and the subaddress configuration is either
        //       a wildcard or the user in the set of allowed subaddresses 
        const messageSubaddressIsAllowed =
            messageSubaddress === ''
                ? !userRequiresSubaddress
                : userConcreteSubaddresses === '*'
                || userConcreteSubaddresses.split(FORMAT_REDUNDANT_ADDRESS_SEPARATOR)
                    .map(s => s.trim()).includes(messageSubaddress);

        // Accept forward if the the message user and subaddress are allowed
        let acceptForwardWasSuccessful = false;
        if (messageUserIsAllowed && messageSubaddressIsAllowed) {
            const acceptMultiDestination =
                validateMultiDestination(userDestination);
            warnAboutBadDestinations(messageUser, acceptMultiDestination, 'AcceptForward');
            consoleLog({
                email: theEmailImage,
                action: 'AcceptForwarding',
                destinations: acceptMultiDestination.validRedundant,
            }, CONFIGURATION);
            // Forward with custom header set to customHeaderPass
            acceptForwardWasSuccessful =
                await forwardToMultiDestination(
                    message,
                    'AcceptForwarding',
                    acceptMultiDestination.validRedundant,
                    new Headers({ [customHeader]: customHeaderPass }),
                    theEmailImage,
                    CONFIGURATION
                );
        }

        // If accept forward failed or none was attempted then reject forward
        if (!acceptForwardWasSuccessful) {
            const rejectMultiDestination =
                validateMultiDestination(userRejectTreatment);
            let rejectForwardWasSuccessful = false;
            // Reject forward if there are some valid reject forward destinations
            if (rejectMultiDestination.validRedundant.length > 0) {
                warnAboutBadDestinations(messageUser, rejectMultiDestination, 'RejectForward');
                rejectForwardWasSuccessful =
                    await forwardToMultiDestination(
                        message,
                        'RejectForwarding',
                        rejectMultiDestination.validRedundant,
                        new Headers({ [customHeader]: customHeaderFail }),
                        theEmailImage,
                        CONFIGURATION
                    );
            }

            // If reject forward failed or none was attempted then direct reject
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
    },
    // Handle a HTTP request by just returning either a not found error
    // response. Not strictly necessary but helps avoid polluting the
    // email worker logs with the more frequent than one would hope
    // "Handler does not export a fetch() function." error message.
    // This appears to be caused by search crawlers attempting to index
    // the domain of the email worker.
    // Having these errors in the logs increases the chance of missing
    // a far more important error relating to email forwarding as generated
    // by the email() function.
    async fetch(request, env, ctx) {
        // Log the request URL and method
        console.log({
            method: request.method,
            url: request.url,
        });
        // Check if the request method is GET
        if (request.method === 'GET') {
            // Return a 404 Not Found response
            return new Response('Not Found', { status: 404 });
        } else {
            // Return a 405 Method Not Allowed response
            return new Response('Method Not Allowed', { status: 405 });
        }
    }
}