/* === MIDI Router Worker — отдельный процесс для роутинга === */
// Работает независимо от основного процесса, не блокируется веб-запросами
// Запуск: node worker-midi.js

import Midi from '@julusian/midi';
import { parentPort } from 'worker_threads';

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // portId → RtMidiIn
        this.outputs = new Map();  // portId → RtMidiOut
        this.routes = new Map();   // inputPortId → [outputPortIds]
        this.autoDiscoverMode = false;
        this.discoveryState = null;
    }

    async init() {
        try {
            await Midi.init('ALSA');
            console.log('[WORKER] ALSA initialized');
        } catch (e) {
            console.error('[WORKER] ALSA init failed:', e.message);
            process.exit(1);
        }

        this._enumeratePorts();
    }

    _enumeratePorts() {
        const inputs = Midi.getInputNames();
        const outputs = Midi.getOutputNames();

        // Отправляем список портов основному процессу
        parentPort.postMessage({
            type: 'ports-enumerated',
            inputs: inputs.map((name, i) => ({ id: `input_${i}`, name })),
            outputs: outputs.map((name, i) => ({ id: `output_${i}`, name }))
        });

        // Открываем все input порты для callback
        for (let i = 0; i < inputs.length; i++) {
            const portId = `input_${i}`;
            try {
                const midiIn = new Midi.Input();
                midiIn.openPort(i);

                // Callback работает на уровне ALSA — синхронный, мгновенный
                const self = this;
                midiIn.setCallback(function(message) {
                    self._routeMessage(message.bytes, portId);
                });

                this.inputs.set(portId, midiIn);
            } catch (e) {
                console.error(`[WORKER] Failed to open input ${portId}:`, e.message);
            }
        }
    }

    _routeMessage(bytes, inputPortId) {
        const destinations = this.routes.get(inputPortId);
        if (!destinations || destinations.length === 0) return;

        // Мгновенная отправка через буфер — минимальные аллокации
        for (let i = 0; i < destinations.length; i++) {
            const outputId = destinations[i];
            const midiOut = this.outputs.get(outputId);
            if (midiOut) {
                try {
                    midiOut.send(bytes);
                } catch (e) {
                    // Игнорируем ошибки отправки — не блокируем роутинг
                }
            }
        }
    }

    // Отправить MIDI на output порт из основного процесса
    async sendToOutput(outputPortId, bytes) {
        const midiOut = await this._ensureOutput(outputPortId);
        if (!midiOut) return false;

        try {
            midiOut.send(bytes);
            return true;
        } catch (e) {
            console.error(`[WORKER] Send failed to ${outputPortId}:`, e.message);
            return false;
        }
    }

    async _ensureOutput(portId) {
        if (this.outputs.has(portId)) return this.outputs.get(portId);

        const portIndex = parseInt(portId.split('_')[1]);
        try {
            const midiOut = new Midi.Output();
            await midiOut.openPort(portIndex);
            this.outputs.set(portId, midiOut);
            console.log(`[WORKER] Output opened: ${portId}`);
        } catch (e) {
            console.error(`[WORKER] Failed to open output ${portId}:`, e.message);
            return null;
        }

        return this.outputs.get(portId);
    }

    // Установить маршрут
    setRoute(inputId, outputId) {
        if (!this.routes.has(inputId)) {
            this.routes.set(inputId, []);
        }

        const destinations = this.routes.get(inputId);
        if (!destinations.includes(outputId)) {
            destinations.push(outputId);
        }

        // Подтверждаем маршрутизацию
        parentPort.postMessage({
            type: 'route-updated',
            inputId,
            outputId,
            allDestinations: [...destinations]
        });
    }

    // Удалить маршрут
    removeRoute(inputId, outputId) {
        const destinations = this.routes.get(inputId);
        if (destinations) {
            const idx = destinations.indexOf(outputId);
            if (idx > -1) destinations.splice(idx, 1);
        }

        parentPort.postMessage({
            type: 'route-removed',
            inputId,
            outputId
        });
    }

    // Авто-обнаружение
    setAutoDiscover(active) {
        this.autoDiscoverMode = active;
        if (!active) this.discoveryState = null;

        parentPort.postMessage({
            type: 'auto-discover-state',
            active
        });
    }

    cleanup() {
        for (const [, input] of this.inputs) {
            if (input) input.close();
        }
        for (const [, output] of this.outputs) {
            if (output) output.close();
        }
        process.exit(0);
    }
}

const worker = new MIDIRouterWorker();

// Обработка команд от основного процесса
parentPort.on('message', async (msg) => {
    switch (msg.type) {
        case 'send-midi': {
            const result = await worker.sendToOutput(msg.outputId, msg.bytes);
            parentPort.postMessage({ type: 'midi-sent', outputId: msg.outputId, success: result });
            break;
        }

        case 'set-route':
            worker.setRoute(msg.inputId, msg.outputId);
            break;

        case 'remove-route':
            worker.removeRoute(msg.inputId, msg.outputId);
            break;

        case 'auto-discover':
            worker.setAutoDiscover(msg.active);
            break;

        case 'shutdown':
            worker.cleanup();
            break;
    }
});

// Запуск
worker.init().then(() => {
    parentPort.postMessage({ type: 'ready' });
}).catch(console.error);
