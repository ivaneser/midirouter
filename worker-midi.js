/* === MIDI Router Worker — отдельный процесс для роутинга === */
// Работает независимо от основного процесса, не блокируется веб-запросами
// API @julusian/midi v3.x: new midi.Input() → input.getPortCount(), input.getPortName(i)
// Запуск: node worker-midi.js

import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // portId → RtMidiIn instance
        this.outputs = new Map();  // portId → RtMidiOut instance
        this.routes = new Map();   // inputPortId → [outputPortIds]
        this.autoDiscoverMode = false;
    }

    init() {
        try {
            // v3.x API: создаём экземпляр, вызываем методы на нём
            const tempInput = new midi.Input();
            const inputCount = tempInput.getPortCount();
            tempInput.close();  // закрываем сразу — нам только count нужен

            const tempOutput = new midi.Output();
            const outputCount = tempOutput.getPortCount();
            tempOutput.close();

            console.log(`[WORKER] MIDI initialized`);
            console.log(`[WORKER] Inputs: ${inputCount}, Outputs: ${outputCount}`);

            // Собираем имена портов
            const inputNames = [];
            for (let i = 0; i < inputCount; i++) {
                const inp = new midi.Input();
                inputNames.push({ id: `input_${i}`, name: inp.getPortName(i) });
                inp.close();
            }

            const outputNames = [];
            for (let i = 0; i < outputCount; i++) {
                const out = new midi.Output();
                outputNames.push({ id: `output_${i}`, name: out.getPortName(i) });
                out.close();
            }

            // Отправляем список портов основному процессу
            parentPort.postMessage({
                type: 'ports-enumerated',
                inputs: inputNames,
                outputs: outputNames
            });

            // Открываем все input порты для callback
            for (let i = 0; i < inputCount; i++) {
                const portId = `input_${i}`;
                try {
                    const midiIn = new midi.Input();
                    midiIn.openPort(i, 'midirouter-in');

                    // Callback: мгновенная маршрутизация без аллокаций
                    const self = this;
                    midiIn.on('message', (deltaTime, message) => {
                        self._routeMessage(message, portId);
                    });

                    this.inputs.set(portId, midiIn);
                    console.log(`[WORKER] Input opened: ${portId} — ${inputNames[i].name}`);
                } catch (e) {
                    console.error(`[WORKER] Failed to open input ${portId}:`, e.message);
                }
            }

            // Отправляем signal готовности
            parentPort.postMessage({ type: 'ready' });
        } catch (e) {
            console.error('[WORKER] MIDI init failed:', e.message);
            process.exit(1);
        }
    }

    _routeMessage(message, inputPortId) {
        const destinations = this.routes.get(inputPortId);
        if (!destinations || destinations.length === 0) return;

        // Мгновенная отправка через все маршруты — минимальные аллокации
        for (let i = 0; i < destinations.length; i++) {
            const outputId = destinations[i];
            const midiOut = this.outputs.get(outputId);
            if (midiOut) {
                try {
                    midiOut.sendMessage(message);
                } catch (e) {
                    // Игнорируем ошибки отправки — не блокируем роутинг
                }
            }
        }
    }

    // Отправить MIDI на output порт из основного процесса
    sendToOutput(outputPortId, message) {
        const midiOut = this._ensureOutput(outputPortId);
        if (!midiOut) return false;

        try {
            midiOut.sendMessage(message);
            return true;
        } catch (e) {
            console.error(`[WORKER] Send failed to ${outputPortId}:`, e.message);
            return false;
        }
    }

    _ensureOutput(portId) {
        if (this.outputs.has(portId)) return this.outputs.get(portId);

        const portIndex = parseInt(portId.split('_')[1]);
        try {
            const midiOut = new midi.Output();
            midiOut.openPort(portIndex, 'midirouter-out');
            this.outputs.set(portId, midiOut);
            console.log(`[WORKER] Output opened: ${portId}`);
            return midiOut;
        } catch (e) {
            console.error(`[WORKER] Failed to open output ${portId}:`, e.message);
            return null;
        }
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
        if (!active) { /* сброс discovery state если нужен */ }

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
parentPort.on('message', (msg) => {
    switch (msg.type) {
        case 'send-midi': {
            const result = worker.sendToOutput(msg.outputId, msg.message);
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

// Запуск (синхронный — без init())
worker.init();
