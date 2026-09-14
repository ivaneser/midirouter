/* === Port Manager — рендеринг физических MIDI-портов и drag-and-drop маршрутизация === */

class PortManager {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.inputs = [];  // [{ id, name }]
        this.outputs = []; // [{ id, name }]
        this.routes = new Map(); // inputId → [outputIds]
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
            if (!dests.includes(routeMsg.outputId)) {
                dests.push(routeMsg.outputId);
            }
        } else if (routeMsg.action === 'remove') {
            const dests = this.routes.get(routeMsg.inputId);
            if (dests) {
                const idx = dests.indexOf(routeMsg.outputId);
                if (idx > -1) dests.splice(idx, 1);
                if (dests.length === 0) this.routes.delete(routeMsg.inputId);
            }
        }
        this._render();
    }

    /** Удалить маршрут input → output */
    removeRoute(inputId, outputId) {
        const dests = this.routes.get(inputId);
        if (dests) {
            const idx = dests.indexOf(outputId);
            if (idx > -1) dests.splice(idx, 1);
            this.dm.removeRoute(inputId);
        }
    }

    /** Создать маршрут input → output */
    createRoute(inputId, outputId) {
        // Уже проверено в _onDrop — отправляем на сервер
        this.dm.createRoute(inputId, outputId);
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

        // Для INPUT: drag start
        if (type === 'input') {
            card.draggable = true;
            card.addEventListener('dragstart', (e) => this._onDragStart(e, port.id));
            card.addEventListener('dragend', (e) => this._onDragEnd(e));

            // Клик — удалить все маршруты из этого порта
            card.addEventListener('dblclick', () => {
                const dests = this.routes.get(port.id);
                if (dests) {
                    for (const outId of dests) {
                        this.removeRoute(port.id, outId);
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
                    const idx = dests.indexOf(port.id);
                    if (idx > -1) {
                        dests.splice(idx, 1);
                        this.dm.removeRoute(inId, port.id);
                    }
                }
            });
        }

        return card;
    }

    /** Обновить визуальные линии подключений */
    _updateConnections() {
        // Добавляем индикаторы подключенных состояний на карточки
        for (const [inputId, outputIds] of this.routes) {
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
                badge.textContent = outputIds.length;

                for (const outId of outputIds) {
                    const outCard = document.querySelector(`.port-card[data-port-id="${outId}"][data-type="output"]`);
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
        if (existing && existing.includes(outputId)) {
            console.log('[PortManager] Route already exists:', inputId, '→', outputId);
            return;
        }

        // Создаём маршрут
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
