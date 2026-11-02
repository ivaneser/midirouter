/* === Device Manager — MIDI device management === */
import { attachMidiKnob } from './midi-knob.js?v=26';
import { planWidgets, createXYPad, createAdsrGraph } from './synth-widgets.js?v=5';
import { planNrpnWidgets, createNrpnWidget } from './nrpn-widgets.js?v=12';
import { connectedDevices, uniquePorts } from './connected-devices.js';
import { groupSynthControls } from './synth-layout.js?v=24';
import { buildStages } from './synth-stages.js?v=4';
import { deviceChannelKey, validMidiChannel } from './device-channels.js';

import {
    buildMidiCcBytes,
    classifySynthPortName,
    getControlsForModel,
    renderControlDefinition,
    MULTITIMBRAL_PARTS,
    MAP_FILES,
    dropdownRaw,
    dropdownIndex,
} from './synth-catalog.js?v=27';

// Instruments without presets of their own: the user saves the CCs they set as named presets (stored on the router).
const USER_PRESET_FILES = { 'korg-nts-1': 'korg_nts1' };

// CC knob position (0-127) for a raw 14-bit NRPN value: the parameter's value (min + raw / scale, or raw
// when it has no scale) placed in its range.
function ccFromNrpn({ nrpnMin, nrpnMax, nrpnScale }, raw) {
    const min = Number(nrpnMin), max = Number(nrpnMax), scale = Number(nrpnScale) || 0;
    const value = scale ? min + raw / scale : raw;
    return Math.max(0, Math.min(127, Math.round((value - min) / (max - min) * 127)));
}

// The same value as the parameter's own number (what the synth displays), snapped to the raw step.
function nativeFromNrpn({ nrpnMin, nrpnMax, nrpnScale }, raw) {
    const scale = Number(nrpnScale) || 0;
    return scale ? Number(nrpnMin) + raw / scale : raw;
}

function nativeFromCc({ nrpnMin, nrpnMax, nrpnScale }, cc) {
    const min = Number(nrpnMin), max = Number(nrpnMax), scale = Number(nrpnScale) || 0;
    const value = min + cc / 127 * (max - min);
    return scale ? Math.round(value * scale) / scale : Math.round(value);
}

// Raw 14-bit NRPN value of a parameter-unit value.
function rawFromNative({ nrpnMin, nrpnScale }, value) {
    const scale = Number(nrpnScale) || 0;
    return scale ? Math.round((value - Number(nrpnMin)) * scale) : Math.round(value);
}

export class DeviceManager {
    constructor() {
        this.inputs = [];   // [{id, name}]
        this.outputs = [];  // [{id, name}]
        this.onStateChange = null;
        this._synthControlCache = new Map();
        // Last value sent per device+CC, so a re-opened panel shows what the synth was set to.
        this._controlValues = new Map();
        // NRPN values (raw, 14-bit) per device+channel+NRPN, from sessions and the MCP server. A knob whose
        // control names an NRPN shows it. _nrpnSeen is the last value the server reported, so a repeated
        // state message does not undo a knob moved since.
        this._nrpnValues = new Map();
        this._nrpnSeen = new Map();
        this.channels = {};
        this.programs = new Map();
        this.presetNames = new Map();
        this.presetCounts = new Map();
        this.presetFiles = new Map();      // baseKey -> device map file name
        this.userPresets = new Map();      // file -> { id: { name, group, controls } } saved on the router
        this.userPresetChosen = new Map(); // `${target}:${channel}` -> id of the preset last loaded
        this.presetGroups = new Map();     // baseKey -> { number: group } (sound categories), when the catalog has them
        this.favorites = new Map();        // device map file -> Set of starred presets (1-based numbers), kept on the router
        this.favoritesVersion = 0;
        this.presetCatalogs = new Map();   // baseKey -> { number: name } from device_maps/presets, when the device has one
    }

    async loadPresetCount(dev) {
        const model = classifySynthPortName(dev.name).model;
        const file = MAP_FILES[model];
        if (!file || this.presetCounts.has(deviceChannelKey(dev.name))) return;
        try {
            const map = await (await fetch(`/device_maps/${file}.json`)).json();
            if (map.presetName?.programs > 128) this.presetCounts.set(deviceChannelKey(dev.name), map.presetName.programs);
        } catch (_) { /* keep 128 presets */ }
    }

    // Factory preset names shipped for a device (device_maps/presets), for the preset drop-down.
    async loadPresetCatalog(dev) {
        const model = classifySynthPortName(dev.name).model;
        const file = MAP_FILES[model];
        const key = deviceChannelKey(dev.name);
        if (!file || this.presetCatalogs.has(key)) return;
        this.presetCatalogs.set(key, {});
        this.presetFiles.set(key, file);
        const names = {}, groups = {};
        // Shipped names first, then what this machine learned from the device (which wins).
        for (const url of [`/device_maps/presets/${file}.json`, `/device_maps/learned/${file}.json`]) {
            try {
                const response = await fetch(url);
                if (!response.ok) continue;
                for (const [number, preset] of Object.entries((await response.json()).presets || {})) {
                    names[number] = preset.name;
                    if (preset.group) groups[number] = preset.group;
                }
            } catch (_) { /* no catalog: numbers and names learned from the device */ }
        }
        if (!Object.keys(names).length) return;
        this.presetCatalogs.set(key, names);
        if (Object.keys(groups).length) this.presetGroups.set(key, groups);
        this.refreshPresetLabels();
    }

    // Presets (0-based programs) of a device that belong to a group; every program for "All" or when groups are unknown.
    programsInGroup(baseKey, group, count = this.presetCounts.get(baseKey) || 128, favoritesOnly = false) {
        const groups = this.presetGroups.get(baseKey);
        let list = Array.from({ length: count }, (_, index) => index);
        if (group && groups) list = list.filter(index => groups[String(index + 1)] === group);
        const starred = favoritesOnly ? this.favorites.get(this.presetFiles.get(baseKey)) : null;
        return favoritesOnly ? list.filter(index => starred?.has(index + 1)) : list;
    }

