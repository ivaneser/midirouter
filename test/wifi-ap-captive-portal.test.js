import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getCaptivePortalRedirect } from '../wifi-ap/captive-portal.js';

const startApPath = fileURLToPath(new URL('../wifi-ap/start-ap.sh', import.meta.url));
const startAp = readFileSync(startApPath, 'utf8');
const stopApPath = fileURLToPath(new URL('../wifi-ap/stop-ap.sh', import.meta.url));
const stopAp = readFileSync(stopApPath, 'utf8');

test('HTTP captive-check requests from AP clients redirect to the web UI', () => {
    assert.deepEqual(getCaptivePortalRedirect({
        host: 'connectivitycheck.gstatic.com',
        remoteAddress: '10.0.0.2'
    }), {
        statusCode: 302,
        location: 'http://10.0.0.1:3000/'
    });
});

test('direct local web UI requests are not redirected', () => {
    assert.equal(getCaptivePortalRedirect({
        host: '10.0.0.1:3000',
        remoteAddress: '10.0.0.2'
    }), null);
});

test('HTTP requests from outside the AP subnet are not redirected', () => {
    assert.equal(getCaptivePortalRedirect({
        host: 'example.com',
        remoteAddress: '192.168.1.20'
    }), null);
});

test('AP setup redirects HTTP only and never downgrades HTTPS to plain HTTP', () => {
    assert.match(startAp, /--dport 80\s+-j REDIRECT --to-port \$\{WEB_PORT\}/);
    assert.doesNotMatch(startAp, /--dport 443\s+-j REDIRECT/);
});

test('AP client allow rules are attached to filter INPUT, not invalid PREROUTING', () => {
    assert.match(startAp, /iptables -t filter -N MIDIRouter/);
    assert.match(startAp, /--dport 67 -j ACCEPT/);
    assert.match(startAp, /iptables -t filter -I INPUT 1 -i "\$\{AP_INTERFACE\}" -s 10\.0\.0\.0\/24 -j MIDIRouter/);
    assert.doesNotMatch(startAp, /iptables -t filter -A PREROUTING/);
});

test('AP shutdown removes the filter INPUT jump and custom chain', () => {
    assert.match(stopAp, /iptables -t filter -D INPUT -i "\$\{AP_INTERFACE\}" -s 10\.0\.0\.0\/24 -j MIDIRouter/);
    assert.match(stopAp, /iptables -t filter -F MIDIRouter/);
    assert.match(stopAp, /iptables -t filter -X MIDIRouter/);
});
