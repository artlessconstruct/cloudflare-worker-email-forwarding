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

//
export const DEFAULTS = {
    USERS: "",
    SUBADDRESSES: "*",
    DESTINATION: "",
    SEPARATOR: "+",
    FAILURE: "Invalid recipient",
    HEADER: "X-My-Email-Subaddressing",
    // Cloudflare KV
    MAP: new Map()
};

//
export default {
    async email(message, environment, context, { implementation = (localPart, separator) => localPart.split(separator, 2) } = {}) {
        // Environment-based configs fallback to `DEFAULTS`.
        const { USERS, SUBADDRESSES, DESTINATION, SEPARATOR, FAILURE, HEADER, MAP } = { ...DEFAULTS, ...environment }

        // KV-based global configs override environment-based configs (and
        // defaults) when present.
        const users = await MAP.get('@USERS') || USERS;
        let subaddresses = await MAP.get('@SUBADDRESSES') || SUBADDRESSES;
        let destination = await MAP.get('@DESTINATION') || DESTINATION;
        let failure = await MAP.get('@FAILURE') || FAILURE;
        const header = await MAP.get('@HEADER') || HEADER;
        const separator = await MAP.get('@SEPARATOR') || SEPARATOR;

        // Implement "separator character sequence" against "local-part" [RFC].
        const [user, subaddress] = implementation(message.to.split('@')[0], separator);

        // KV-based user configs override KV-based global configs when present,
        // which override environment-based configs (and defaults) when present. 
        const mappedUser = await MAP.get(user);
        subaddresses = await MAP.get(`${user}${separator}`) || subaddresses;
        // Decompose mappedUser which is expected to be in the format 'destination;failure'
        destination = mappedUser?.split(';').at(0) || destination;
        failure = mappedUser?.split(';').at(1) || failure;

        // Validate "local-part" [RFC] against configuration.
        // First validate the user
        let isValid = mappedUser !== null || '*' === users || users.replace(/\s+/g, '').split(',').includes(user);
        // If valid then validate the subaddress if it exists
        if (isValid && subaddress) {
            isValid = '*' === subaddresses || subaddresses.replace(/\s+/g, '').split(',').includes(subaddress);
        }

        // Forward normally if the the user is valid and there is a
        // corresponding valid destination for the user
        if (isValid && destination) {
            // Forward to each ':' separated recipient contained in destination
            const destinations = destination.split(':');
            for (let d = 0; d < destinations.length; d++) {
                // Prepend the user to the destination if it starts with an '@'
                if (destinations[d].startsWith('@')) {
                    destinations[d] = user + destinations[d];
                }
                // Forward with custom header set to 'PASS'
                await message.forward(destinations[d], new Headers({
                    [header]: 'PASS'
                }));
            }
        } else {
            // Otherwise effect the failure response

            // Prepend user to the failure response if it starts with a
            // non-alphanumeric
            if (/^[^A-Z0-9]/i.test(failure)) {
                failure = user + failure;
            }
            // If failure response includes a '@' then forward to the failure
            // address with custom header set to 'FAIL'
            if (failure.includes('@')) {
                await message.forward(failure, new Headers({
                    [header]: 'FAIL'
                }));
            } else {
                // Otherwise reject the message altogether
                message.setReject(failure);
            }
        }
    }
}