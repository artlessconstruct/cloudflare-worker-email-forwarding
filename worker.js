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

export const DEFAULTS = {
    // Control whether different tyeps of KV-based configuration is loaded
    SHOULD_LOAD_KV_ADDRESS_GLOBAL_CONFIGURATION: 'true',
    SHOULD_LOAD_KV_FORMAT_GLOBAL_CONFIGURATION: 'true',
    SHOULD_LOAD_KV_HEADER_GLOBAL_CONFIGURATION: 'true',
    SHOULD_LOAD_KV_USER_CONFIGURATION: 'true',
    // If SHOULD_LOAD_KV_ADDRESS_CONFIGURATION is enabled then
    // this KV-based address global configuration will be loaded
    DESTINATION: '',
    FAILURE_TREATMENT: 'Invalid recipient',
    SUBADDRESSES: '*',
    USERS: '',
    // If SHOULD_LOAD_KV_FORMAT_CONFIGURATION is enabled then
    // this KV-based address global configuration will be loaded
    ADDRESS_SEPARATOR: ',',
    FAILURE_SEPARATOR: ';',
    LOCAL_PART_SEPARATOR: '+',
    // If SHOULD_LOAD_KV_HEADER_CONFIGURATION is enabled then
    // this KV-based address global configuration will be loaded
    CUSTOM_HEADER: 'X-My-Email-Subaddressing',
    CUSTOM_HEADER_FAIL: 'fail',
    CUSTOM_HEADER_PASS: 'pass',
    // Cloudflare KV key-value store
    MAP: new Map()
};

