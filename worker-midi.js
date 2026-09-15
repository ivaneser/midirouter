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
        this.routes = new Map();   // deviceName → [{ outputId, channels }] — маршруты с фильтрацией по каналам

        // Auto-discovery state — поддержка нескольких контроллеров одновременно
        this.discoveryState = {
            active: false,
            timeoutMs: 5000,
            timer: null,

            // Map<controllerId, { targets: string[], connectedTargets: Set, currentTargetIdx: number }>
            controllers: new Map(),

            // Счётчик сообщений от unrouted входов (для fallback discovery)
            unroutedCounters: new Map()  // deviceName → count
        };
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
                    this.inputs.delete(id);

                    // Удаляем из маппингов
                    this.nameToPortId.delete(port._name);
                    this.portIdToName.delete(id);

                    // Удаляем маршруты для этого устройства
                    this.routes.delete(port._name);
                    if (this.discoveryState.unroutedCounters) {
                        this.discoveryState.unroutedCounters?.delete(port._name);
                    }
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
        // Извлекаем MIDI-канал из сообщения (первый байт & 0x0F)
        const statusByte = message[0];
        const midiChannel = statusByte & 0x0F;

        const routeList = this.routes.get(inputPortId);

        // === Auto-discovery: проверяем если discovery активен и ждём note ON от контроллеров ===
        if (this.discoveryState.active && this.discoveryState.controllers.size > 0) {
            const controllerState = this.discoveryState.controllers.get(inputPortId);

            // Фильтруем — ждём ТОЛЬКО note on (0x9x), игнорируем CC (0xBx)
            const statusByte = message[0];
            const isNoteOn = (statusByte & 0xF0) === 0x90 && message[2] > 0;

            if (!isNoteOn || !controllerState) {
                return;
            }

            // Если note on пришла от активного контроллера — создаём маршрут к следующему доступному синтезу
            const outputId = controllerState.targets[controllerState.currentTargetIdx];
            console.log(`[WORKER] Auto-connect: received note ON from ${inputPortId} (CH${midiChannel + 1}) → connecting to ${outputId}`);

            // Останавливаем текущий пинг синтезатора
            if (this.discoveryState.timer) {
                clearTimeout(this.discoveryState.timer);
                this.discoveryState.timer = null;
            }

            // Создаём маршрут с каналом нажатой ноты — 1 контроллер → несколько синтов по разным каналам
            this._createRoute(inputPortId, outputId, [midiChannel]);

            // Отправляем двойную ноту подтверждения на этот синтезатор (на том же канале)
            this._sendConfirmationNote(outputId, midiChannel);

            // Помечаем целевой синтез как подключённый
            controllerState.connectedTargets.add(outputId);

            // Переходим к следующему синтезу для этого контроллера
            this._nextSynthForController(inputPortId);

            return;
        }

        // Если discovery не активен — обычная маршрутизация
        if (!routeList || routeList.length === 0) {
            // Debounce: считаем сообщения, шлём уведомление только при первом или каждые N сообщений
            const count = (this.discoveryState.unroutedCounters.get(inputPortId) || 0) + 1;
            this.discoveryState.unroutedCounters.set(inputPortId, count);

            if (count === 1 && !this.discoveryState.active) {
                // Первое сообщение — начинаем fallback discovery режим на 5 секунд
                console.log(`[WORKER] Auto-discovery started for ${inputPortId} (${this.discoveryState.timeoutMs / 1000}s timeout)`);

                this.discoveryState.active = true;

                const self = this;
                this.discoveryState.timer = setTimeout(() => {
                    // Таймаут — маршрутизируем на первый доступный output порт
                    const firstOutput = [...this.outputs.keys()][0];
                    if (firstOutput) {
                        console.log(`[WORKER] Auto-discovery timeout for ${inputPortId} → routing to ${firstOutput}`);
                        self._createRoute(inputPortId, firstOutput);
                    }
                    self._endDiscovery();
                }, this.discoveryState.timeoutMs);

                // Не маршрутизируем — ждём сигнал от синтезатора
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

        // Отправка через все маршруты с фильтрацией по MIDI-каналу
        for (let i = 0; i < routeList.length; i++) {
            const route = routeList[i];
            
            // Проверяем канал: если в маршруте указаны каналы, проверяем совпадение
            if (route.channels && route.channels.length > 0) {
                if (!route.channels.includes(midiChannel)) {
                    continue;  // Не этот канал — пропускаем
                }
            }
            
            const midiOut = this.outputs.get(route.outputId);
            if (midiOut) {
                try {
                    midiOut.sendMessage(message);

                    // Логируем в консоль сервера
                    parentPort.postMessage({
                        type: 'midi-routed',
                        inputId: inputPortId,
                        outputId: route.outputId,
                        message: message
                    });
                } catch (e) {
                    // Игнорируем ошибки отправки — не блокируем роутинг
                }
            }
        }

        // Сбрасываем счётчик при успешной маршрутизации
        if (this.discoveryState.unroutedCounters.has(inputPortId)) {
            this.discoveryState.unroutedCounters.set(inputPortId, 0);
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
    _sendConfirmationNote(outputId, channel = null) {
        const targetPort = this.outputs.get(outputId);
        if (!targetPort) return;

        try {
            for (let i = 0; i < 2; i++) {
                setTimeout(() => {
                    const noteOn = [0x90 | (channel ?? 0), 0x3C, 0x7F];
                    targetPort.sendMessage(noteOn);
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
    _pingSynth(targetId, controllerId) {
        let sentCount = 0;
        const maxPings = 5;

        console.log(`[WORKER] Pinging ${targetId} (controller: ${controllerId}, ${maxPings} times, 1s interval)`);

        const pingOnce = () => {
            if (sentCount >= maxPings) {
                // Все ноты отправлены без ответа — таймаут
                console.log(`[WORKER] Auto-connect timeout for ${targetId} → skipping`);
                this._nextSynthForController(controllerId);
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

    /** Перейти к следующему синтезатору для конкретного контроллера */
    _nextSynthForController(controllerId) {
        const controllerState = this.discoveryState.controllers.get(controllerId);
        if (!controllerState) return;

        // Если все цели подключены — завершаем discovery для этого контроллера
        const allConnected = controllerState.connectedTargets.size === controllerState.targets.length;
        if (allConnected && controllerState.targets.length > 0) {
            console.log(`[WORKER] Controller ${controllerId}: all ${controllerState.targets.length} synths connected`);
            this.discoveryState.controllers.delete(controllerId);

            // Если все контроллеры завершены — останавливаем discovery
            if (this.discoveryState.controllers.size === 0) {
                console.log('[WORKER] Auto-connect: all controllers connected to their synths');
                this._endDiscovery();
            }
            return;
        }

        // Ищем следующий НЕ подключённый синтезатор
        let found = false;
        const startIdx = controllerState.currentTargetIdx;
        
        for (let i = 0; i < controllerState.targets.length; i++) {
            const idx = (startIdx + i) % controllerState.targets.length;
            if (!controllerState.connectedTargets.has(controllerState.targets[idx])) {
                controllerState.currentTargetIdx = idx;
                found = true;
                break;
            }
        }

        // Если все remaining цели таймаутили — удаляем контроллер (все synths не ответили)
        if (!found) {
            console.log(`[WORKER] Controller ${controllerId}: all targets timed out, removing`);
            this.discoveryState.controllers.delete(controllerId);

            // Если все контроллеры завершены — останавливаем discovery
            if (this.discoveryState.controllers.size === 0) {
                console.log('[WORKER] Auto-connect: no more controllers to ping');
                this._endDiscovery();
            }
            return;
        }

        const self = this;
        setTimeout(() => {
            self._pingAllSynths();
        }, 100);
    }

    /** Запустить автоматическое соединение всех устройств */
    startAutoConnect() {
        console.log('[WORKER] Starting auto-connect mode...');

        // Если discovery уже активен — не запускаем повторно
        if (this.discoveryState.active) {
            console.log('[WORKER] Auto-discovery already active, skipping restart');
            return;
        }

        // Собираем все unrouted INPUT порты — это потенциальные контроллеры
        const allInputs = [];
        for (const [inputId, port] of this.inputs) {
            if (!this.routes.has(inputId) || this.routes.get(inputId).length === 0) {
                allInputs.push({ id: inputId, name: port._name || 'unknown' });
            }
        }

        console.log(`[WORKER] Found ${allInputs.length} unrouted inputs`);
        for (const inp of allInputs) {
            console.log(`  - ${inp.id}: ${inp.name}`);
        }

        if (allInputs.length === 0) {
            console.log('[WORKER] No unrouted inputs found');
            return;
        }

        // Собираем OUTPUT порты как потенциальные синтезаторы
        const allOutputs = [];
        for (const [outputId, port] of this.outputs) {
            if (!this.routes.has(outputId) || this.routes.get(outputId).length === 0) {
                allOutputs.push({ id: outputId, name: port._name || 'unknown' });
            }
        }

        console.log(`[WORKER] Found ${allOutputs.length} unrouted outputs`);
        for (const out of allOutputs) {
            console.log(`  - ${out.id}: ${out.name}`);
        }

        if (allOutputs.length === 0) {
            console.log('[WORKER] No unrouted outputs found');
            return;
        }

        // Очищаем состояние discovery перед запуском
        this.discoveryState.controllers.clear();
        if (this.discoveryState.timer) {
            clearTimeout(this.discoveryState.timer);
            this.discoveryState.timer = null;
        }

        // Для каждого unrouted input создаём список целей из unrouted outputs
        // Исключаем output порты которые принадлежат тем же устройствам что и контроллеры (защита от self-routing)
        let controllersWithTargets = 0;
        for (const controller of allInputs) {
            const targets = allOutputs.filter(o => o.id !== controller.id).map(o => o.id);
            
            if (targets.length === 0) {
                console.log(`[WORKER] Controller ${controller.id} (${controller.name}) has no valid targets — skipping`);
                continue;
            }

            console.log(`[WORKER] Controller ${controller.id} (${controller.name}) → will connect to ${targets.length} synths`);
            controllersWithTargets++;

            this.discoveryState.controllers.set(controller.id, {
                targets: targets,
                connectedTargets: new Set(),
                currentTargetIdx: 0
            });
        }

        if (controllersWithTargets === 0) {
            console.log('[WORKER] No valid controller-target pairs found');
            return;
        }

        // Активируем discovery режим
        this.discoveryState.active = true;
        console.log(`[WORKER] Discovery active for ${this.discoveryState.controllers.size} controllers`);

        // Начинаем обзвон всех синтезаторов по кругу
        this._pingAllSynths();
    }

    /** Обзвонить все синты по кругу — циклически пока не подключатся все */
    _pingAllSynths() {
        // Если discovery больше не активен (все контроллеры завершены) — выходим
        if (this.discoveryState.controllers.size === 0) {
            console.log('[WORKER] Auto-connect: all controllers done');
            this._endDiscovery();
            return;
        }

        // Находим первого контроллера с ещё не подключёнными целями
        let foundController = null;
        for (const [controllerId, state] of this.discoveryState.controllers) {
            if (state.targets.length > 0 &&
                state.connectedTargets.size < state.targets.length &&
                state.currentTargetIdx < state.targets.length) {
                foundController = { id: controllerId, state };
                break;
            }
        }

        // Если все контроллеры подключились ко всем своим целям — завершаем
        if (!foundController) {
            console.log('[WORKER] Auto-connect: all controllers fully connected');
            this._endDiscovery();
            return;
        }

        const currentTarget = foundController.state.targets[foundController.state.currentTargetIdx];
        console.log(`[WORKER] Pinging ${currentTarget} (controller: ${foundController.id})`);
        this._pingSynth(currentTarget, foundController.id);
    }



    /** Завершить discovery режим */
    _endDiscovery() {
        if (this.discoveryState.timer) {
            clearTimeout(this.discoveryState.timer);
            this.discoveryState.timer = null;
        }
        this.discoveryState.active = false;
        this.discoveryState.controllers.clear();

        // Уведомляем сервер
        parentPort.postMessage({
            type: 'discovery-complete'
        });
    }

    /** Создать маршрут (channels = null → все каналы) */
    _createRoute(inputId, outputId, channels = null) {
        if (!outputId || !this.outputs.has(outputId)) {
            console.log(`[WORKER] Cannot create route: invalid outputId ${outputId} (not found in outputs)`);
            return;
        }
        const chStr = channels && channels.length > 0 ? ` (CH${channels.map(c => c + 1).join(',')})` : '';
        console.log(`[WORKER] Creating route: ${inputId} → ${outputId}${chStr}`);
        this.setRoute(inputId, outputId, channels);
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

    // Установить маршрут с фильтрацией по каналам (channels = null → все каналы)
    setRoute(inputId, outputId, channels = null) {
        if (!this.routes.has(inputId)) {
            this.routes.set(inputId, []);
        }

        const routeList = this.routes.get(inputId);
        
        // Проверяем — уже есть такой маршрут с этими каналами?
        for (const route of routeList) {
            if (route.outputId === outputId && JSON.stringify(route.channels) === JSON.stringify(channels)) {
                return;  // Уже существует
            }
        }

        // Добавляем новый маршрут с каналами
        routeList.push({
            outputId: outputId,
            channels: channels
        });

        // Сбрасываем счётчик unrouted для этого порта
        this.discoveryState.unroutedCounters.delete(inputId);

        // Формируем список всех outputId (для обратной совместимости)
        const allDestinations = routeList.map(r => r.outputId);

        // Подтверждаем маршрутизацию с каналами
        parentPort.postMessage({
            type: 'route-updated',
            inputId,
            outputId,
            channels: channels,  // null = все каналы
            allDestinations
        });
    }

    // Удалить маршрут по outputId и каналам
    removeRoute(inputId, outputId, channels = null) {
        const routeList = this.routes.get(inputId);
        if (routeList) {
            for (let i = routeList.length - 1; i >= 0; i--) {
                const route = routeList[i];
                // Удаляем если outputId совпадает и каналы совпадают
                if (route.outputId === outputId && JSON.stringify(route.channels) === JSON.stringify(channels)) {
                    routeList.splice(i, 1);
                    break;
                }
            }
            // Если маршрутов не осталось — удаляем запись
            if (routeList.length === 0) {
                this.routes.delete(inputId);
            }
        }

        parentPort.postMessage({
            type: 'route-removed',
            inputId,
            outputId,
            channels: channels
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
