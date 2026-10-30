import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = name => readFileSync(join(import.meta.dirname, '..', name), 'utf8');

test('the systemd unit lets the router open port 80 for the listen page', () => {
    assert.match(read('midirouter.service'), /^AmbientCapabilities=.*\bCAP_NET_BIND_SERVICE\b/m);
});

test('bootstrap and enable-autostart install that unit and point to the listen page', () => {
    for (const script of ['bootstrap.sh', 'enable-autostart.sh']) {
        const text = read(script);
        assert.match(text, /cp (?:-f )?"\$\{REPO_DIR\}\/midirouter\.service"/, `${script} copies midirouter.service`);
        assert.match(text, /listen page/i, `${script} mentions the listen page`);
    }
});

test('install.sh (supervisor) gives node the port 80 capability and installs setcap', () => {
    const text = read('install.sh');
    assert.match(text, /libcap2-bin/);
    assert.match(text, /setcap 'cap_net_bind_service=\+ep' "\$NODE_BIN"/);
    assert.match(text, /Listen page: .*<IP_RASPBERRY_PI>\//);
});

test('the hotspot leaves 10.0.0.1:80 to the listen page before it redirects everything else', () => {
    const text = read('wifi-ap/start-ap.sh');
    const keep = text.indexOf('-d 10.0.0.1 --dport 80 -j RETURN');
    const redirect = text.indexOf('-j REDIRECT --to-port ${WEB_PORT}');
    assert.ok(keep > 0 && redirect > keep, 'the RETURN rule comes before the REDIRECT rule');
});
