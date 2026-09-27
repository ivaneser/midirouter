const LOCAL_HOSTS = new Set(['10.0.0.1', 'midirouter', 'localhost', '127.0.0.1', '::1']);

function normalizeHost(host) {
    if (typeof host !== 'string') return '';
    const value = host.trim().toLowerCase();
    if (value.startsWith('[')) {
        const closingBracket = value.indexOf(']');
        return closingBracket === -1 ? value : value.slice(1, closingBracket);
    }
    return value.replace(/:\d+$/, '');
}

function isApClientAddress(address) {
    const normalized = typeof address === 'string'
        ? address.replace(/^::ffff:/, '')
        : '';
    const match = /^10\.0\.0\.(\d{1,3})$/.exec(normalized);
    if (!match) return false;
    const lastOctet = Number(match[1]);
    return lastOctet >= 2 && lastOctet <= 254;
}

/**
 * Return the redirect response for HTTP captive-check requests forwarded by
 * the AP's port-80 iptables rule. HTTPS is deliberately never intercepted:
 * forwarding TLS to the plain-HTTP UI breaks the browser handshake.
 */
export function getCaptivePortalRedirect({ host, remoteAddress } = {}) {
    if (!isApClientAddress(remoteAddress)) return null;
    if (LOCAL_HOSTS.has(normalizeHost(host))) return null;

    return {
        statusCode: 302,
        location: 'http://10.0.0.1:3000/'
    };
}
