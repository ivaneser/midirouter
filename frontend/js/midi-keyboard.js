import { noteName } from './piano-roll.js';

export class MidiKeyboard {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.held = new Map();
        this.section = document.getElementById('midi-keyboard-section');
        if (!this.section) return;
        this.output = document.getElementById('keyboard-output');
        this.channel = document.getElementById('keyboard-channel');
        this.octave = document.getElementById('keyboard-octave');
        this.velocity = document.getElementById('keyboard-velocity');
        this.keys = document.getElementById('keyboard-keys');
        for (let n = 1; n <= 16; n++) this.channel.add(new Option(`Ch ${n}`, String(n)));
        for (let n = 0; n <= 7; n++) this.octave.add(new Option(`C${n}–C${n + 2}`, String(n)));
        this.octave.value = '3';
        this.output.addEventListener('change', () => {
            this.releaseAll();
            const device = this.dm.outputs.find(d => d.id === this.output.value);
            if (device) this.channel.value = String(this.dm.channelForDevice(device));
        });
        this.channel.addEventListener('change', () => this.releaseAll());
        this.octave.addEventListener('change', () => { this.releaseAll(); this.render(); });
        document.getElementById('keyboard-release').addEventListener('click', () => this.releaseAll());
        this.section.addEventListener('toggle', () => { if (!this.section.open) this.releaseAll(); });
        window.addEventListener('blur', () => this.releaseAll());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
        this.render();
    }

    updatePorts() {
        if (!this.section) return;
        const selected = this.output.value;
        this.releaseAll();
        this.output.replaceChildren();
        for (const device of this.dm.getAllDevices().filter(d => d.output)) {
            this.output.add(new Option(device.displayName, device.id));
        }
        if (this.dm.outputs.some(d => d.id === selected)) this.output.value = selected;
        else {
            const device = this.dm.outputs.find(d => d.id === this.output.value);
            if (device) this.channel.value = String(this.dm.channelForDevice(device));
        }
        this.render();
    }

    press(id, note, button) {
        if (this.held.has(id) || !this.output.value || window.app?.ws?.readyState !== WebSocket.OPEN) return;
        const channel = Number(this.channel.value) - 1;
        const target = this.output.value;
        if ([...this.held.values()].some(n => n.target === target && n.channel === channel && n.note === note)) return;
        const velocity = Math.max(1, Math.min(127, Math.round(Number(this.velocity.value) || 100)));
        this.dm.sendMidi(target, [0x90 | channel, note, velocity]);
        this.held.set(id, { target, channel, note, button });
        button.classList.add('pressed');
    }

    release(id) {
        const held = this.held.get(id);
        if (!held) return;
        this.held.delete(id);
        this.dm.sendMidi(held.target, [0x80 | held.channel, held.note, 0]);
        if (![...this.held.values()].some(n => n.button === held.button)) held.button.classList.remove('pressed');
    }

    releaseAll() { for (const id of [...this.held.keys()]) this.release(id); }

    render() {
        this.keys.replaceChildren();
        const base = (Number(this.octave.value) + 1) * 12;
        for (let note = base; note <= base + 24; note++) {
            const button = document.createElement('button');
            button.type = 'button';
            const black = [1, 3, 6, 8, 10].includes(note % 12);
            button.className = `keyboard-key ${black ? 'black' : 'white'}`;
            button.textContent = noteName(note);
            button.setAttribute('aria-label', `Play ${noteName(note)}`);
            button.disabled = !this.output.value;
            button.addEventListener('pointerdown', event => {
                if (event.button !== 0) return;
                event.preventDefault();
                button.focus({ preventScroll: true });
                button.setPointerCapture(event.pointerId);
                this.press(event.pointerId, note, button);
            });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                button.addEventListener(type, event => this.release(event.pointerId));
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
