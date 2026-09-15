/* === MIDI Router Worker — отдельный процесс для роутинга === */
// Работает независимо от основного процесса, не блокируется веб-запросами
// API @julusian/midi v3.x: new midi.Input() → input.getPortCount(), input.getPortName(i)
// Auto-discovery (полностью автоматический): когда input шлёт сигнал без маршрута → ждёт 5 сек → создаёт маршрут на первый доступный порт
// Запуск: node worker-midi.js

import midi from '@julusian/midi';
import { parentPort } from 'worker_threads';

class MIDIRouterWorker {
    constructor() {
        this.inputs = new Map();   // portId → RtMidiIn instance (portId — стабильный индекс устройства)
        this.nameToPortId = new Map();  // deviceName → portId (маппинг имени на порт для hot-plug)
        this.portIdToName = new Map();  // портId → имя (обратный маппинг)
        
        this.outputs = new Map();  // outputPortId → RtMidiOut instance
        this.routes = new Map();   // deviceName → [outputPortIds]  ← маршрутизируем по ИМЕНИ
        
        // Auto-discovery state
        this.discoveryState = {
            active: false,
            currentOutputIndex: 0,
            waitingForInput: null,  // deviceName который ждёт ноту от контроллера
            timer: null,
            timeoutMs: 5000,
            connectedOutputs: new Set(),
            unroutedOutputs: [],    // имена устройств без маршрутов
            totalSynthsToConnect: 0,
            testNoteTimeout: null
        };

        // Счётчик сообщений от unrouted входов (для debounce)
        this.unroutedCounters = new Map();  // deviceName → count
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
                    realInputs.push({ index: i, name });
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
                    realOutputs.push({ index: i, name });
                } else {
                    console.log(`[WORKER] Skipping non-MIDI output ${i}: ${name}`);
                }
                out.closePort();
            }

            // === INPUT PORTS — маппинг по ИМЕНИ устройства ===
            const newPortsByName = new Map(realInputs.map(r => [r.name, r]));

            // Удаляем порты которые исчезли (не нашли по имени)
            for (const [id, port] of this.inputs) {
                if (!newPortsByName.has(port._name)) {
                    console.log(`[WORKER] Input removed: ${id} (${port._name || 'unknown'})`);
                    const inp = port;
                    if (inp._handler) {
                        inp.off('message', inp._handler);
                        inp._handler = null;
                    }
                    inp.closePort();
                    this.inputs.delete(oldEntry.id);
                    
                    // Удаляем из маппингов
                    this.nameToPortId.delete(oldEntry.port._name);
                    this.portIdToName.delete(oldEntry.id);
                    
                    // Удаляем маршруты для этого устройства
                    this.routes.delete(oldEntry.port._name);
                    this.unroutedCounters.delete(oldEntry.port._name);
                }
            }

            // Обновляем/добавляем порты — маппинг по имени (стабильный portId)
            for (const newPort of realInputs) {
                const deviceName = newPort.name;
                
                if (this.inputs.has(deviceName)) {
                    // Устройство уже есть — просто обновляем индекс порта если изменился
                    const existingRtMidiIn = this.inputs.get(deviceName);
                    const currentIndex = existingRtMidiIn._index;
                    
                    if (currentIndex !== newPort.index) {
                        console.log(`[WORKER] Port index changed for ${deviceName}: ${currentIndex} → ${newPort.index}`);
                        
                        // Удаляем старый handler и закрываем порт
                        if (existingRtMidiIn._handler) {
                            existingRtMidiIn.off('message', existingRtMidiIn._handler);
                            existingRtMidiIn._handler = null;
                        }
                        existingRtMidiIn.closePort();
                        
                        // Открываем новый порт с тем же portId (имя устройства)
                        const midiIn = new midi.Input();
                        midiIn.openPort(newPort.index, 'midirouter-in');

                        const self = this;
                        const handler = (deltaTime, message) => {
                            self._routeMessage(message, deviceName);  // ← по имени!
                        };
                        midiIn.on('message', handler);
                        midiIn._handler = handler;
                        midiIn._name = deviceName;
                        midiIn._portId = deviceName;
                        midiIn._index = newPort.index;

                        this.inputs.set(deviceName, midiIn);
                        console.log(`[WORKER] Port reopened for ${deviceName} (index: ${newPort.index})`);
                    }
                } else {
                    // Новое устройство — открываем порт и маппинг по имени
                    try {
                        const midiIn = new midi.Input();
                        midiIn.openPort(newPort.index, 'midirouter-in');

                        // Callback: мгновенная маршрутизация (только один раз!)
                        const self = this;
                        const handler = (deltaTime, message) => {
                            self._routeMessage(message, deviceName);  // ← по имени!
                        };
                        midiIn.on('message', handler);
                        midiIn._handler = handler;
                        midiIn._name = deviceName;
                        midiIn._portId = deviceName;
                        midiIn._index = newPort.index;

                        this.inputs.set(deviceName, midiIn);
                        
                        // Обновляем маппинги
                        this.nameToPortId.set(deviceName, deviceName);  // имя → портId (в нашем случае одинаково)
                        this.portIdToName.set(deviceName, deviceName);

                        console.log(`[WORKER] Input added: ${deviceName} (index: ${newPort.index})`);

                        // Отправляем уведомление о новом устройстве для автопоиска схемы
                        parentPort.postMessage({
                            type: 'new-device-detected',
                            inputId: deviceName,
                            name: deviceName
                        });
                    } catch (e) {
                        console.error(`[WORKER] Failed to open new input ${deviceName}:`, e.message);
                    }
                }
            }

            // === OUTPUT PORTS — аналогично по имени ===
            const oldOutputByName = new Map([...this.outputs.entries()].map(([id, port]) => [port._name || id, { id, port }]));
            const newOutputByName = new Map(realOutputs.map(r => [r.name, r]));

            for (const [, oldEntry] of oldOutputByName) {
                if (!newOutputByName.has(oldEntry.port._name)) {
                    console.log(`[WORKER] Output removed: ${oldEntry.id} (${oldEntry.port._name || 'unknown'})`);
                    const out = oldEntry.port;
                    if (out._handler) {
                        out.off('message', out._handler);
                        out._handler = null;
                    }
                    out.closePort();
                    this.outputs.delete(oldEntry.id);
                }
            }

            for (const newOutput of realOutputs) {
                const deviceName = newOutput.name;
                
                if (!this.outputs.has(deviceName)) {
                    try {
                        const out = new midi.Output();
                        out.openPort(newOutput.index, 'midirouter-out');
                        
                        this.outputs.set(deviceName, out);
                        out._name = deviceName;
                        out._portId = deviceName;
                        
                        console.log(`[WORKER] Output added: ${deviceName} (index: ${newOutput.index})`);
                    } catch (e) {
                        console.error(`[WORKER] Failed to open output ${deviceName}:`, e.message);
                    }
                }
            }

            console.log(`[WORKER] Ports: ${realInputs.length} in, ${realOutputs.length} out`);

            // Отправляем список портов основному процессу (по именам устройств)
            const inputList = [...this.inputs.entries()].map(([id, port]) => ({ id, name: port._name || 'unknown' }));
            const outputList = [...this.outputs.entries()].map(([id, port]) => ({ id, name: port._name || 'unknown' }));

            parentPort.postMessage({
                type: 'ports-enumerated',
                inputs: inputList,
                outputs: outputList,
                added: isInit ? null : [...this.inputs.keys()],
                removed: isInit ? null : []
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
                
                // Останавливаем текущий пинг синтезатора
                if (this.discoveryState.timer) {
                    clearTimeout(this.discoveryState.timer);
                    this.discoveryState.timer = null;
                }
                
                // Создаём маршрут input → output
                this._createRoute(inputPortId, outputId);
                
                // Отправляем двойную ноту подтверждения на этот синтезатор
                this._sendConfirmationNote(outputId);
                
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

    /** Отправить тестовую ноту на конкретный output порт */
    _sendTestNoteToOutput(outputId) {
        // outputId теперь deviceName — ищем порт в Map по имени
        const targetPort = this.outputs.get(outputId);
        if (!targetPort) {
            console.error(`[WORKER] Cannot find output port: ${outputId}`);
            return;
        }
        
        try {
            // C4 нота: 0x90 (note on ch1), 0x3C (C4), 0x7F (velocity)
            const testNote = [0x90, 0x3C, 0x7F];
            
            console.log(`[WORKER] Sending test note to output: ${outputId}`);
            targetPort.sendMessage(testNote);
            
            setTimeout(() => {
                const noteOff = [0x80, 0x3C, 0x00];
                try { targetPort.sendMessage(noteOff); } catch (e) {}
            }, 100);
        } catch (e) {
            console.error(`[WORKER] Failed to send test note to ${outputId}:`, e.message);
        }
    }

    /** Отправить двойную ноту подтверждения */
    _sendConfirmationNote(outputId) {
        const targetPort = this.outputs.get(outputId);
        if (!targetPort) return;
        
        try {
            for (let i = 0; i < 2; i++) {
                setTimeout(() => {
                    const testNote = [0x90, 0x3C, 0x7F];
                    targetPort.sendMessage(testNote);
                    setTimeout(() => {
                        const noteOff = [0x80, 0x3C, 0x00];
                        try { targetPort.sendMessage(noteOff); } catch (e) {}
                    }, 100);
                }, i * 200);
            }
            console.log(`[WORKER] Confirmation sent to ${outputId}`);
        } catch (e) {
            console.error(`[WORKER] Failed confirmation to ${outputId}:`, e.message);
        }
    }

    /** Запустить обзвон одного синтезатора — 5 нот с интервалом 1 сек */
    _pingSynth(targetId, callbackOnSuccess) {
        let sentCount = 0;
        const maxPings = 5;
        
        console.log(`[WORKER] Pinging ${targetId} (${maxPings} times, 1s interval)`);
        
        const pingOnce = () => {
            if (sentCount >= maxPings) {
                // Все ноты отправлены без ответа — таймаут
                console.log(`[WORKER] Auto-connect timeout for ${targetId} → skipping`);
                this._nextSynth();
                return;
            }
            
            this._sendTestNoteToOutput(targetId);
            sentCount++;
            
            // Следующая нота через 1 секунду
            const self = this;
            this.discoveryState.timer = setTimeout(pingOnce, 1000);
        };
        
        pingOnce();
    }

    /** Перейти к следующему синтезатору */
    _nextSynth() {
        this.discoveryState.currentOutputIndex++;
        
        // Проверяем все ли целевые устройства подключены
        if (this.discoveryState.currentOutputIndex >= this.discoveryState.unroutedOutputs.length) {
            console.log('[WORKER] Auto-connect: all targets connected');
            this._endDiscovery();
        } else {
            // Начинаем тестирование следующего целевого устройства
            const targetId = this.discoveryState.unroutedOutputs[this.discoveryState.currentOutputIndex];
            console.log(`[WORKER] Auto-connect: testing next target ${targetId}`);
            
            // Сбрасываем таймер и запускаем обзвон
            if (this.discoveryState.timer) {
                clearTimeout(this.discoveryState.timer);
            }
            
            const self = this;
            this._pingSynth(targetId, () => {
                self._nextSynth();
            });
        }
    }

    /** Запустить автоматическое соединение всех устройств */
    startAutoConnect() {
        console.log('[WORKER] Starting auto-connect mode...');
        
        // Собираем все input порты (все устройства шлют CC, значит INPUT)
        const allInputs = [];
        for (const [inputId, port] of this.inputs) {
            if (!this.routes.has(inputId)) {
                allInputs.push({ id: inputId, name: port._name || 'unknown' });
            }
        }
        
        console.log(`[WORKER] Found ${allInputs.length} unrouted inputs`);
        for (const inp of allInputs) {
            console.log(`  - ${inp.id}: ${inp.name}`);
        }
        
        if (allInputs.length < 2) {
            console.log('[WORKER] Need at least 2 unrouted inputs to connect');
            return;
        }
        
        // Первый — контроллер, остальные — целевые устройства
        const controller = allInputs[0];
        const targets = allInputs.slice(1);
        
        console.log(`[WORKER] Controller: ${controller.id} (${controller.name})`);
        console.log(`[WORKER] Targets:`, targets.map(t => t.id));
        
        // Активируем discovery режим
        this.discoveryState.active = true;
        this.discoveryState.waitingForInput = controller.id;
        this.discoveryState.currentOutputIndex = 0;
        this.discoveryState.unroutedOutputs = targets.map(t => t.id);
        this.discoveryState.totalSynthsToConnect = targets.length;
        
        // Начинаем тестирование первого целевого устройства
        const targetId = targets[0].id;
        console.log(`[WORKER] Starting ping sequence for ${targetId}`);
        
        this._pingSynth(targetId, () => {});
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
        if (!outputId || !this.outputs.has(outputId)) {
            console.log(`[WORKER] Cannot create route: invalid outputId ${outputId} (not found in outputs)`);
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
        // portId теперь deviceName, не index — ищем по имени
        if (this.outputs.has(portId)) return this.outputs.get(portId);

        // Ищем индекс порта по имени устройства
        const tempOutput = new midi.Output();
        const outputCount = tempOutput.getPortCount();
        let foundIndex = -1;
        
        for (let i = 0; i < outputCount; i++) {
            const out = new midi.Output();
            const name = out.getPortName(i);
            if (name === portId && !name.toLowerCase().includes('timer') && 
                !name.toLowerCase().includes('loopback') && 
                !name.toLowerCase().includes('system')) {
                foundIndex = i;
                out.closePort();
                break;
            }
            out.closePort();
        }
        tempOutput.closePort();
        
        if (foundIndex === -1) {
            console.error(`[WORKER] Cannot find output port: ${portId}`);
            return null;
        }
        
        try {
            const midiOut = new midi.Output();
            midiOut.openPort(foundIndex, 'midirouter-out');
            this.outputs.set(portId, midiOut);
            console.log(`[WORKER] Output opened: ${portId} (index: ${foundIndex})`);
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

    cleanup() {
        if (this.discoveryState.timer) clearTimeout(this.discoveryState.timer);
        for (const [, input] of this.inputs) {
            if (input) {
                if (input._handler) input.off('message', input._handler);
                input.closePort();
            }
        }
        for (const [, output] of this.outputs) {
            if (output) output.closePort();
        }
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
            process.exit(0);
            break;
    }
});

// Запуск (синхронный — без init())
worker.init();
