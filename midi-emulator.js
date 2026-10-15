#!/usr/bin/env node
/**
 * MIDI Emulator - creates virtual MIDI clients through the ALSA sequencer API
 * Visible in RtMidi as real devices
 */

import midi from '@julusian/midi';
import { EventEmitter } from 'events';

// Emulator configuration
const EMULATORS = [
    { name: 'Test Controller 1', type: 'controller' },
    { name: 'Synth 1',           type: 'synth' },
];

class MidiEmulator extends EventEmitter {
    constructor(name, type) {
        super();
        this.name = name;
        this.type = type;
        
        if (type === 'controller') {
            // Controller — sends CC messages
            this.inputPort = new midi.Input();
            this.outputPort = new midi.Output();
            
            // Send test CCs every 2 seconds
            this.interval = setInterval(() => {
                const ccData = [0xB0, 0x01, Math.floor(Math.random() * 127)]; // CC#1 random value
                console.log(`[${name}] Sending CC: ${ccData.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                this.outputPort.write(ccData);
            }, 2000);
            
        } else if (type === 'synth') {
            // Synthesizer — receives CC and sends notes in response
            this.inputPort = new midi.Input();
            this.outputPort = new midi.Output();
            
            // Listen for incoming CC
            this.inputPort.on('message', (_, message) => {
                console.log(`[${name}] Received: ${message.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                
                // Send a note in response (if a note on was received)
                if (message[0] === 0x90 && message[2] > 0) {
                    const noteData = [0x90, 0x3C, 0x7F]; // C4
                    console.log(`[${name}] Sending note response: ${noteData.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                    this.outputPort.write(noteData);
                    
                    setTimeout(() => {
                        const noteOff = [0x80, 0x3C, 0x00];
                        this.outputPort.write(noteOff);
                    }, 100);
                }
            });
        }
        
        console.log(`[EMULATOR] Created: ${name} (${type})`);
    }
    
    // Connects to other ports through the ALSA sequencer
    connectTo(targetPort) {
        try {
            this.outputPort.connectFrom(targetPort);
            console.log(`[${this.name}] Connected to ${targetPort}`);
        } catch (e) {
            console.error(`[${this.name}] Connect error:`, e.message);
        }
    }
    
    disconnect() {
        clearInterval(this.interval);
        this.inputPort.closePort();
        this.outputPort.closePort();
    }
}

// Start the emulators
console.log('=== MIDI Emulator Starting ===\n');

const emulators = EMULATORS.map(e => new MidiEmulator(e.name, e.type));

// Exit on Ctrl-C
process.on('SIGINT', () => {
    console.log('\n[EMULATOR] Shutting down...');
    emulators.forEach(em => em.disconnect());
    process.exit(0);
});

console.log(`\n[${emulators.length}] emulator(s) running. Press Ctrl+C to stop.\n`);
