#!/usr/bin/env node
/**
 * MIDI Emulator - Создаёт виртуальные MIDI клиенты через ALSA sequencer API
 * Видны в RtMidi как реальные устройства
 */

import midi from '@julusian/midi';
import { EventEmitter } from 'events';

// Конфигурация эмуляторов
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
            // Контроллер — отправляет CC сообщения
            this.inputPort = new midi.Input();
            this.outputPort = new midi.Output();
            
            // Отправляем тестовые CC каждые 2 секунды
            this.interval = setInterval(() => {
                const ccData = [0xB0, 0x01, Math.floor(Math.random() * 127)]; // CC#1 значение случайное
                console.log(`[${name}] Sending CC: ${ccData.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                this.outputPort.write(ccData);
            }, 2000);
            
        } else if (type === 'synth') {
            // Синтезатор — получает CC и отправляет ноты в ответ
            this.inputPort = new midi.Input();
            this.outputPort = new midi.Output();
            
            // Слушаем входящие CC
            this.inputPort.on('message', (_, message) => {
                console.log(`[${name}] Received: ${message.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                
                // Отправляем ноту в ответ (если получили note on)
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
    
    // Подключается к другим портам через ALSA sequencer
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

// Запуск эмуляторов
console.log('=== MIDI Emulator Starting ===\n');

const emulators = EMULATORS.map(e => new MidiEmulator(e.name, e.type));

// Выход по Ctrl-C
process.on('SIGINT', () => {
    console.log('\n[EMULATOR] Shutting down...');
    emulators.forEach(em => em.disconnect());
    process.exit(0);
});

console.log(`\n[${emulators.length}] emulator(s) running. Press Ctrl+C to stop.\n`);
