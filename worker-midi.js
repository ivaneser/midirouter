/* === MIDI Router Worker — отдельный процесс для роутинга === */
// Работает независимо от основного процесса, не блокируется веб-запросами
// API @julusian/midi v3.x: new midi.Input() → input.getPortCount(), input.getPortName(i)
// Hot-plug: watchdog перечисляет порты каждые 5 сек, обнаруживает новые устройства
// Auto-discovery (полностью автоматический): когда input шлёт сигнал без маршрута → ждёт 10 сек → если output получил CC → создаёт маршрут → иначе default на output_0
// Запуск: node worker-midi.js

import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // portId → RtMidiIn instance
        this.outputs = new Map();  // portId → RtMidiOut instance
        this.routes = new Map();   // inputPortId → [outputPortIds]
        this.watchdogInterval = null;

        // Auto-discovery state (полностью автоматический)
        this.discoveryState = {
            active: false,
            inputId: null,
            timer: null,
            timeoutMs: 10000, // 10 секунд
            ccReceived: new Map() // outputId → true
        };

        // Счётчик сообщений от unrouted входов (для debounce)
        this.unroutedCounters = new Map();  // portId → count
    }

    init() {
        try {
            console.log('[WORKER] MIDI initializing...');
            this._enumeratePorts(true);  // true = send ready signal on first run
        } catch (e) {
            console.error('[WORKER] MIDI init failed:', e.message);
            process.exit(1);
        }
    }

    _enumeratePorts(isInit = false) {
        try {
            const tempInput = new midi.Input();
            const inputCount = tempInput.getPortCount();
            tempInput.closePort();

            const tempOutput = new midi.Output();
            const outputCount = tempOutput.getPortCount();
            tempOutput.closePort();

            // Собираем имена портов
            const currentInputs = [];
            for (let i = 0; i < inputCount; i++) {
                const inp = new midi.Input();
                currentInputs.push({ id: `input_${i}`, name: inp.getPortName(i) });
                inp.closePort();
            }

            const currentOutputs = [];
            for (let i = 0; i < outputCount; i++) {
                const out = new midi.Output();
                currentOutputs.push({ id: `output_${i}`, name: out.getPortName(i) });
                out.closePort();
            }

            // Сравниваем с текущими портами
            const oldInputIds = new Set(this.inputs.keys());
            const newInputIds = new Set(currentInputs.map(i => i.id));

            // Удаляем исчезнувшие input порты
            for (const id of oldInputIds) {
                if (!newInputIds.has(id)) {
                    console.log(`[WORKER] Input removed: ${id}`);
                    const inp = this.inputs.get(id);
                    if (inp) inp.closePort();
                    this.inputs.delete(id);
                    // Удаляем маршруты для этого порта
                    this.routes.delete(id);
                    this.unroutedCounters.delete(id);
                }
            }

            // Добавляем новые input порты
            for (const port of currentInputs) {
                if (!this.inputs.has(port.id)) {
                    try {
                        const midiIn = new midi.Input();
                        const portIndex = parseInt(port.id.split('_')[1]);
                        midiIn.openPort(portIndex, 'midirouter-in');

                        // Callback: мгновенная маршрутизация
                        const self = this;
                        midiIn.on('message', (deltaTime, message) => {
                            self._routeMessage(message, port.id);
                        });

                        this.inputs.set(port.id, midiIn);
                        console.log(`[WORKER] Input added: ${port.id} — ${port.name}`);
                    } catch (e) {
                        console.error(`[WORKER] Failed to open new input ${port.id}:`, e.message);
                    }
                }
            }

            // Обновляем output порты (для sendFromServer)
            const oldOutputIds = new Set(this.outputs.keys());
            const newOutputIds = new Set(currentOutputs.map(o => o.id));

            for (const id of oldOutputIds) {
                if (!newOutputIds.has(id)) {
                    console.log(`[WORKER] Output removed: ${id}`);
                    const out = this.outputs.get(id);
                    if (out) out.closePort();
                    this.outputs.delete(id);
                }
            }

            // Обновляем output порты — не добавляем новые автоматически, только при явном запросе
            for (const port of currentOutputs) {
                if (!this.outputs.has(port.id)) {
                    const out = new midi.Output();
                    out.closePort();  // просто проверяем доступность
                }
            }

            console.log(`[WORKER] Ports: ${currentInputs.length} in, ${currentOutputs.length} out`);

            // Отправляем список портов основному процессу
            parentPort.postMessage({
                type: 'ports-enumerated',
                inputs: currentInputs,
                outputs: currentOutputs,
                added: isInit ? null : currentInputs.filter(i => !oldInputIds.has(i.id)),
                removed: isInit ? null : [...oldInputIds].filter(id => !newInputIds.has(id))
            });

            // На первый запуск — signal ready
            if (isInit) {
                parentPort.postMessage({ type: 'ready' });
            }
        } catch (e) {
            console.error('[WORKER] Enumerate failed:', e.message);
        }
    }

    _routeMessage(message, inputPortId) {
        const destinations = this.routes.get(inputPortId);

        // === Auto-discovery: нет маршрута → начинаем ожидание 10 сек ===
        if (!destinations || destinations.length === 0) {
            // Debounce: считаем сообщения, шлём уведомление только при первом или каждые N сообщений
            const count = (this.unroutedCounters.get(inputPortId) || 0) + 1;
            this.unroutedCounters.set(inputPortId, count);

            if (count === 1) {
                // Первое сообщение — начинаем discovery режим на 10 секунд
                console.log(`[WORKER] Auto-discovery started for ${inputPortId} (${this.discoveryState.timeoutMs / 1000}s timeout)`);
                
                this.discoveryState.active = true;
                this.discoveryState.inputId = inputPortId;
                this.discoveryState.ccReceived.clear();

                // Запускаем таймер на 10 секунд
                if (this.discoveryState.timer) {
                    clearTimeout(this.discoveryState.timer);
                }

                const self = this;
                this.discoveryState.timer = setTimeout(() => {
                    // Таймаут — default на output_0
                    console.log(`[WORKER] Auto-discovery timeout for ${inputPortId} → default to output_0`);
                    self._createRoute(inputPortId, 'output_0');
                    self._endDiscovery();
                }, this.discoveryState.timeoutMs);

                // Не маршрутизируем — ждём CC от синтезатора
                return;
            } else if (count <= 3) {
                // Шлём первые 3 сообщения для надёжности
                parentPort.postMessage({
                    type: 'unrouted-input',
                    inputId: inputPortId,
                    message: message,
                    sampleCount: count
                });
            }

            return;
        }

        // Проверяем — это CC сообщение? Если да и discovery активен → создаём маршрут
        if (this.discoveryState.active && this._isCCMessage(message)) {
            const outputId = this._findOutputReceivingCC(inputPortId, message);
            if (outputId) {
                console.log(`[WORKER] Auto-discovery: CC received from ${inputPortId} on ${outputId} → creating route`);
                this._createRoute(this.discoveryState.inputId, outputId);
                this._endDiscovery();
                return;
            }
        }

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

        // Сбрасываем счётчик при успешной маршрутизации
        if (this.unroutedCounters.has(inputPortId)) {
            this.unroutedCounters.set(inputPortId, 0);
        }
    }

    /** Проверить — это CC сообщение? */
    _isCCMessage(message) {
        // Status byte: 0xB0-0xBF = Control Change (channel 1-16)
        const statusByte = message[0];
        return (statusByte & 0xF0) === 0xB0;
    }

    /** Найти output порт который получил CC от этого input */
    _findOutputReceivingCC(inputId, ccMessage) {
        // Проверяем все outputs — если есть уже созданный маршрут с этим CC → возвращаем его
        for (const [outId] of this.outputs) {
            if (!this.discoveryState.ccReceived.has(outId)) continue;
            return outId;
        }

        // Если discovery активен и мы получили CC — создаём маршрут на первый доступный output
        const firstOutput = [...this.outputs.keys()][0];
        if (firstOutput) {
            this.discoveryState.ccReceived.set(firstOutput, true);
            return firstOutput;
        }

        return null;
    }

    /** Создать маршрут */
    _createRoute(inputId, outputId) {
        console.log(`[WORKER] Creating route: ${inputId} → ${outputId}`);
        this.setRoute(inputId, outputId);
    }

    /** Завершить discovery режим */
    _endDiscovery() {
        if (this.discoveryState.timer) {
            clearTimeout(this.discoveryState.timer);
            this.discoveryState.timer = null;
        }
        this.discoveryState.active = false;
        this.discoveryState.inputId = null;
        this.discoveryState.ccReceived.clear();

        // Уведомляем сервер
        parentPort.postMessage({
            type: 'discovery-complete'
        });
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

        // Сбрасываем счётчик unrouted для этого порта
        this.unroutedCounters.delete(inputId);

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

    // Запуск watchdog — периодическое перечисление портов (hot-plug detection)
    startWatchdog(intervalMs = 5000) {
        console.log(`[WORKER] Watchdog started (${intervalMs}ms)`);
        this.watchdogInterval = setInterval(() => {
            this._enumeratePorts(false);
        }, intervalMs);
    }

    cleanup() {
        if (this.discoveryState.timer) clearTimeout(this.discoveryState.timer);
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);
        for (const [, input] of this.inputs) {
            if (input) input.closePort();
        }
        for (const [, output] of this.outputs) {
            if (output) output.closePort();
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

        case 'shutdown':
            worker.cleanup();
            break;
    }
});

// Запуск (синхронный — без init())
worker.init();
worker.startWatchdog(5000);  // hot-plug detection каждые 5 секунд
