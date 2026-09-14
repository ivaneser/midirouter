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

        // Auto-discovery state (полностью автоматический режим соединения)
        this.discoveryState = {
            active: false,
            currentOutputIndex: 0, // индекс текущего output который ждёт ноту от контроллера
            waitingForInput: null, // inputId который получил ноту и готов к маппингу
            timer: null,
            timeoutMs: 5000, // 5 секунд на каждый синтезатор
            connectedOutputs: new Set(), // output ports которые уже подключены
            unroutedOutputs: [], // output ports без маршрутов (синтезаторы)
            totalSynthsToConnect: 0,
            testNoteTimeout: null // таймер для тестовой ноты
        };

        // Watchdog — работает только пока нет активных маршрутов (hot-plug detection)
        this.hasActiveRoutes = false;

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

            // Фильтрация — только реальные MIDI порты (исключаем системные ALSA sequencer)
            const realInputs = [];
            for (let i = 0; i < inputCount; i++) {
                const inp = new midi.Input();
                const name = inp.getPortName(i);
                // Оставляем только порты с MIDI-устройствами, исключаем timers/loopback/system
                if (!name.toLowerCase().includes('timer') && !name.toLowerCase().includes('loopback') && !name.toLowerCase().includes('system')) {
                    realInputs.push({ id: `input_${i}`, name });
                } else {
                    console.log(`[WORKER] Skipping non-MIDI input ${i}: ${name}`);
                }
                inp.closePort();
            }

            const realOutputs = [];
            for (let i = 0; i < outputCount; i++) {
                const out = new midi.Output();
                const name = out.getPortName(i);
                if (!name.toLowerCase().includes('timer') && !name.toLowerCase().includes('loopback') && !name.toLowerCase().includes('system')) {
                    realOutputs.push({ id: `output_${i}`, name });
                } else {
                    console.log(`[WORKER] Skipping non-MIDI output ${i}: ${name}`);
                }
                out.closePort();
            }

            // Сравниваем с текущими портами
            const oldInputIds = new Set(this.inputs.keys());
            const newInputIds = new Set(realInputs.map(i => i.id));

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

            // Добавляем новые input порты + автопоиск схемы
            for (const port of realInputs) {
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

                        // Отправляем уведомление о новом устройстве для автопоиска схемы
                        parentPort.postMessage({
                            type: 'new-device-detected',
                            inputId: port.id,
                            name: port.name
                        });
                    } catch (e) {
                        console.error(`[WORKER] Failed to open new input ${port.id}:`, e.message);
                    }
                }
            }

            // Обновляем output порты (для sendFromServer)
            const oldOutputIds = new Set(this.outputs.keys());
            const newOutputIds = new Set(realOutputs.map(o => o.id));

            for (const id of oldOutputIds) {
                if (!newOutputIds.has(id)) {
                    console.log(`[WORKER] Output removed: ${id}`);
                    const out = this.outputs.get(id);
                    if (out) out.closePort();
                    this.outputs.delete(id);
                }
            }

            // Обновляем output порты — не добавляем новые автоматически, только при явном запросе
            for (const port of realOutputs) {
                if (!this.outputs.has(port.id)) {
                    const out = new midi.Output();
                    out.closePort();  // просто проверяем доступность
                }
            }

            console.log(`[WORKER] Ports: ${realInputs.length} in, ${realOutputs.length} out`);

            // Отправляем список портов основному процессу
            parentPort.postMessage({
                type: 'ports-enumerated',
                inputs: realInputs,
                outputs: realOutputs,
                added: isInit ? null : realInputs.filter(i => !oldInputIds.has(i.id)),
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

        // === Auto-discovery: проверяем если discovery активен и ждём ноту от контроллера ===
        if (this.discoveryState.active && this.discoveryState.waitingForInput !== null) {
            // Если нота пришла от того же input который мы ожидаем — создаём маршрут
            if (inputPortId === this.discoveryState.waitingForInput) {
                const outputId = this.discoveryState.unroutedOutputs[this.discoveryState.currentOutputIndex];
                console.log(`[WORKER] Auto-connect: received note from ${inputPortId} on ${outputId} → creating route`);
                
                // Создаём маршрут input → output
                this._createRoute(inputPortId, outputId);
                
                // Переходим к следующему синтезатору
                this._nextSynth();
            }
            
            return;
        }

        // Если discovery не активен — обычная маршрутизация
        if (!destinations || destinations.length === 0) {
            // Debounce: считаем сообщения, шлём уведомление только при первом или каждые N сообщений
            const count = (this.unroutedCounters.get(inputPortId) || 0) + 1;
            this.unroutedCounters.set(inputPortId, count);

            if (count === 1) {
                // Первое сообщение — начинаем discovery режим на 5 секунд
                console.log(`[WORKER] Auto-discovery started for ${inputPortId} (${this.discoveryState.timeoutMs / 1000}s timeout)`);
                
                this.discoveryState.active = true;
                this.discoveryState.waitingForInput = inputPortId;
                
                // Запускаем таймер на 5 секунд
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

        // Мгновенная отправка через все маршруты — минимальные аллокации
        for (let i = 0; i < destinations.length; i++) {
            const outputId = destinations[i];
            const midiOut = this.outputs.get(outputId);
            if (midiOut) {
                try {
                    midiOut.sendMessage(message);

                    // Логируем в консоль сервера
                    parentPort.postMessage({
                        type: 'midi-routed',
                        inputId: inputPortId,
                        outputId,
                        message: message
                    });
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

    /** Отправить тестовую ноту на output порт */
    _sendTestNote(outputId) {
        const midiOut = this.outputs.get(outputId);
        if (!midiOut) return;

        // C4 нота: 0x90 (note on ch1), 0x3C (C4), 0x7F (velocity)
        const testNote = [0x90, 0x3C, 0x7F];
        try {
            midiOut.sendMessage(testNote);
            
            // Через 100мс отправляем note off чтобы нота не зависла
            setTimeout(() => {
                const noteOff = [0x80, 0x3C, 0x00];
                try { midiOut.sendMessage(noteOff); } catch (e) {}
            }, 100);
        } catch (e) {
            console.error(`[WORKER] Failed to send test note to ${outputId}:`, e.message);
        }
    }

    /** Перейти к следующему синтезатору */
    _nextSynth() {
        this.discoveryState.currentOutputIndex++;
        
        // Проверяем все ли синтезаторы подключены
        if (this.discoveryState.currentOutputIndex >= this.discoveryState.unroutedOutputs.length) {
            console.log('[WORKER] Auto-connect: all synths connected');
            this._endDiscovery();
        } else {
            // Начинаем тестирование следующего синтезатора
            const outputId = this.discoveryState.unroutedOutputs[this.discoveryState.currentOutputIndex];
            console.log(`[WORKER] Auto-connect: testing next synth ${outputId}`);
            
            // Сбрасываем таймер и отправляем тестовую ноту
            if (this.discoveryState.timer) {
                clearTimeout(this.discoveryState.timer);
            }
            
            this._sendTestNote(outputId);
            
            const self = this;
            this.discoveryState.timer = setTimeout(() => {
                // Таймаут — пробуем следующий синтезатор
                console.log(`[WORKER] Auto-connect timeout for ${outputId} → skipping`);
                self._nextSynth();
            }, this.discoveryState.timeoutMs);
        }
    }

    /** Запустить автоматическое соединение всех устройств */
    startAutoConnect() {
        console.log('[WORKER] Starting auto-connect mode...');
        
        // Собираем все unrouted outputs (синтезаторы без маршрутов)
        this.discoveryState.unroutedOutputs = [];
        for (const [outputId] of this.outputs) {
            if (!this.discoveryState.connectedOutputs.has(outputId)) {
                this.discoveryState.unroutedOutputs.push(outputId);
            }
        }
        
        console.log(`[WORKER] Found ${this.discoveryState.unroutedOutputs.length} synths to connect`);
        
        if (this.discoveryState.unroutedOutputs.length === 0) {
            console.log('[WORKER] No synths to connect');
            return;
        }
        
        // Активируем discovery режим
        this.discoveryState.active = true;
        this.discoveryState.waitingForInput = null;
        this.discoveryState.currentOutputIndex = 0;
        this.discoveryState.totalSynthsToConnect = this.discoveryState.unroutedOutputs.length;
        
        // Начинаем тестирование первого синтезатора
        const outputId = this.discoveryState.unroutedOutputs[0];
        console.log(`[WORKER] Sending test note to ${outputId} (synth #1)`);
        
        this._sendTestNote(outputId);
        
        // Запускаем таймер 5 секунд ожидания от контроллера
        const self = this;
        this.discoveryState.timer = setTimeout(() => {
            console.log(`[WORKER] Auto-connect timeout for ${outputId} → skipping`);
            self._nextSynth();
        }, this.discoveryState.timeoutMs);
    }

    /** Завершить discovery режим */
    _endDiscovery() {
        if (this.discoveryState.timer) {
            clearTimeout(this.discoveryState.timer);
            this.discoveryState.timer = null;
        }
        this.discoveryState.active = false;
        this.discoveryState.waitingForInput = null;
        this.discoveryState.currentOutputIndex = 0;
        
        // Уведомляем сервер
        parentPort.postMessage({
            type: 'discovery-complete'
        });
    }

    /** Создать маршрут */
    _createRoute(inputId, outputId) {
        if (!outputId || !this.routes.has(outputId)) {
            console.log(`[WORKER] Cannot create route: invalid outputId ${outputId}`);
            return;
        }
        console.log(`[WORKER] Creating route: ${inputId} → ${outputId}`);
        this.setRoute(inputId, outputId);
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

        // Если появился первый маршрут — отключаем watchdog (устройства работают, ресурсы не жрём)
        if (!this.hasActiveRoutes && destinations.length > 0) {
            console.log('[WORKER] Active routes detected → stopping watchdog');
            this._stopWatchdog();
            this.hasActiveRoutes = true;
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

        // Если все маршруты удалены — включаем watchdog обратно (hot-plug detection нужен)
        const totalRoutes = [...this.routes.values()].reduce((sum, dests) => sum + dests.length, 0);
        if (totalRoutes === 0 && this.hasActiveRoutes) {
            console.log('[WORKER] No active routes → restarting watchdog');
            this._startWatchdog();
            this.hasActiveRoutes = false;
        }

        parentPort.postMessage({
            type: 'route-removed',
            inputId,
            outputId
        });
    }

    // Остановить watchdog (устройства работают стабильно)
    _stopWatchdog() {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
            console.log('[WORKER] Watchdog stopped');
        }
    }

    // Запустить watchdog обратно
    _startWatchdog(intervalMs = 5000) {
        console.log(`[WORKER] Watchdog started (${intervalMs}ms)`);
        this.watchdogInterval = setInterval(() => {
            this._enumeratePorts(false);
        }, intervalMs);
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

        case 'auto-connect':
            worker.startAutoConnect();
            break;

        case 'shutdown':
            worker.cleanup();
            break;
    }
});

// Запуск (синхронный — без init())
worker.init();
worker.startWatchdog(5000);  // hot-plug detection каждые 5 секунд
