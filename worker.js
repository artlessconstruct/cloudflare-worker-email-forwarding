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
    // Can be overridden by KV-based global configuration
    DESTINATION: "",
    FAILURE_TREATMENT: "Invalid recipient",
    SUBADDRESSES: "*",
    USERS: "",
    // Cannot be overridden by KV-based global configuration
    ADDRESS_SEPARATOR: ",",
    FAILURE_SEPARATOR: ";",
    HEADER: "X-My-Email-Subaddressing",
    LOCAL_PART_SEPARATOR: "+",
    // Cloudflare KV key-value store
    MAP: new Map()
};

export default {
    async email(message, environment, context,
        // Returns the local and domain part
        { addressLocalParts = (localPart, localPartSeparator) => localPart.split(localPartSeparator, 2) } = {}) {
        // Environment-based configuration falls back to `DEFAULTS`.
        const {
            DESTINATION,
            FAILURE_TREATMENT,
            SUBADDRESSES,
            USERS,
            ADDRESS_SEPARATOR,
            FAILURE_SEPARATOR,
            HEADER,
            LOCAL_PART_SEPARATOR,
            MAP
        } = { ...DEFAULTS, ...environment };

        // KV-based configuration overrides environment-based configuration (and
        // defaults) when present for the following variables only
        const users = (await MAP.get('@USERS') || USERS)?.replace(/\s+/g, '');
        let subaddresses = (await MAP.get('@SUBADDRESSES') || SUBADDRESSES)?.replace(/\s+/g, '');
        let destination = (await MAP.get('@DESTINATION') || DESTINATION)?.replace(/\s+/g, '');
        let failureTreatment = await MAP.get('@FAILURE_TREATMENT') || FAILURE_TREATMENT;

        // Given from RFC 5233 that the email address has the syntax:
        //     `${LocalPart}@${Domain}`
        // and LocalPart has the syntax
        //     `${user}${LOCAL_PART_SEPARATOR}${subaddress}`
        // obtain the LocalPart first by splitting the message's 'to'
        // address using separator '@' and then use the addressLocalParts
        // function to split this again into User and Subaddress using the
        // configured LOCAL_PART_SEPARATOR
        const [user, subaddress] = addressLocalParts(message.to.split('@')[0], LOCAL_PART_SEPARATOR);

        // KV-based user configuration overrides KV-based global configuration when present,
        // which overrides environment-based configuration (and defaults) when present.
        const userDestinationAndFailureTreatment = (await MAP.get(user))?.replace(/\s+/g, '');
        subaddresses = (await MAP.get(`${user}${LOCAL_PART_SEPARATOR}`))?.replace(/\s+/g, '') || subaddresses;
        // Given userDestinationAndFailureTreatment has the syntax:
        //     `${destination}${FAILURE_SEPARATOR}${failureAddressOrReason}`
        // then split userDestinationAndFailureTreatment into destination and failureAddressOrReason
        destination = userDestinationAndFailureTreatment?.split(FAILURE_SEPARATOR).at(0) || destination;
        failureTreatment = userDestinationAndFailureTreatment?.split(FAILURE_SEPARATOR).at(1) || failureTreatment;

        // Validate "local-part" [RFC] against configuration.
        // First validate the user
        let isValid = userDestinationAndFailureTreatment !== undefined || '*' === users || users.split(ADDRESS_SEPARATOR).includes(user);
        // If valid then validate the subaddress if it exists
        if (isValid && subaddress) {
            isValid = '*' === subaddresses || subaddresses?.split(ADDRESS_SEPARATOR).includes(subaddress);
        }

        // Forward normally if the the user is valid and there is a
        // corresponding valid destination for the user
        if (isValid && destination) {
            // Forward to each address contained in destination
            const destinations = destination.split(ADDRESS_SEPARATOR);
            for (let d = 0; d < destinations.length; d++) {
                // Prepend the user to the destination if it starts with an '@'
                if (destinations[d].startsWith('@')) {
                    destinations[d] = user + destinations[d];
                }
                // Forward with custom header set to 'PASS'
                await message.forward(destinations[d], new Headers({
                    [HEADER]: 'PASS'
                }));
            }
        } else {
            // Otherwise fail the forward

            // Prepend user to the failureAddressOrReason if it starts with a
            // non-alphanumeric
            if (/^[^A-Z0-9]/i.test(failureTreatment)) {
                failureTreatment = user + failureTreatment;
            }
            // If failureAddressOrReason includes a '@' then forward to the failure
            // address with custom header set to 'FAIL'
            if (failureTreatment.includes('@')) {
                await message.forward(failureTreatment.replace(/\s+/g, ''), new Headers({
                    [HEADER]: 'FAIL'
                }));
            } else {
                // Otherwise reject the message altogether
                message.setReject(failureTreatment);
            }
        }
    }
}