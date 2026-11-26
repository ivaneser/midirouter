import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceManager } from '../frontend/js/device-manager.js';

const TARGET = 'Blofeld:Blofeld 20:0';
const base = 'blofeld:blofeld port:0';

// One preset list with its group list, on part 2 (channel 2), filtered to "Bass".
function setup() {
    const manager = new DeviceManager();
    const group = { dataset: { group: 'Bass' }, value: 'Bass' };
    let favoritesOnly = true;
    const list = { dataset: { baseKey: base, deviceKey: `${base}#2`, part: '2', group: 'Bass', favorites: '1' }, _groupSelect: group,
        _showFavoritesOnly: on => { favoritesOnly = on; list.dataset.favorites = on ? '1' : ''; } };
    manager.presetGroups.set(base, { 1: 'Bass', 59: 'Pad', 60: 'Lead' });
    manager.channels = { [`${base}#2`]: 2 };
    manager.refreshPresetLabels = () => manager._followPresets();
    globalThis.document = { querySelectorAll: selector => (selector === '.device-program-name' ? [list] : []) };
    return { manager, list, group, favorites: () => favoritesOnly };
}
const report = (manager, program) => manager.updateDevicePresets([{ target: TARGET, channel: 2, program }]);

test('a preset chosen elsewhere moves the lists to its group and out of favorites only', t => {
    t.after(() => delete globalThis.document);
    const { manager, list, group, favorites } = setup();
    report(manager, 58);
    assert.equal(list.dataset.group, 'Pad');
    assert.equal(group.value, 'Pad');
    assert.equal(favorites(), false);
});

test('a choice made on this page, and a repeated report, leave the filter alone', t => {
    t.after(() => delete globalThis.document);
    const { manager, list, group } = setup();
    report(manager, 58);
    list.dataset.group = group.value = '';    // the user browses all groups
    report(manager, 58);                       // the router repeats its state
    assert.equal(list.dataset.group, '');
    manager.programs.set(`${base}:2`, 59);     // picked in the list
    report(manager, 59);
    assert.equal(list.dataset.group, '');
    report(manager, 0);                        // changed over MCP
    assert.equal(list.dataset.group, 'Bass');
});