export default {
    async email(message, environment, context,
        // Returns the local and domain part
        { addressLocalParts = (localPart, localPartSeparator) => localPart.split(localPartSeparator, 2) } = {}) {

        // Environment-based configuration falls back to `DEFAULTS`.
        const {
            // Loading control configuraiton
            SHOULD_LOAD_KV_ADDRESS_GLOBAL_CONFIGURATION,
            SHOULD_LOAD_KV_FORMAT_GLOBAL_CONFIGURATION,
            SHOULD_LOAD_KV_HEADER_GLOBAL_CONFIGURATION,
            SHOULD_LOAD_KV_USER_CONFIGURATION,
            // Address configuration
            DESTINATION,
            FAILURE_TREATMENT,
            SUBADDRESSES,
            USERS,
            // Format configuration
            ADDRESS_SEPARATOR,
            FAILURE_SEPARATOR,
            LOCAL_PART_SEPARATOR,
            // Header configuration
            CUSTOM_HEADER,
            CUSTOM_HEADER_FAIL,
            CUSTOM_HEADER_PASS,
            // KV map
            MAP
        } = { ...DEFAULTS, ...environment };

        // Helpers
        function stringToBoolean(stringBoolean) {
            return ['true', '1']
                .includes(stringBoolean.trim().toLowerCase());
        }
        async function loadMapValue(ifShouldLoad, key) {
            // MAP.get(key) returns null if key is not present so '?? undefined'
            // is used to coalesce null to undefined but leave '' unchanged
            // which is important because '' is used to indicate that the destination
            // for a particular user is the destination in the global configuration
            return ifShouldLoad ? (await MAP.get(key) ?? undefined) : undefined;
        }
        function validatedCustomHeader(customHeader) {
            // Custom headers must begin with 'X-'
            const customHeaderNoSpaces = customHeader.replace(/\s+/g,'');
            return /X-.*/.test(customHeaderNoSpaces) ? customHeaderNoSpaces : undefined;
        }

        // Controls to load different KV-based configuration
        const shouldLoadKvAddressGlobalConfiguration =
            stringToBoolean(SHOULD_LOAD_KV_ADDRESS_GLOBAL_CONFIGURATION);
        const shouldLoadKvFormatGlobalConfiguration =
            stringToBoolean(SHOULD_LOAD_KV_FORMAT_GLOBAL_CONFIGURATION);
        const shouldLoadKvHeaderGlobalConfiguration =
            stringToBoolean(SHOULD_LOAD_KV_HEADER_GLOBAL_CONFIGURATION);
        const shouldLoadKvUserConfiguration =
            stringToBoolean(SHOULD_LOAD_KV_USER_CONFIGURATION);

        // If shouldLoadKvAddressGlobalConfiguration
        // load KV-based address global configuration
        // which overrides environment-based configuration (and defaults)
        let destination = (
            await loadMapValue(shouldLoadKvAddressGlobalConfiguration,
                '@DESTINATION') || DESTINATION
        );
        let failureTreatment = (
            await loadMapValue(shouldLoadKvAddressGlobalConfiguration,
                '@FAILURE_TREATMENT') || FAILURE_TREATMENT
        );
        let subaddresses = (
            await loadMapValue(shouldLoadKvAddressGlobalConfiguration,
                '@SUBADDRESSES') || SUBADDRESSES
        );
        const users = (
            await loadMapValue(shouldLoadKvAddressGlobalConfiguration,
                '@USERS') || USERS
        ).replace(/\s+/g, '');
        // If shouldLoadKvFormatGlobalConfiguration
        // load KV-based format global configuration
        // which overrides environment-based configuration (and defaults)
        const addressSeparator = (
            await loadMapValue(shouldLoadKvFormatGlobalConfiguration,
                '@ADDRESS_SEPARATOR') || ADDRESS_SEPARATOR
        ).replace(/\s+/g, '');
        const failureSeparator = (
            await loadMapValue(shouldLoadKvFormatGlobalConfiguration,
                '@FAILURE_SEPARATOR') || FAILURE_SEPARATOR
        ).replace(/\s+/g, '');
        const localPartSeparator = (
            await loadMapValue(shouldLoadKvFormatGlobalConfiguration,
                '@LOCAL_PART_SEPARATOR') || LOCAL_PART_SEPARATOR
        ).replace(/\s+/g, '');
        // If shouldLoadKvHeaderGlobalConfiguration
        // load KV-based header global configuration
        // which overrides environment-based configuration (and defaults)
        const customHeader = (
            validatedCustomHeader(
                await loadMapValue(shouldLoadKvHeaderGlobalConfiguration,
                    '@CUSTOM_HEADER') || CUSTOM_HEADER) || DEFAULTS.CUSTOM_HEADER
        ).replace(/\s+/g, '');
        const customHeaderFail = (
            await loadMapValue(shouldLoadKvHeaderGlobalConfiguration,
                '@CUSTOM_HEADER_FAIL') || CUSTOM_HEADER_FAIL
        ).trim();
        const customHeaderPass = (
            await loadMapValue(shouldLoadKvHeaderGlobalConfiguration,
                '@CUSTOM_HEADER_PASS') || CUSTOM_HEADER_PASS
        ).trim();

        // Given from RFC 5233 that the email address has the syntax:
        //     `${LocalPart}@${Domain}`
        // and LocalPart has the syntax
        //     `${user}${localPartSeparator}${subaddress}`
        // obtain the LocalPart first by splitting the message's 'to'
        // address using separator '@' and then use the addressLocalParts
        // function to split this again into User and Subaddress using the
        // configured localPartSeparator
        const [user, subaddress] = addressLocalParts(message.to.split('@')[0], localPartSeparator);

        // If shouldLoadKvUserConfiguration
        // load KV-based user global configuration
        // which overrides environment-based configuration (and defaults)
        const userDestinationWithFailureTreatment
            = await loadMapValue(shouldLoadKvUserConfiguration, user);
        subaddresses = (
            await loadMapValue(shouldLoadKvUserConfiguration, `${user}${localPartSeparator}`)
            || subaddresses
        ).replace(/\s+/g, '');
        // Given userDestinationWithFailureTreatment has the syntax:
        //     `${destination}${failureSeparator}${failureTreatment}`
        // then split userDestinationWithFailureTreatment into destination and failureTreatment
        destination = (
            userDestinationWithFailureTreatment?.split(failureSeparator).at(0)
            || destination
        ).trim();
        failureTreatment = (
            userDestinationWithFailureTreatment?.split(failureSeparator).at(1)
            || failureTreatment
        ).trim();

        // Validate "local-part" [RFC] against configuration.
        // First validate the user
        let userIsAllowed =
            userDestinationWithFailureTreatment !== undefined
            || '*' === users
            || users.split(addressSeparator).includes(user);
        // If valid then validate the subaddress if it exists
        if (userIsAllowed && subaddress) {
            userIsAllowed =
                '*' === subaddresses
                || subaddresses?.split(addressSeparator).includes(subaddress);
        }

        // Forward normally if the the user is valid and there is a
        // corresponding valid destination for the user
        if (userIsAllowed && destination) {
            // Forward to each address contained in destination
            const destinations = destination.split(addressSeparator);
            for (let d = 0; d < destinations.length; d++) {
                // Prepend the user to the destination if it starts with an '@'
                let aDestination = destinations.at(d).trim();
                if (aDestination.startsWith('@')) {
                    aDestination = user + aDestination;
                }
                // Forward with custom header set to customHeaderPass
                await message.forward(aDestination, new Headers({
                    [customHeader]: customHeaderPass
                }));
            }
        } else {
            // Otherwise fail the forward

            // Prepend user to the failureTreatment if it starts with a
            // non-alphanumeric
            if (/^[^A-Z0-9]/i.test(failureTreatment)) {
                failureTreatment = user + failureTreatment;
            }
            // If failureTreatment includes a '@' then forward to the failure
            // address with custom header set to customHeaderFail
            if (failureTreatment.includes('@')) {
                await message.forward(failureTreatment.replace(/\s+/g, ''), new Headers({
                    [customHeader]: customHeaderFail
                }));
            } else {
                // Otherwise reject the message altogether
                message.setReject(failureTreatment);
            }
        }
    }
}