    // The router sent the starred presets of a device map (on connect, and whenever anyone changes them).
    updateFavorites({ file, numbers }) {
        this.favorites.set(file, new Set(numbers || []));
        this.favoritesVersion++;
        this.refreshPresetLabels();
    }

    // Preset controls of an instrument without presets: group and preset drop-downs over the sounds the user
    // saved (a sound is the CCs touched since it was last cleared), with save, delete and clear buttons.
    _fillUserPresetControls(presets, el, dev, part, label, file) {
        const unitKey = this.unitKey(dev, part);
        const channel = () => this.channelForDevice(dev, part);
        const chosenKey = () => `${dev.id}:${channel()}`;
        const online = () => {
            if (window.app?.ws?.readyState === WebSocket.OPEN) return true;
            window.app?.log?.('Connect to the router to use presets.');
            return false;
        };
        const group = document.createElement('select');
        group.className = 'user-preset-group';
        group.dataset.file = file;
        group.setAttribute('aria-label', `${label} preset group`);
        group.title = 'Show only presets of this group';
        const storage = `user-preset-group:${unitKey}`;
        try { group.dataset.group = localStorage.getItem(storage) || ''; } catch { /* storage unavailable */ }
        const name = document.createElement('select');
        name.className = 'user-preset-name';
        name.dataset.file = file;
        name.setAttribute('aria-label', `${label} preset`);
        name.title = 'Your saved sounds for this instrument';
        name.chosenKey = chosenKey;
        name.dataset.group = group.dataset.group || '';
        group.addEventListener('change', () => {
            group.dataset.group = group.value;
            name.dataset.group = group.value;
            try { localStorage.setItem(storage, group.value); } catch { /* optional */ }
            this.refreshUserPresets();
        });
        name.addEventListener('change', () => {
            if (name.value === '' || !online()) { this.refreshUserPresets(); return; }
            this.userPresetChosen.set(chosenKey(), name.value);
            window.app.ws.send(JSON.stringify({ type: 'user-preset-load', file, target: dev.id, channel: channel(), id: name.value }));
        });
        const button = (text, title, onClick, className = '') => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.title = title;
            if (className) b.className = className;
            b.setAttribute('aria-label', `${label}: ${title}`);
            b.addEventListener('click', onClick);
            return b;
        };
        const current = () => this.userPresets.get(file)?.[this.userPresetChosen.get(chosenKey())];
        const save = button('💾', 'Save the controls you moved as a preset', () => {
            if (!online()) return;
            const presetName = window.prompt('Preset name', current()?.name || '');
            if (!presetName?.trim()) return;
            const presetGroup = window.prompt('Group (for example Pad, Bass, FX)', current()?.group || group.dataset.group || 'Misc');
            if (presetGroup === null) return;
            this._pendingUserPreset = { file, key: chosenKey(), name: presetName.trim().toLowerCase() };
            window.app.ws.send(JSON.stringify({ type: 'user-preset-save', file, target: dev.id, channel: channel(), name: presetName, group: presetGroup }));
        });
        const remove = button('🗑', 'Delete the selected preset', () => {
            const id = this.userPresetChosen.get(chosenKey()) || name.value;
            const preset = this.userPresets.get(file)?.[id];
            if (!preset || !online() || !window.confirm(`Delete preset "${preset.name}"?`)) return;
            this.userPresetChosen.delete(chosenKey());
            window.app.ws.send(JSON.stringify({ type: 'user-preset-delete', file, id }));
        });
        const clear = button('↺', 'Forget the controls moved so far: the next preset you save starts from nothing', () => {
            if (!online()) return;
            window.app.ws.send(JSON.stringify({ type: 'user-preset-clear', target: dev.id, channel: channel() }));
            this._discardControls(el, dev, part);
        }, 'device-program-reset');
        for (const child of [group, name, save, remove, clear]) presets.appendChild(child);
        this.refreshUserPresets();
    }

    // The saved presets of an instrument changed (saved, deleted, or sent on connect).
    updateUserPresets({ file, presets }) {
        this.userPresets.set(file, presets || {});
        const pending = this._pendingUserPreset;
        if (pending?.file === file) {
            const id = Object.keys(presets || {}).find(key => presets[key].name.toLowerCase() === pending.name);
            if (id) this.userPresetChosen.set(pending.key, id);
            this._pendingUserPreset = null;
        }
        this.refreshUserPresets();
    }

    refreshUserPresets() {
        document.querySelectorAll?.('.user-preset-group').forEach(select => {
            const saved = this.userPresets.get(select.dataset.file) || {};
            const groups = [...new Set(Object.values(saved).map(preset => preset.group))].sort((a, b) => a.localeCompare(b));
            if (select.dataset.group && !groups.includes(select.dataset.group)) select.dataset.group = '';
            select.replaceChildren(new Option('All', ''), ...groups.map(groupName => new Option(groupName, groupName)));
            select.value = select.dataset.group || '';
            select.hidden = groups.length === 0;
        });
        document.querySelectorAll?.('.user-preset-name').forEach(select => {
            const saved = this.userPresets.get(select.dataset.file) || {};
            const group = select.dataset.group || '';
            const shown = Object.keys(saved).filter(id => !group || saved[id].group === group)
                .sort((a, b) => saved[a].name.localeCompare(saved[b].name));
            select.replaceChildren(new Option(shown.length ? '—' : 'No saved presets', ''), ...shown.map(id => new Option(saved[id].name, id)));
            const chosen = this.userPresetChosen.get(select.chosenKey?.());
            select.value = chosen && shown.includes(chosen) ? chosen : '';   // a preset outside the shown group is not listed
        });
    }

    // The device sent a preset name: it replaces what the list showed for that preset.
    updateLearnedPreset({ file, program, name }) {
        if (typeof name !== 'string' || !name) return;
        for (const [key, deviceFile] of this.presetFiles) {
            if (deviceFile !== file) continue;
            (this.presetCatalogs.get(key) || this.presetCatalogs.set(key, {}).get(key))[String(program + 1)] = name;
            for (const entry of [...this.presetNames.keys()]) {
                if (entry.startsWith(`${key}:`) && entry.endsWith(`:${program}`)) this.presetNames.delete(entry);
            }
        }
        this.refreshPresetLabels();
    }

    updatePresetName({ target, channel, program, name }) {
        const device = this.outputs.find(d => d.id === target);
        if (!device || typeof name !== 'string') return;
        const key = `${deviceChannelKey(device.name)}:${channel}`;
        if (this.programs.get(key) !== program) return;
        this.presetNames.set(`${key}:${program}`, name);
        this.refreshPresetLabels();
    }

    // Controls restored by loading a session: replace the remembered values (raw CC bytes).
    updateDeviceControls(controls, revision) {
        if (revision === this._controlsRevision) return;
        const first = this._controlsRevision === undefined;
        this._controlsRevision = revision;
        this._controlValues.clear();
        for (const { target, channel, cc, value } of controls || []) this._controlValues.set(`${target}:${channel}:${cc}`, value);
        if (!first) this.render();   // closes open panels; reopening shows the loaded values
    }

    // NRPN values from the server (saved session, MCP): remember the changed ones and move the matching
    // knobs of open panels without sending any MIDI.
    updateDeviceNrpns(nrpns) {
        for (const { target, channel, nrpn, raw } of nrpns || []) {
            const key = `${target}:${channel}:${nrpn}`;
            if (this._nrpnSeen.get(key) === raw) continue;
            this._nrpnSeen.set(key, raw);
            this._nrpnValues.set(key, raw);
            for (const panel of document.querySelectorAll?.('.synth-controls[data-device-id]') || []) {
                if (panel.dataset.deviceId !== target || this.channelForKey(panel.dataset.unitKey, panel.dataset.part) !== channel) continue;
                for (const input of panel.querySelectorAll(`[data-nrpn="${Number(nrpn)}"]`)) {
                    const display = nativeFromNrpn(input.dataset, raw);
                    if (input.type !== 'range' || input === document.activeElement) continue;
                    input.value = String(display);
                    input.dispatchEvent(new Event('knob-sync'));
                }
                this._syncWidgets(panel, pair => Number(pair.nrpn) === Number(nrpn));
            }
        }
    }

    // The "cc:nrpn" pairs a graph (nrpn-widgets.js) draws.
    _widgetPairs(widget) {
        return (widget.dataset.pairs || '').split(' ').filter(Boolean).map(token => { const [cc, nrpn] = token.split(':'); return { cc: cc === '' ? undefined : cc, nrpn: nrpn === '' ? undefined : nrpn }; });
    }

    // Tell the graphs of a panel that draw a changed parameter to redraw (they send nothing).
    _syncWidgets(panel, matches) {
        for (const widget of panel.querySelectorAll('.nrpn-widget[data-pairs]')) {
            if (this._widgetPairs(widget).some(matches)) widget.dispatchEvent(new Event('widget-sync'));
        }
    }

    // A control changed from elsewhere (another browser or the MCP server): remember the raw
    // value and move the matching widget in an open panel without sending any MIDI.
    applyRemoteControl({ target, channel, cc, value }) {
        this._controlValues.set(`${target}:${channel}:${cc}`, value);
        for (const panel of document.querySelectorAll?.('.synth-controls[data-device-id]') || []) {
            const nrpn = panel.querySelector(`[data-cc="${Number(cc)}"]`)?.dataset.nrpn
                ?? [...panel.querySelectorAll('.nrpn-widget[data-pairs]')].flatMap(widget => this._widgetPairs(widget)).find(pair => Number(pair.cc) === Number(cc))?.nrpn;
            if (nrpn !== undefined) for (const map of [this._nrpnValues, this._nrpnSeen]) map.delete(`${target}:${channel}:${nrpn}`);
        }
        for (const panel of document.querySelectorAll?.('.synth-controls[data-device-id]') || []) {
            if (panel.dataset.deviceId !== target || this.channelForKey(panel.dataset.unitKey, panel.dataset.part) !== channel) continue;
            this._syncWidgets(panel, pair => Number(pair.cc) === Number(cc));
            for (const input of panel.querySelectorAll(`[data-cc="${Number(cc)}"]`)) {
                const min = Number(input.dataset.min || 0);
                const display = input.dataset.nrpn !== undefined ? nativeFromCc(input.dataset, value) : value - (min < 0 ? -min : 0);
                if (input.type === 'range') {
                    if (input === document.activeElement) continue;   // the user is dragging it
                    input.value = String(display);
                    input.dispatchEvent(new Event('knob-sync'));
                } else if (input.type === 'checkbox') input.checked = display > 0;
                else if (input.tagName === 'SELECT') input.selectedIndex = dropdownIndex({ min, values: input.dataset.values ? JSON.parse(input.dataset.values) : null }, display);
            }
        }
    }

    updateDevicePresets(presets) {
        this.programs.clear();
        for (const { target, channel, program, name } of presets || []) {
            const key = `${deviceChannelKey(target)}:${channel}`;
            this.programs.set(key, program);
            if (name) this.presetNames.set(`${key}:${program}`, name);   // saved with the session
        }
        this.refreshPresetLabels();
    }

    // The preset drop-down lists every program of the device; a program shows its name when one is
    // known (factory catalog, or reported by the device / saved with the session).
    refreshPresetLabels() {
        document.querySelectorAll?.('.device-program-group').forEach(select => {
            const groups = this.presetGroups.get(select.dataset.baseKey);
            select.hidden = !groups;
            if (!groups || select.dataset.filled === String(Object.keys(groups).length)) return;
            select.dataset.filled = String(Object.keys(groups).length);
            const names = [...new Set(Object.values(groups))].sort((a, b) => a.localeCompare(b));
            select.replaceChildren(new Option('All', ''), ...names.map(name => new Option(name, name)));
            select.value = select.dataset.group || '';
        });
        document.querySelectorAll?.('.device-program-name').forEach(select => {
            const baseKey = select.dataset.baseKey || select.dataset.deviceKey;
            const key = `${baseKey}:${this.channelForKey(select.dataset.deviceKey, select.dataset.part)}`;
            const program = this.programs.get(key);
            const count = this.presetCounts.get(baseKey) || 128;
            const groups = this.presetGroups.get(baseKey);
            const group = groups ? select.dataset.group || '' : '';
            const favoritesOnly = select.dataset.favorites === '1';
            const shown = this.programsInGroup(baseKey, group, count, favoritesOnly);
            const signature = `${count}|${group}|${favoritesOnly}|${this.favoritesVersion}|${shown.length}|${shown[0]}|${shown[shown.length - 1]}`;
            if (select._signature !== signature) {
                select._signature = signature;
                select.replaceChildren();
                const none = document.createElement('option');
                none.value = '';
                none.textContent = '—';
                select.appendChild(none);
                for (const index of shown) {
                    const option = document.createElement('option');
                    option.value = String(index);
                    select.appendChild(option);
                }
            }
            const catalog = this.presetCatalogs.get(baseKey) || {};
            shown.forEach((index, position) => {
                const name = this.presetNames.get(`${key}:${index}`) || catalog[String(index + 1)];
                const text = name ? `${index + 1} · ${name}` : String(index + 1);
                if (select.children[position + 1].textContent !== text) select.children[position + 1].textContent = text;
            });
            select.value = program == null || !shown.includes(program) ? '' : String(program);   // a preset outside the shown group is not listed
            if (select._star) {
                const starred = program != null && this.favorites.get(this.presetFiles.get(baseKey))?.has(program + 1);
                select._star.textContent = starred ? '★' : '☆';
                select._star.className = starred ? 'device-program-star starred' : 'device-program-star';
                select._star.setAttribute('aria-pressed', String(!!starred));
                select._star.title = starred ? 'Remove this preset from favorites' : 'Add this preset to favorites';
            }
            select.title = program == null ? 'Select a preset' : program > 127 ? `Preset ${program + 1} (bank ${(program >> 7) + 1}, program ${(program & 127) + 1})` : `Preset ${program + 1}`;
        });
    }

    updateChannels(channels) {
        const parts = obj => Object.keys(obj).filter(key => key.includes('#')).sort().join();
        const partsChanged = parts(this.channels) !== parts(channels);
        this.channels = { ...channels };
        if (partsChanged) this.render();   // a part was added or removed
        document.querySelectorAll?.('.device-midi-channel').forEach(select => {
            select.value = String(this.channels[select.dataset.deviceKey] || 1);
        });
        this.refreshPresetLabels();
    }

    channelForDevice(device, part) {
        return this.channelForKey(this.unitKey(device, part), part);
    }

    // Channel saved for a device, or for one part of a multitimbral device (default: part N on channel N).
    channelForKey(key, part) {
        const channel = this.channels[key];
        return validMidiChannel(channel) ? channel : (Number(part) || 1);
    }

    unitKey(device, part) {
        return part ? `${deviceChannelKey(device.name)}#${part}` : deviceChannelKey(device.name);
    }

    // Parts that exist for a multitimbral device (those with a saved channel), in order.
    partsOf(device) {
        const prefix = `${deviceChannelKey(device.name)}#`;
        return Object.keys(this.channels).filter(key => key.startsWith(prefix))
            .map(key => Number(key.slice(prefix.length))).filter(part => part >= 1 && part <= 16).sort((a, b) => a - b);
    }

    /** Refresh the port list */
    updatePorts(inputs, outputs) {
        this.inputs = uniquePorts(inputs);
        this.outputs = uniquePorts(outputs);
        this._notifyChange();
        this.render();
    }

    /** Get all devices */
    getAllDevices() {
        return connectedDevices(this.inputs, this.outputs);
    }

    /** Get a device by ID */
    getDeviceById(id) {
        return this.inputs.find(d => d.id === id) || this.outputs.find(d => d.id === id);
    }

    /**
     * Rendering devices: one flat list of all MIDI ports (inputs + outputs).
     * The device name is clickable: a click expands a panel with its parameters
     * (synth controls from device_maps) or a placeholder for unknown devices.
     */
    render() {
        const deviceList = document.getElementById('device-list');
        if (!deviceList) return;

        deviceList.innerHTML = '';
        for (const dev of this.getAllDevices()) {

            const el = document.createElement('div');
            el.className = 'device-item connected';

            const nameEl = document.createElement('button');
            nameEl.type = 'button';
            nameEl.className = 'device-item-name';
            nameEl.textContent = dev.displayName;
            nameEl.title = `${dev.name} · ${dev.input && dev.output ? 'Input / Output' : dev.output ? 'Output' : 'Input'}`;
            nameEl.setAttribute('aria-expanded', 'false');
            el.appendChild(nameEl);

            const model = classifySynthPortName(dev.name).model;
            if (dev.output && MULTITIMBRAL_PARTS[model]) {
                // One card for the instrument; its parts are separate cards with their own controls and channels.
                el.className += ' device-group';
                nameEl.setAttribute('aria-expanded', 'true');
                this._renderParts(el, nameEl, dev, MULTITIMBRAL_PARTS[model]);
            } else {
                nameEl.addEventListener('click', () => this._toggleDevicePanel(dev, el, nameEl));
                if (dev.output && model) this._appendUnitControls(el, dev);
                else {
                    const tag = document.createElement('span');
                    tag.className = 'device-controller-tag';
                    tag.textContent = 'Controller';
                    el.appendChild(tag);
                }
            }
            deviceList.appendChild(el);
        }
        this.refreshPresetLabels();
    }

    _renderParts(group, nameEl, dev, maxParts) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'device-part-add';
        add.textContent = '+ Add part';
        add.title = `Add a part (up to ${maxParts}); part N starts on MIDI channel N`;
        const list = document.createElement('div');
        list.className = 'device-parts';
        const parts = this.partsOf(dev);
        add.disabled = parts.length >= maxParts;
        add.addEventListener('click', () => {
            if (window.app?.ws?.readyState !== WebSocket.OPEN) {
                window.app?.log?.('Connect to the router to add a part.');
                return;
            }
            const next = Array.from({ length: maxParts }, (_, i) => i + 1).find(part => !this.partsOf(dev).includes(part));
            if (next) window.app.ws.send(JSON.stringify({ type: 'set-device-part', target: dev.id, part: next, channel: next }));
        });
        nameEl.addEventListener('click', () => {
            const open = list.hidden;
            list.hidden = !open;
            nameEl.setAttribute('aria-expanded', String(open));
        });
        group.appendChild(add);
        if (!parts.length) {
            const empty = document.createElement('div');
            empty.className = 'synth-controls-message';
            empty.textContent = 'No parts yet. Add one for each part you use; each part has its own MIDI channel, preset and controls.';
            list.appendChild(empty);
        }
        for (const part of parts) {
            const card = document.createElement('div');
            card.className = 'device-item device-part connected';
            const partName = document.createElement('button');
            partName.type = 'button';
            partName.className = 'device-item-name';
            partName.textContent = `Part ${part}`;
            partName.title = `${dev.displayName} · part ${part}`;
            partName.setAttribute('aria-expanded', 'false');
            partName.addEventListener('click', () => this._toggleDevicePanel(dev, card, partName, part));
            card.appendChild(partName);
            this._appendUnitControls(card, dev, part);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'device-part-remove';
            remove.textContent = '×';
            remove.title = `Remove part ${part}`;
            remove.setAttribute('aria-label', `${dev.displayName}: remove part ${part}`);
            remove.addEventListener('click', () => {
                if (window.app?.ws?.readyState === WebSocket.OPEN) window.app.ws.send(JSON.stringify({ type: 'remove-device-part', target: dev.id, part }));
            });
            card.appendChild(remove);
            list.appendChild(card);
        }
        group.appendChild(list);
    }

    // Preset ‹ › buttons with the preset name, and the MIDI channel selector, for a device
    // or for one part of a multitimbral device.
    // A new or reloaded sound replaces every knob tweak: forget the remembered values and put every
    // control of an open panel back to its start position (nothing is sent to the synth).
    _discardControls(el, dev, part) {
        const prefix = `${dev.id}:${this.channelForDevice(dev, part)}:`;
        for (const key of [...this._controlValues.keys()]) if (key.startsWith(prefix)) this._controlValues.delete(key);
        // The router reads the reloaded patch back; its NRPN values must reach the knobs even when they equal the old ones.
        for (const map of [this._nrpnValues, this._nrpnSeen]) for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
        const panel = el.querySelector('.synth-controls');
        if (!panel) return;
        for (const input of panel.querySelectorAll('[data-cc]')) {
            if (input.type === 'range') {
                input.value = input.dataset.start ?? input.min;
                input.dispatchEvent(new Event('knob-sync'));
            } else if (input.type === 'checkbox') input.checked = false;
            else if (input.tagName === 'SELECT') input.selectedIndex = 0;
        }
        for (const widget of panel.querySelectorAll('.synth-widget')) widget.dispatchEvent(new Event('widget-sync'));
    }

    _appendUnitControls(el, dev, part) {
        const label = part ? `${dev.displayName} part ${part}` : dev.displayName;
        const unitKey = this.unitKey(dev, part);
        const baseKey = deviceChannelKey(dev.name);
        this.loadPresetCount(dev);
        this.loadPresetCatalog(dev);
        const presets = document.createElement('div');
        presets.className = 'device-program-controls';
        const userPresetFile = USER_PRESET_FILES[classifySynthPortName(dev.name).model];
        if (userPresetFile) this._fillUserPresetControls(presets, el, dev, part, label, userPresetFile);
        else {
            const groupSelect = document.createElement('select');
            groupSelect.className = 'device-program-group';
            groupSelect.dataset.baseKey = baseKey;
            groupSelect.hidden = true;   // shown once the device's catalog has sound groups
            groupSelect.setAttribute('aria-label', `${label} preset group`);
            groupSelect.title = 'Show only presets of this sound group';
            const groupStorage = `preset-group:${unitKey}`;
            try { groupSelect.dataset.group = localStorage.getItem(groupStorage) || ''; } catch { /* storage unavailable */ }
            const presetLabel = document.createElement('select');
            presetLabel.className = 'device-program-name';
            presetLabel.dataset.deviceKey = unitKey;
            presetLabel.dataset.baseKey = baseKey;
            if (part) presetLabel.dataset.part = String(part);
            presetLabel.setAttribute('aria-label', `${label} preset`);
            const programKey = () => `${baseKey}:${this.channelForDevice(dev, part)}`;
            const selectProgram = program => {
                if (window.app?.ws?.readyState !== WebSocket.OPEN) { this.refreshPresetLabels(); return; }
                const key = programKey();
                window.app.ws.send(JSON.stringify({ type: 'select-preset', target: dev.id, channel: this.channelForDevice(dev, part), index: program }));
                this.programs.set(key, program);
                // Clear cached names until this selection is confirmed by the device.
                this.presetNames.delete(`${key}:${program}`);
                this.refreshPresetLabels();
                this._discardControls(el, dev, part);
                presets.title = `Last requested preset: ${program + 1}`;
            };
            groupSelect.addEventListener('change', () => {
                groupSelect.dataset.group = groupSelect.value;
                presetLabel.dataset.group = groupSelect.value;
                try { localStorage.setItem(groupStorage, groupSelect.value); } catch { /* optional */ }
                this.refreshPresetLabels();
            });
            presetLabel.dataset.group = groupSelect.dataset.group || '';
            const favoritesStorage = `preset-favorites:${unitKey}`;
            const favoritesOnly = document.createElement('button');
            favoritesOnly.type = 'button';
            favoritesOnly.className = 'device-program-favorites';
            favoritesOnly.setAttribute('aria-label', `${label}: only favorite presets`);
            const showFavoritesOnly = on => {
                presetLabel.dataset.favorites = on ? '1' : '';
                favoritesOnly.textContent = on ? '★' : '☆';
                favoritesOnly.className = on ? 'device-program-favorites starred' : 'device-program-favorites';
                favoritesOnly.setAttribute('aria-pressed', String(on));
                favoritesOnly.title = on ? 'Showing only favorite presets: click to show all' : 'Show only favorite presets in the lists';
            };
            try { showFavoritesOnly(localStorage.getItem(favoritesStorage) === '1'); } catch { showFavoritesOnly(false); }
            favoritesOnly.addEventListener('click', () => {
                const on = presetLabel.dataset.favorites !== '1';
                showFavoritesOnly(on);
                try { localStorage.setItem(favoritesStorage, on ? '1' : '0'); } catch { /* optional */ }
                this.refreshPresetLabels();
            });
            const star = document.createElement('button');
            star.type = 'button';
            star.className = 'device-program-star';
            star.textContent = '☆';
            star.setAttribute('aria-label', `${label}: favorite preset`);
            star.addEventListener('click', () => {
                const program = this.programs.get(programKey());
                const file = this.presetFiles.get(baseKey);
                if (program == null || !file) { window.app?.log?.('Pick a preset first, then star it.'); return; }
                if (window.app?.ws?.readyState !== WebSocket.OPEN) { window.app?.log?.('Connect to the router to change favorites.'); return; }
                window.app.ws.send(JSON.stringify({ type: 'favorite-set', file, number: program + 1, favorite: !this.favorites.get(file)?.has(program + 1) }));
            });
            presetLabel._star = star;
            presetLabel.addEventListener('change', () => {
                const program = Number(presetLabel.value);
                if (presetLabel.value !== '' && Number.isInteger(program)) selectProgram(program);
            });
            presets.appendChild(favoritesOnly);
            presets.appendChild(groupSelect);
            for (const [text, step, description] of [['‹', -1, 'Previous preset'], ['›', 1, 'Next preset']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = text;
                button.title = `${description} (${step > 0 ? '+1' : '−1'})`;
                button.setAttribute('aria-label', `${label}: ${description}`);
                button.addEventListener('click', () => {
                    if (window.app?.ws?.readyState !== WebSocket.OPEN) return;
                    const list = this.programsInGroup(baseKey, presetLabel.dataset.group, undefined, presetLabel.dataset.favorites === '1');
                    const current = this.programs.get(programKey()) ?? 0;
                    const next = (step > 0 ? list.find(index => index > current) : [...list].reverse().find(index => index < current)) ?? (step > 0 ? list.at(-1) : list[0]);
                    if (next != null) selectProgram(next);
                });
                if (step > 0) presets.appendChild(presetLabel);
                presets.appendChild(button);
            }
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'device-program-reset';
            reset.textContent = '↺';
            reset.title = 'Reload this preset and discard all knob changes';
            reset.setAttribute('aria-label', `${label}: reload preset, discard changes`);
            reset.addEventListener('click', async () => {
                if (window.app?.ws?.readyState !== WebSocket.OPEN) return;
                const channelNumber = this.channelForDevice(dev, part);
                const program = this.programs.get(programKey());
                if (program == null) window.app?.log?.('No preset selected on this channel yet: pick one from the list first, then ↺ can reload it.');
                window.app.ws.send(JSON.stringify({ type: 'select-preset', target: dev.id, channel: channelNumber, index: program ?? 0, reset: true, reloadPreset: program != null }));
                this._discardControls(el, dev, part);
            });
            presets.appendChild(star);
            presets.appendChild(reset);
        }
        el.appendChild(presets);
        const channel = document.createElement('select');
        channel.className = 'device-midi-channel';
        channel.dataset.deviceKey = unitKey;
        channel.setAttribute('aria-label', `${label} MIDI channel`);
        channel.title = 'Match the instrument’s MIDI receive channel';
        for (let number = 1; number <= 16; number++) {
            const option = document.createElement('option');
            option.value = String(number);
            option.textContent = `Ch ${number}`;
            channel.appendChild(option);
        }
        channel.value = String(this.channelForDevice(dev, part));
        channel.addEventListener('change', () => {
            const value = Number(channel.value);
            if (!validMidiChannel(value)) return;
            if (window.app?.ws?.readyState === WebSocket.OPEN) {
                this.channels[unitKey] = value;
                this.refreshPresetLabels();
                window.app.ws.send(JSON.stringify(part
                    ? { type: 'set-device-part', target: dev.id, part, channel: value }
                    : { type: 'set-device-channel', target: dev.id, channel: value }));
            } else {
                channel.value = String(this.channelForDevice(dev, part));
                window.app?.log?.('Connect to the router to save the MIDI channel.');
            }
        });
        el.appendChild(channel);
    }

    async _toggleDevicePanel(device, itemElement, nameButton, part) {
        const current = itemElement.querySelector('.synth-controls');
        if (current) {
            current.remove();
            nameButton.setAttribute('aria-expanded', 'false');
            return;
        }

        const { model } = classifySynthPortName(device.name);
        const panel = document.createElement('div');
        panel.className = 'synth-controls';
        panel.setAttribute('aria-label', `${device.name} controls`);
        panel.dataset.deviceId = device.id;
        panel.dataset.unitKey = this.unitKey(device, part);
        if (part) panel.dataset.part = String(part);
        itemElement.appendChild(panel);
        nameButton.setAttribute('aria-expanded', 'true');

        if (!model || !device.output) {
            const message = document.createElement('div');
            message.className = 'synth-controls-message';
            message.textContent = !device.output
                ? 'Input-only port. A MIDI output is needed to control this instrument.'
                : 'No parameter controls available for this device.';
            panel.appendChild(message);
            return;
        }

        const loading = document.createElement('div');
        loading.className = 'synth-controls-message';
        loading.textContent = 'Loading controls…';
        panel.appendChild(loading);

        try {
            let definitions = this._synthControlCache.get(model);
            if (!definitions) {
                definitions = getControlsForModel(model);
                this._synthControlCache.set(model, definitions);
            }
            const controls = await definitions;
            if (!itemElement.contains(panel)) return;
            if (!controls || controls.length === 0) {
                this._synthControlCache.delete(model);
                throw new Error('Control map is empty or unavailable.');
            }
            panel.replaceChildren();
            const send = (definition, value) => {
                const bytes = buildMidiCcBytes(model, definition.cc, value, definition);
                this._controlValues.set(`${device.id}:${this.channelForDevice(device, part)}:${definition.cc}`, bytes[2]);
                if (definition.nrpn !== undefined) for (const map of [this._nrpnValues, this._nrpnSeen]) map.delete(`${device.id}:${this.channelForDevice(device, part)}:${definition.nrpn}`);
                this.sendMidi(device.id, bytes, part);
            };
            const saved = definition => {
                const fromNrpn = this._savedFromNrpn(device.id, this.channelForDevice(device, part), definition);
                if (fromNrpn !== undefined) return fromNrpn;
                const raw = this._controlValues.get(`${device.id}:${this.channelForDevice(device, part)}:${definition.cc}`);
                return raw === undefined ? undefined : raw - (Number(definition.min) < 0 ? -Number(definition.min) : 0);
            };
            // Values of NRPN parameters in their own units, for the graphs that draw them.
            const changeListeners = new Set();
            const io = {
                get: definition => {
                    const channelNumber = this.channelForDevice(device, part);
                    const raw = definition.nrpn === undefined ? undefined : this._nrpnValues.get(`${device.id}:${channelNumber}:${definition.nrpn}`);
                    if (raw !== undefined) return nativeFromNrpn(definition, raw);
                    const cc = this._controlValues.get(`${device.id}:${channelNumber}:${definition.cc}`);
                    if (cc === undefined) return undefined;
                    return definition.nrpn === undefined ? cc : nativeFromCc(definition, cc);
                },
                // A real knob for a control, for graphs that host knobs (the modulation matrix).
                knob: definition => this._createDeviceControl(device, model, definition, part),
                // A control with no NRPN (the carriers' shared envelope) is sent as its CC.
                set: (definition, value) => {
                    if (definition.nrpn === undefined) send(definition, value);
                    else this.sendNrpn(device.id, this.channelForDevice(device, part), definition.nrpn, rawFromNative(definition, value));
                    for (const listener of changeListeners) listener(definition, value);
                },
                // Graphs that depend on another control (the operator names on the algorithm) hear about its changes here.
                onChange: listener => { changeListeners.add(listener); },
            };
            // Graphs first, then the remaining controls as knobs.
            const fill = (grid, widgets, rest) => {
                for (const plan of widgets) {
                    if (plan.kind === 'xy') grid.appendChild(createXYPad(plan, send, saved));
                    else if (plan.kind === 'adsr') grid.appendChild(createAdsrGraph(plan, send, saved));
                    else grid.appendChild(createNrpnWidget(plan, io));
                }
                for (const definition of rest) grid.appendChild(this._createDeviceControl(device, model, definition, part));
            };
            const stages = controls.layout ? buildStages(controls, controls.layout) : null;
            if (stages?.length) {
                panel.className += ' synth-staged';
                stages.forEach((stage, index) => {
                    // Each stage folds away and starts collapsed.
                    const section = document.createElement('details');
                    section.className = 'synth-stage';
                    section.open = false;
                    const head = document.createElement('summary');
                    head.className = 'synth-stage-title';
                    head.textContent = `${index + 1} · ${stage.title}`;
                    section.appendChild(head);
                    const modules = document.createElement('div');
                    modules.className = 'synth-modules';
                    section.appendChild(modules);
                    for (const module of stage.modules) {
                        const card = document.createElement('div');
                        card.className = 'synth-module';
                        const title = document.createElement('h5');
                        title.textContent = module.title;
                        card.appendChild(title);
                        const moduleControls = module.groups.flatMap(group => group.controls);
                        const drawn = planNrpnWidgets(moduleControls, controls.algorithms, controls.nrpnParams, controls.find(control => control.name === 'Algorithm'));
                        const basic = planWidgets(moduleControls.filter(control => !drawn.used.has(control)));
                        const widgets = [...drawn.widgets, ...basic.widgets];
                        const rest = basic.rest;
                        // The modulation matrix and the LFO plots (side by side) take the whole width of the section.
                        if (module.full || drawn.widgets.some(plan => plan.kind === 'matrix' || plan.kind === 'lfo-plots')) card.className += ' synth-module-full';
                        if (widgets.length) {
                            const grid = document.createElement('div');
                            grid.className = `synth-control-grid synth-module-widgets${drawn.widgets.length ? ' synth-module-widgets-wide' : ''}`;
                            fill(grid, widgets, []);
                            card.appendChild(grid);
                        }
                        for (const group of module.groups) {
                            const own = group.controls.filter(control => rest.includes(control));
                            if (!own.length) continue;
                            const wrap = document.createElement('div');
                            wrap.className = 'synth-group';
                            if (group.label) {
                                const label = document.createElement('span');
                                label.className = 'synth-group-label';
                                label.textContent = group.label;
                                wrap.appendChild(label);
                            }
                            const grid = document.createElement('div');
                            grid.className = 'synth-control-grid';
                            fill(grid, [], own);
                            wrap.appendChild(grid);
                            card.appendChild(wrap);
                        }
                        modules.appendChild(card);
                    }
                    panel.appendChild(section);
                });
            } else {
                for (const { label, controls: sectionControls } of groupSynthControls(controls)) {
                    const section = document.createElement('section');
                    section.className = 'synth-control-section';
                    const heading = document.createElement('h5');
                    heading.textContent = label;
                    section.appendChild(heading);
                    const group = document.createElement('div');
                    group.className = 'synth-control-grid';
                    section.appendChild(group);
                    panel.appendChild(section);
                    const { widgets, rest } = planWidgets(sectionControls);
                    fill(group, widgets, rest);
                }
            }
        } catch (error) {
            this._synthControlCache.delete(model);
            if (!itemElement.contains(panel)) return;
            panel.replaceChildren();
            const message = document.createElement('div');
            message.className = 'synth-controls-message error';
            message.setAttribute('role', 'alert');
            message.textContent = 'Could not load device controls. Try again.';
            panel.appendChild(message);
            console.error(`Failed to load controls for ${model}:`, error);
        }
    }

    // The knob position (CC 0-127) of a control that mirrors an NRPN parameter, from the NRPN value the
    // device was last given; undefined when none is known.
    _savedFromNrpn(deviceId, channel, definition) {
        if (definition.nrpn === undefined) return undefined;
        const raw = this._nrpnValues.get(`${deviceId}:${channel}:${definition.nrpn}`);
        return raw === undefined ? undefined : ccFromNrpn(definition, raw);
    }

    // Knobs of controls that mirror an NRPN run over the parameter's own range and send the NRPN.
    _nrpnKnob(definition, instruction) {
        return definition.nrpn !== undefined && instruction.attrs.type === 'range';
    }

    sendNrpn(deviceId, channel, nrpn, raw) {
        const key = `${deviceId}:${channel}:${nrpn}`;
        this._nrpnValues.set(key, raw);
        this._nrpnSeen.set(key, raw);
        if (window.app?.ws?.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify({ type: 'nrpn-send', target: deviceId, channel, writes: [{ nrpn, raw }] }));
        }
    }

    _createDeviceControl(device, model, definition, part) {
        const instruction = renderControlDefinition(definition);
        const row = document.createElement('label');
        row.className = 'synth-control';
        const title = document.createElement('span');
        title.className = 'synth-control-name';
        title.textContent = instruction.label.text;
        row.appendChild(title);

        let input;
        if (instruction.tag === 'select') {
            input = document.createElement('select');
            for (const optionText of instruction.options || []) {
                const option = document.createElement('option');
                option.textContent = String(optionText);
                input.appendChild(option);
            }
        } else if (instruction.tag === 'input') {
            input = document.createElement('input');
            input.type = instruction.attrs.type;
            if (input.type === 'range') {
                input.min = instruction.attrs.min;
                input.max = instruction.attrs.max;
                input.value = instruction.attrs.value;
            }
        } else {
            return row;
        }

        input.dataset.cc = String(definition.cc);
        if (definition.nrpn !== undefined) {
            input.dataset.nrpn = String(definition.nrpn);
            input.dataset.nrpnMin = String(definition.nrpnMin);
            input.dataset.nrpnMax = String(definition.nrpnMax);
            if (definition.nrpnScale) input.dataset.nrpnScale = String(definition.nrpnScale);
            if (this._nrpnKnob(definition, instruction)) {
                input.min = String(definition.nrpnMin);
                input.max = String(definition.nrpnMax);
                input.step = String(definition.nrpnScale ? 1 / definition.nrpnScale : 1);
                input.value = String(definition.nrpnMin);
            }
        }
        input.dataset.min = String(definition.min ?? 0);
        if (input.type === 'range') input.dataset.start = input.value;
        input.setAttribute('aria-label', instruction.label.text);
        if (input.type === 'checkbox') {
            input.checked = false;
        }
        const valueKey = () => `${device.id}:${this.channelForDevice(device, part)}:${definition.cc}`;
        const rawSaved = this._controlValues.get(valueKey());
        const nrpnKnob = this._nrpnKnob(definition, instruction);
        const rawNrpn = nrpnKnob ? this._nrpnValues.get(`${device.id}:${this.channelForDevice(device, part)}:${definition.nrpn}`) : undefined;
        const savedValue = nrpnKnob
            ? (rawNrpn !== undefined ? nativeFromNrpn(definition, rawNrpn) : rawSaved === undefined ? undefined : nativeFromCc(definition, rawSaved))
            : rawSaved === undefined ? undefined : rawSaved - (Number(definition.min) < 0 ? -Number(definition.min) : 0);
        const sendValue = value => {
            if (nrpnKnob) {
                this.sendNrpn(device.id, this.channelForDevice(device, part), definition.nrpn, rawFromNative(definition, value));
                return;
            }
            const bytes = buildMidiCcBytes(model, definition.cc, value, definition);
            this._controlValues.set(valueKey(), bytes[2]);
            if (definition.nrpn !== undefined) for (const map of [this._nrpnValues, this._nrpnSeen]) map.delete(`${device.id}:${this.channelForDevice(device, part)}:${definition.nrpn}`);
            this.sendMidi(device.id, bytes, part);
        };
        if (savedValue !== undefined) {
            if (input.type === 'range') input.value = String(savedValue);
            else if (input.type === 'checkbox') input.checked = savedValue > 0;
            else input.selectedIndex = dropdownIndex(definition, savedValue);
        }
        if (input.type === 'range') {
            row.className += ' synth-control-knob';
            const dial = document.createElement('span');
            dial.className = 'midi-knob';
            const face = document.createElement('span');
            face.className = 'midi-knob-face';
            face.setAttribute('aria-hidden', 'true');
            dial.appendChild(face);
            input.className = 'midi-knob-input';
            dial.appendChild(input);
            row.appendChild(dial);
            const readout = document.createElement('output');
            readout.className = 'midi-knob-value';
            row.appendChild(readout);
            const center = definition.center == null ? undefined : Number(definition.center);
            if (center !== undefined || Number(definition.min) < 0) dial.className += ' bipolar';
            attachMidiKnob(input, dial, readout, sendValue, { center, reset: definition.default == null ? undefined : Number(definition.default) });
        } else {
            row.className += input.type === 'checkbox' ? ' synth-control-toggle' : ' synth-control-select';
            input.addEventListener('change', () => {
                const value = input.type === 'checkbox'
                    ? (input.checked ? 127 : 0)
                    : dropdownRaw(definition, input.selectedIndex);
                sendValue(value);
            });
            row.appendChild(input);
        }
        const cc = document.createElement('span');
        cc.className = 'synth-control-cc';
        cc.textContent = `CC ${definition.cc}`;
        row.appendChild(cc);
        return row;
    }

    /** Notify about a change */
    _notifyChange() {
        if (this.onStateChange) {
            this.onStateChange({
                type: 'devices',
                inputs: this.inputs,
                outputs: this.outputs
            });
        }
    }

    /** Send a MIDI message */
    sendPerformance(targets, bytes) {
        if (window.app?.ws?.readyState === WebSocket.OPEN) {
            // Stamp the event on the router's clock so recordings ignore network latency.
            const at = Math.round(Date.now() + (window.app.clockOffset || 0));
            window.app.ws.send(JSON.stringify({ type: 'midi-performance', targets, bytes, at }));
        }
    }

    sendMidi(targetId, bytes, part) {
        const device = this.outputs.find(port => port.id === targetId);
        if (device && (bytes[0] & 0xF0) === 0xB0) {
            bytes = [0xB0 | (this.channelForDevice(device, part) - 1), ...bytes.slice(1)];
        }
        if (window.app && window.app.ws && window.app.ws.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify({
                type: 'midi-send',
                data: { bytes, timestamp: Date.now() },
                target: targetId
            }));
        }
    }
}
