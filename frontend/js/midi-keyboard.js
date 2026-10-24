import { noteName } from './piano-roll.js';
import { attachMidiKnob } from './midi-knob.js?v=22';

export class MidiKeyboard {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.held = new Map();
        this.sustained = new Map();
        this.sustain = false;
        this.activePointers = new Set();
        this.section = document.getElementById('midi-keyboard-section');
        if (!this.section) return;
        this.output = document.getElementById('keyboard-output');
        this.output.add(new Option('All', '__all__'));
        this.output.value = '__all__';
        this.channel = document.getElementById('keyboard-channel');
        this.lowC = document.getElementById('keyboard-low-c');
        this.highC = document.getElementById('keyboard-high-c');
        this.velocity = document.getElementById('keyboard-velocity');
        attachMidiKnob(
            this.velocity,
            document.getElementById('keyboard-velocity-dial'),
            document.getElementById('keyboard-velocity-value'),
            () => {},
        );
        this.keys = document.getElementById('keyboard-keys');
        // Safari's long-touch text selection can escape a non-selectable button.
        // Cancel the native touch gesture on keys, while Pointer Events play notes.
        this.keys.addEventListener('touchstart', event => {
            if (event.target.closest('.keyboard-key')) {
                event.preventDefault();
                window.getSelection()?.removeAllRanges();
            }
        }, { passive: false });
        this.keys.addEventListener('selectstart', event => event.preventDefault());
        document.addEventListener('selectstart', event => {
            if (this.activePointers.size) event.preventDefault();
        });
        for (let n = 1; n <= 16; n++) this.channel.add(new Option(`Ch ${n}`, String(n)));
        for (let n = -1; n <= 9; n++) {
            this.lowC.add(new Option(`C${n}`, String(n)));
            this.highC.add(new Option(`C${n}`, String(n)));
        }
        this.lowC.value = '3';
        this.highC.value = '5';
        this.output.addEventListener('change', () => {
            this.releaseAll();
            const device = this.dm.outputs.find(d => d.id === this.output.value);
            if (device) this.channel.value = String(this.dm.channelForDevice(device));
            this.syncRecordingInput();
        });
        this.channel.addEventListener('change', () => { this.releaseAll(); this.syncRecordingInput(); });
        this.lowC.addEventListener('change', () => {
            this.releaseAll();
            if (Number(this.lowC.value) > Number(this.highC.value)) this.highC.value = this.lowC.value;
            this.render();
        });
        this.highC.addEventListener('change', () => {
            this.releaseAll();
            if (Number(this.highC.value) < Number(this.lowC.value)) this.lowC.value = this.highC.value;
            this.render();
        });
        this.sustainButton = document.getElementById('keyboard-sustain');
        this.sustainButton.addEventListener('click', () => this.setSustain(!this.sustain));
        this.section.addEventListener('toggle', () => {
            if (!this.section.open) this.releaseAll();
            this.syncRecordingInput();
        });
        window.addEventListener('blur', () => this.releaseAll());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
        this.render();
    }

    updatePorts() {
        if (!this.section) return;
        const selected = this.output.value;
        this.releaseAll();
        this.output.replaceChildren();
        this.output.add(new Option('All', '__all__'));
        for (const device of this.dm.getAllDevices().filter(d => d.output)) {
            this.output.add(new Option(device.displayName, device.id));
        }
        if (selected === '__all__' || this.dm.outputs.some(d => d.id === selected)) this.output.value = selected;
        else {
            const device = this.dm.outputs.find(d => d.id === this.output.value);
            if (device) this.channel.value = String(this.dm.channelForDevice(device));
        }
        this.render();
        this.syncRecordingInput();
    }

    syncRecordingInput() {
        if (window.app?.ws?.readyState === WebSocket.OPEN) {
            window.app.ws.send(JSON.stringify({ type: 'ui-keyboard-input', active: !!this.section.open, channel: Number(this.channel.value) }));
        }
    }

    press(id, note, button) {
        if (this.held.has(id) || !this.output.value || window.app?.ws?.readyState !== WebSocket.OPEN) return;
        const channel = Number(this.channel.value) - 1;
        const target = this.output.value;
        // Capture recipients so note-offs reach the same outputs even after a selection change.
        const targets = target === '__all__' ? [...new Set(this.dm.outputs.map(d => d.id))] : [target];
        if (!targets.length) return;
        if ([...this.held.values()].some(n => n.target === target && n.channel === channel && n.note === note)) return;
        const sustainedKey = `${target}:${channel}:${note}`;
        const previous = this.sustained.get(sustainedKey);
        if (previous) {
            this.dm.sendPerformance(previous.targets, [0x80 | previous.channel, previous.note, 0]);
            previous.button.classList.remove('pressed');
            this.sustained.delete(sustainedKey);
        }
        const velocity = Math.max(1, Math.min(127, Math.round(Number(this.velocity.value) || 100)));
        this.dm.sendPerformance(targets, [0x90 | channel, note, velocity]);
        this.held.set(id, { target, targets, channel, note, button });
        button.classList.add('pressed');
    }

    release(id) {
        const held = this.held.get(id);
        if (!held) return;
        this.held.delete(id);
        if (this.sustain) {
            this.sustained.set(`${held.target}:${held.channel}:${held.note}`, held);
            return;
        }
        this.dm.sendPerformance(held.targets, [0x80 | held.channel, held.note, 0]);
        if (![...this.held.values()].some(n => n.button === held.button)) held.button.classList.remove('pressed');
    }

    releaseAll() {
        this.setSustain(false);
        this.activePointers.clear();
        for (const id of [...this.held.keys()]) this.release(id);
    }

    setSustain(enabled) {
        this.sustain = enabled;
        this.sustainButton?.setAttribute('aria-pressed', String(enabled));
        if (!enabled) {
            for (const held of this.sustained.values()) {
                this.dm.sendPerformance(held.targets, [0x80 | held.channel, held.note, 0]);
                if (![...this.held.values()].some(n => n.button === held.button)) held.button.classList.remove('pressed');
            }
            this.sustained.clear();
        }
    }

    render() {
        this.keys.replaceChildren();
        const base = (Number(this.lowC.value) + 1) * 12;
        const end = (Number(this.highC.value) + 1) * 12;
        for (let note = base; note <= end; note++) {
            const button = document.createElement('button');
            button.type = 'button';
            const black = [1, 3, 6, 8, 10].includes(note % 12);
            button.className = `keyboard-key ${black ? 'black' : 'white'}`;
            button.dataset.note = String(note);
            button.textContent = noteName(note);
            button.setAttribute('aria-label', `Play ${noteName(note)}`);
            button.addEventListener('contextmenu', event => event.preventDefault());
            button.disabled = !this.output.value || !this.dm.outputs.length;
            button.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                event.preventDefault();
                if (event.pointerType !== 'touch') button.focus({ preventScroll: true });
                button.setPointerCapture(event.pointerId);
                this.activePointers.add(event.pointerId);
                this.press(event.pointerId, note, button);
            });
            button.addEventListener('pointermove', event => {
                if (!this.activePointers.has(event.pointerId)) return;
                const key = document.elementFromPoint(event.clientX, event.clientY)?.closest('.keyboard-key');
                const next = key && this.keys.contains(key) && !key.disabled ? key : null;
                if (this.held.get(event.pointerId)?.button === next) return;
                this.release(event.pointerId);
                if (next) this.press(event.pointerId, Number(next.dataset.note), next);
            });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                button.addEventListener(type, event => {
                    this.activePointers.delete(event.pointerId);
                    this.release(event.pointerId);
                });
            }
            button.addEventListener('keydown', event => {
                if (![' ', 'Enter'].includes(event.key)) return;
                event.preventDefault();
                if (!event.repeat) this.press(`key:${note}`, note, button);
            });
            button.addEventListener('keyup', event => {
                if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); this.release(`key:${note}`); }
            });
            button.addEventListener('blur', () => this.release(`key:${note}`));
            this.keys.appendChild(button);
        }
    }
}
