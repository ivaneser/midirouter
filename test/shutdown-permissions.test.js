import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const root = fileURLToPath(new URL('../', import.meta.url));
const shellPath = path => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const scripts = ['setup-shutdown-permissions.sh', 'bootstrap.sh', 'enable-autostart.sh', 'install.sh'];

test('setup shell scripts parse', { skip: !existsSync(bash) }, () => {
    for (const script of scripts) {
        const result = spawnSync(bash, ['-n', shellPath(join(root, script))], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
});

function runSetup(t, user, { uid = '0', visudoStatus = '0' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'midirouter-shutdown-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const init = join(dir, 'mock-system.sh');
    // Mock privileged commands: this test never writes /etc or shuts down.
    writeFileSync(init, `
id() { printf '%s\\n' "$TEST_UID"; }
getent() { [[ "$2" == "pi" || "$2" == "midi" || "$2" == "router_user" ]]; }
sudo() { return 0; }
visudo() { cat "$2" > "$TEST_DIR/rule"; return "$TEST_VISUDO_STATUS"; }
install() { printf '%s\\n' "$*" >> "$TEST_DIR/install-calls"; }
function [() {
    if [[ "$1" == "-x" && "$2" == "/sbin/shutdown" ]]; then return 0; fi
    if [[ "$1" == "!" && "$2" == "-x" && "$3" == "/sbin/shutdown" ]]; then return 1; fi
    builtin [ "$@"
}
`);
    const result = spawnSync(bash, ['-c', 'source "$1" "$TEST_USER"', '--', shellPath(join(root, scripts[0]))], {
        encoding: 'utf8',
        env: { ...process.env, BASH_ENV: shellPath(init), TEST_DIR: shellPath(dir),
            TEST_UID: uid, TEST_VISUDO_STATUS: visudoStatus, TEST_USER: user },
    });
    return { result, dir };
}

for (const user of ['pi', 'midi', 'router_user']) {
    test(`installs only the exact shutdown permission for ${user}`, { skip: !existsSync(bash) }, t => {
        const { result, dir } = runSetup(t, user);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(dir, 'rule'), 'utf8'), `${user} ALL=(root) NOPASSWD: /sbin/shutdown -h now\n`);
        assert.match(readFileSync(join(dir, 'install-calls'), 'utf8'), /-o root -g root -m 0440 .* \/etc\/sudoers.d\/midirouter-shutdown/);
    });
}

test('visudo rejection prevents permission installation', { skip: !existsSync(bash) }, t => {
    const { result, dir } = runSetup(t, 'pi', { visudoStatus: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(dir, 'install-calls')), false);
});

test('unknown or malformed usernames cannot be installed', { skip: !existsSync(bash) }, t => {
    for (const user of ['missing_user', 'pi ALL=(ALL) ALL', 'pi\nroot']) {
        const { result, dir } = runSetup(t, user);
        assert.notEqual(result.status, 0, `username ${JSON.stringify(user)}: ${result.stdout} ${result.stderr}`);
        assert.equal(existsSync(join(dir, 'rule')), false);
        assert.equal(existsSync(join(dir, 'install-calls')), false);
    }
});

test('non-root execution cannot install permissions', { skip: !existsSync(bash) }, t => {
    const { result, dir } = runSetup(t, 'pi', { uid: '1000' });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(dir, 'install-calls')), false);
});
