/* === Port Manager — рендеринг физических MIDI-портов и drag-and-drop маршрутизация === */

class PortManager {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.inputs = [];  // [{ id, name }]
        this.outputs = []; // [{ id, name }]
        // routes: Map<inputId, [{ outputId, channels }]> — каждый маршрут с фильтрацией по каналам
        this.routes = new Map();
        this.dragState = null;   // { sourceId, type: 'input'|'output' }
    }

    /** Обновить список портов из сервера */
    updatePorts(inputs, outputs) {
        this.inputs = inputs || [];
        this.outputs = outputs || [];
        this._render();
    }

    /** Обновить маршруты */
    updateRoutes(routeMsg) {
        if (routeMsg.action === 'add') {
            const key = routeMsg.inputId;
            if (!this.routes.has(key)) this.routes.set(key, []);
            const dests = this.routes.get(key);
            // Проверяем — уже есть такой маршрут с этими каналами?
            const exists = dests.some(r => r.outputId === routeMsg.outputId && JSON.stringify(r.channels) === JSON.stringify(routeMsg.channels));
            if (!exists) {
                dests.push({ outputId: routeMsg.outputId, channels: routeMsg.channels || null });
            }
        } else if (routeMsg.action === 'remove') {
            const dests = this.routes.get(routeMsg.inputId);
            if (dests) {
                for (let i = dests.length - 1; i >= 0; i--) {
                    if (dests[i].outputId === routeMsg.outputId &&
                        JSON.stringify(dests[i].channels) === JSON.stringify(routeMsg.channels)) {
                        dests.splice(i, 1);
                        break;
                    }
                }
                if (dests.length === 0) this.routes.delete(routeMsg.inputId);
            }
        }
        this._render();
    }

    /** Удалить маршрут input → output */
    removeRoute(inputId, outputId) {
        const dests = this.routes.get(inputId);
        if (dests) {
            for (let i = dests.length - 1; i >= 0; i--) {
                if (dests[i].outputId === outputId) {
                    dests.splice(i, 1);
                    break;
                }
            }
            if (dests.length === 0) this.routes.delete(inputId);
            this.dm.removeRoute(inputId, outputId);
        }
    }

    /** Создать маршрут input → output (без каналов = все каналы) */
    createRoute(inputId, outputId) {
        // Уже проверено в _onDrop — отправляем на сервер
        this.dm.createRoute(inputId, outputId);
    }

    /** Обновить канал маршрута — отправляем новый маршрут с каналами */
    _updateRouteChannels(inputId, channel) {
        const dests = this.routes.get(inputId);
        if (!dests || dests.length === 0) return;
        
        // Если выбран "ALL" (null) — удаляем все существующие маршруты и создаём один без фильтра
        if (channel === null) {
            for (const route of [...dests]) {
                this.dm.removeRoute(inputId, route.outputId);
            }
            // Создаём новый маршрут без каналов
            if (dests.length > 0) {
                this.dm.createRoute(inputId, dests[0].outputId);
            }
        } else {
            // Выбран конкретный канал — удаляем старые маршруты и создаём с каналом
            for (const route of [...dests]) {
                this.dm.removeRoute(inputId, route.outputId);
            }
            if (dests.length > 0) {
                this.dm.createRoute(inputId, dests[0].outputId, [channel]);
            }
        }
    }

    /** Отрисовать всю секцию портов */
    _render() {
        const container = document.getElementById('port-section');
        if (!container) return;

        // Если секции нет — создаём
        if (container.id !== 'port-section') {
            this._injectPortSection();
        }

        this._renderPorts(container);
    }

    /** Вставить HTML-секцию портов в DOM */
    _injectPortSection() {
        const app = document.getElementById('app');
        const connectPanel = document.querySelector('.connect-panel');
        
        const sectionHTML = `
            <section id="port-section" class="port-section">
                <div class="port-column">
                    <h2>INPUTS (источники)</h2>
                    <div class="port-list input-ports"></div>
                </div>
                <div class="port-column outputs-column">
                    <h2>OUTPUTS (приёмники)</h2>
                    <div class="port-list output-ports"></div>
                </div>
            </section>
        `;

        // Вставляем после connect-panel, перед devices-container
        const devicesContainer = document.getElementById('devices-container');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = sectionHTML;
        const newSection = tempDiv.firstElementChild;
        
        app.insertBefore(newSection, devicesContainer);
    }

    /** Отрисовать списки портов */
    _renderPorts(container) {
        const inputList = container.querySelector('.input-ports');
        const outputList = container.querySelector('.output-ports');

        // Рендерим INPUTS
        if (this.inputs.length === 0 && this.outputs.length === 0) {
            inputList.innerHTML = '<p class="empty-hint">Нет подключённых MIDI-устройств</p>';
            outputList.innerHTML = '<p class="empty-hint">Нет доступных OUTPUT портов</p>';
            return;
        }

        // Очищаем если это первый рендер (без пустых подсказок)
        if (!container.dataset.rendered) {
            inputList.innerHTML = '';
            outputList.innerHTML = '';
        } else {
            // При повторном рендере — обновляем существующие или пересоздаём
            const existingInputIds = new Set([...inputList.querySelectorAll('.port-card')].map(c => c.dataset.portId));
            const newInputIds = new Set(this.inputs.map(i => i.id));

            // Удаляем исчезнувшие
            for (const card of inputList.querySelectorAll('.port-card')) {
                if (!newInputIds.has(card.dataset.portId)) {
                    card.remove();
                }
            }
            // Добавляем новые
            for (const port of this.inputs) {
                if (!existingInputIds.has(port.id)) {
                    inputList.appendChild(this._createPortCard(port, 'input'));
                }
            }

            const existingOutputIds = new Set([...outputList.querySelectorAll('.port-card')].map(c => c.dataset.portId));
            const newOutputIds = new Set(this.outputs.map(o => o.id));

            for (const card of outputList.querySelectorAll('.port-card')) {
                if (!newOutputIds.has(card.dataset.portId)) {
                    card.remove();
                }
            }
            for (const port of this.outputs) {
                if (!existingOutputIds.has(port.id)) {
                    outputList.appendChild(this._createPortCard(port, 'output'));
                }
            }

            // Обновляем визуальное состояние подключений
            this._updateConnections();
        }

        container.dataset.rendered = 'true';
    }

    /** Создать карточку порта */
    _createPortCard(port, type) {
        const card = document.createElement('div');
        card.className = `port-card ${type}`;
        card.dataset.portId = port.id;
        card.dataset.type = type;

        // Иконка-маркер типа
        const icon = document.createElement('span');
        icon.className = 'port-icon';
        icon.textContent = type === 'input' ? '▶' : '◀';

        // Название порта
        const name = document.createElement('span');
        name.className = 'port-name';
        name.textContent = port.name;

        card.appendChild(icon);
        card.appendChild(name);

        // Для INPUT: drag start + канал-селектор
        if (type === 'input') {
            card.draggable = true;
            card.addEventListener('dragstart', (e) => this._onDragStart(e, port.id));
            card.addEventListener('dragend', (e) => this._onDragEnd(e));

            // Добавляем канал-селектор
            const channelSelect = document.createElement('select');
            channelSelect.className = 'channel-selector';
            channelSelect.dataset.portId = port.id;
            
            // Опция "Все каналы" (по умолчанию)
            const allOption = document.createElement('option');
            allOption.value = '';
            allOption.textContent = 'ALL';
            channelSelect.appendChild(allOption);
            
            // Каналы 1-16
            for (let ch = 1; ch <= 16; ch++) {
                const opt = document.createElement('option');
                opt.value = ch;
                opt.textContent = `CH${ch}`;
                channelSelect.appendChild(opt);
            }
            
            // Обновление канала — отправляем на сервер
            channelSelect.addEventListener('change', () => {
                const newChannel = channelSelect.value ? parseInt(channelSelect.value) : null;
                this._updateRouteChannels(port.id, newChannel);
            });
            
            card.appendChild(channelSelect);

            // Клик — удалить все маршруты из этого порта
            card.addEventListener('dblclick', () => {
                const dests = this.routes.get(port.id);
                if (dests) {
                    for (const route of dests) {
                        this.removeRoute(port.id, route.outputId);
                    }
                }
            });
        }

        // Для OUTPUT: drop target
        if (type === 'output') {
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                card.classList.add('drop-hover');
            });
            card.addEventListener('dragleave', () => {
                card.classList.remove('drop-hover');
            });
            card.addEventListener('drop', (e) => this._onDrop(e, port.id));

            // Двойной клик — удалить маршрут с этого порта
            card.addEventListener('dblclick', () => {
                for (const [inId, dests] of this.routes) {
                    for (let i = dests.length - 1; i >= 0; i--) {
                        if (dests[i].outputId === port.id) {
                            dests.splice(i, 1);
                            break;
                        }
                    }
                }
                this._render();
            });
        }

        return card;
    }

    /** Обновить визуальные линии подключений + канал-селекторы */
    _updateConnections() {
        // Добавляем индикаторы подключенных состояний на карточки
        for (const [inputId, routes] of this.routes) {
            const inputCard = document.querySelector(`.port-card[data-port-id="${inputId}"][data-type="input"]`);
            if (inputCard) {
                inputCard.classList.add('connected');
                // Показываем количество подключений
                let badge = inputCard.querySelector('.route-count');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'route-count';
                    inputCard.appendChild(badge);
                }
                badge.textContent = routes.length;

                // Обновляем канал-селектор
                const selector = inputCard.querySelector('.channel-selector');
                if (selector) {
                    // Если все маршруты без каналов — выбираем "ALL"
                    const allChannels = routes.every(r => !r.channels || r.channels.length === 0);
                    if (allChannels && routes.length > 0) {
                        selector.value = '';
                    } else if (!allChannels && routes.length > 0) {
                        // Берём каналы первого маршрута
                        const ch = routes[0].channels?.[0];
                        selector.value = ch || '';
                    }
                }

                for (const route of routes) {
                    const outCard = document.querySelector(`.port-card[data-port-id="${route.outputId}"][data-type="output"]`);
                    if (outCard) outCard.classList.add('connected');
                }
            }
        }
    }

    // === Drag-and-drop ===

    _onDragStart(e, inputId) {
        this.dragState = { sourceId: inputId };
        e.dataTransfer.effectAllowed = 'copy';
        e.target.classList.add('dragging');
    }

    _onDragEnd(e) {
        if (this.dragState) {
            const card = document.querySelector(`.port-card[data-port-id="${this.dragState.sourceId}"][data-type="input"]`);
            if (card) card.classList.remove('dragging');
            this.dragState = null;
        }
        // Убираем hover со всех OUTPUT
        document.querySelectorAll('.port-card.drop-hover').forEach(c => c.classList.remove('drop-hover'));
    }

    _onDrop(e, outputId) {
        e.preventDefault();
        e.currentTarget.classList.remove('drop-hover');

        if (!this.dragState) return;

        const inputId = this.dragState.sourceId;

        // Нельзя маршрутизировать в самого себя (хотя input→output это разные типы)
        if (inputId === outputId) return;

        // Проверяем — уже есть такой маршрут?
        const existing = this.routes.get(inputId);
        if (existing && existing.some(r => r.outputId === outputId)) {
            console.log('[PortManager] Route already exists:', inputId, '→', outputId);
            return;
        }

        // Создаём маршрут — без каналов (все каналы)
        this.createRoute(inputId, outputId);

        // Визуальный фидбэк — короткая подсветка
        const outCard = e.currentTarget;
        outCard.classList.add('drop-success');
        setTimeout(() => outCard.classList.remove('drop-success'), 500);
    }

    /** Показать диалог подтверждения маршрута (Learning Mode) */
    showSuggestedRoute(data) {
        const modal = document.getElementById('suggested-route-modal');
        if (!modal) return;

        const inputName = data.inputName || data.inputId;
        // Показываем только первый output порт как предложение
        const suggestedOutput = this.outputs[0]?.name || 'любой доступный';
        
        document.getElementById('suggested-route-text').textContent = 
            `Обнаружен сигнал с ${inputName}. Создать маршрут?`;

        modal.style.display = 'flex';

        // Сохраняем данные для кнопки подтверждения
        this._pendingRoute = data;
    }

    hideSuggestedRoute() {
        const modal = document.getElementById('suggested-route-modal');
        if (modal) modal.style.display = 'none';
        this._pendingRoute = null;
    }

    /** Принять предложенный маршрут */
    acceptSuggestedRoute(outputId) {
        if (!this._pendingRoute) return;
        
        const data = this._pendingRoute;
        console.log('[PortManager] Accepting route:', data.inputId, '→', outputId);
        
        // Создаём маршрут через device-manager
        this.dm.createRoute(data.inputId, outputId);
        
        // Скрываем модал
        this.hideSuggestedRoute();
    }

    /** Отклонить предложенный маршрут */
    rejectSuggestedRoute() {
        console.log('[PortManager] Rejecting suggested route');
        this.hideSuggestedRoute();
    }
}
