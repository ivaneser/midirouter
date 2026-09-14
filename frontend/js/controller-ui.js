/* === Controller UI — рендеринг виртуальных контроллеров из JSON маппингов === */

class ControllerUI {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.deviceValues = new Map();  // deviceId → { ccNumber: value }
    }

    // Загрузить все устройства и отрендерить карточки
    async loadDevices() {
        const container = document.getElementById('devices-container');
        if (!container) return;

        const deviceFiles = [
            'korg_nts1',
            'modal_craft_synth_v2',
            'arturia_microfreak',
            'waldorf_blofeld',
            'preenfm2'
        ];

        for (const file of deviceFiles) {
            try {
                const data = await this._loadDeviceMap(file);
                if (data && data.model) {
                    container.appendChild(this._createCard(data));
                }
            } catch (e) {
                console.warn(`Failed to load ${file}:`, e);
            }
        }

        // Обновить счётчик устройств
        const countEl = document.getElementById('device-count');
        if (countEl) {
            countEl.textContent = `${container.children.length} устройств загружено`;
        }
    }

    async _loadDeviceMap(file) {
        const resp = await fetch(`/device_maps/${file}.json`);
        return resp.json();
    }

    // Создать HTML-карточку устройства
    _createCard(deviceData) {
        const card = document.createElement('div');
        card.className = 'device-card';

        const header = document.createElement('div');
        header.className = 'card-header';
        header.innerHTML = `
            <h2>${deviceData.manufacturer} ${deviceData.model}</h2>
            <span class="arrow">▶</span>
        `;

        const body = document.createElement('div');
        body.className = 'device-body';

        // Инициализация значений по умолчанию (64 для слайдеров, 0 для дропдаунов)
        this.deviceValues.set(deviceData.model, {});

        header.addEventListener('click', () => {
            const isOpen = body.classList.toggle('open');
            header.querySelector('.arrow').classList.toggle('open', isOpen);
        });

        // Рендеринг параметров в зависимости от структуры данных
        if (deviceData.controls) {
            this._renderFlatControls(body, deviceData.controls, deviceData);
        } else if (deviceData.controls_cc || deviceData.controls_nrpn) {
            // PreenFM2 — смешанный режим
            if (deviceData.controls_cc) {
                const ccSection = document.createElement('div');
                ccSection.className = 'section-title';
                ccSection.textContent = 'MIDI CC Controls';
                body.appendChild(ccSection);
                this._renderFlatControls(body, deviceData.controls_cc, deviceData);
            }
            if (deviceData.controls_nrpn?.parameters) {
                const nrpnSection = document.createElement('div');
                nrpnSection.className = 'section-title';
                nrpnSection.textContent = 'NRPN Controls';
                body.appendChild(nrpnSection);
                this._renderFlatControls(body, deviceData.controls_nrpn.parameters, deviceData, true);
            }
        } else {
            // Вложенная структура (Blofeld — osc1/osc2/filter/env...)
            const nestedKeys = Object.keys(deviceData).filter(k => k.startsWith('controls_'));
            for (const key of sortedNestedKeys(nestedKeys)) {
                const sectionTitle = document.createElement('div');
                sectionTitle.className = 'section-title';
                sectionTitle.textContent = this._formatSectionName(key);
                body.appendChild(sectionTitle);

                this._renderFlatControls(body, deviceData[key], deviceData);
            }
        }

        card.appendChild(header);
        card.appendChild(body);

        return card;
    }

    // Рендеринг плоского списка контролов
    _renderFlatControls(container, controls, deviceData, isNRPN = false) {
        for (const ctrl of controls) {
            const row = document.createElement('div');
            row.className = 'control-row' + (ctrl.primary ? ' primary' : '');

            // Label
            const label = document.createElement('span');
            label.className = 'control-label';
            label.textContent = ctrl.name;
            row.appendChild(label);

            // Контрол в зависимости от типа
            switch (ctrl.type) {
                case 'slider':
                    this._createSlider(row, ctrl, deviceData, isNRPN);
                    break;

                case 'dropdown':
                    this._createDropdown(row, ctrl, deviceData, isNRPN);
                    break;

                case 'toggle':
                    this._createToggle(row, ctrl, deviceData, isNRPN);
                    break;
            }

            container.appendChild(row);
        }
    }

    _createSlider(container, ctrl, deviceData, isNRPN) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'control-slider';
        slider.min = ctrl.min || 0;
        slider.max = ctrl.max || 127;
        slider.value = this.deviceValues.get(deviceData.model)[ctrl.cc] ?? Math.floor((ctrl.min + ctrl.max) / 2);

        const valueEl = document.createElement('span');
        valueEl.className = 'control-value';
        valueEl.textContent = slider.value;

        slider.addEventListener('input', () => {
            valueEl.textContent = slider.value;
            this.deviceValues.get(deviceData.model)[ctrl.cc] = parseInt(slider.value);

            // Отправка MIDI CC на порт устройства
            if (this.dm.ws?.readyState === WebSocket.OPEN) {
                const portId = deviceData.portId;  // Будет установлено при подключении устройства
                if (portId) {
                    this.dm.sendCC(portId, ctrl.cc, parseInt(slider.value));
                    this._log(`CC ${ctrl.cc} → ${slider.value} (${deviceData.model})`);
                }
            }
        });

        container.appendChild(slider);
        container.appendChild(valueEl);
    }

    _createDropdown(container, ctrl, deviceData, isNRPN) {
        const select = document.createElement('select');
        select.className = 'control-select';

        for (const opt of (ctrl.options || [])) {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            select.appendChild(option);
        }

        select.addEventListener('change', () => {
            this.deviceValues.get(deviceData.model)[ctrl.cc] = ctrl.options.indexOf(select.value);
            if (this.dm.ws?.readyState === WebSocket.OPEN) {
                const portId = deviceData.portId;
                if (portId) {
                    // Для дропдаунов отправляем индекс как значение CC
                    this.dm.sendCC(portId, ctrl.cc, ctrl.options.indexOf(select.value));
                    this._log(`Dropdown ${ctrl.name} → ${select.value}`);
                }
            }
        });

        container.appendChild(select);
    }

    _createToggle(container, ctrl, deviceData, isNRPN) {
        const btn = document.createElement('button');
        btn.className = 'control-toggle';
        btn.textContent = ctrl.options ? ctrl.options[0] : 'OFF';

        let state = 0; // 0 = off, 1 = on
        btn.addEventListener('click', () => {
            state = (state + 1) % 2;
            const isActive = state === 1;
            btn.classList.toggle('active', isActive);

            if (ctrl.options && ctrl.options.length > 1) {
                btn.textContent = ctrl.options[state];
            } else {
                btn.textContent = isActive ? 'ON' : 'OFF';
            }

            const threshold = ctrl.on_threshold || 64;
            const value = isActive ? 127 : 0;
            this.deviceValues.get(deviceData.model)[ctrl.cc] = value;

            if (this.dm.ws?.readyState === WebSocket.OPEN) {
                const portId = deviceData.portId;
                if (portId) {
                    this.dm.sendCC(portId, ctrl.cc, value);
                    this._log(`Toggle ${ctrl.name} → ${isActive ? 'ON' : 'OFF'}`);
                }
            }
        });

        container.appendChild(btn);
    }

    _formatSectionName(key) {
        // controls_osc1 → Oscillator 1, controls_filter2 → Filter 2
        return key.replace('controls_', '').replace(/(\d+)/g, ' $1').trim();
    }

    _log(message) {
        const logs = document.getElementById('logs');
        if (!logs) return;

        const entry = document.createElement('div');
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;
        logs.prepend(entry);

        // Ограничиваем количество логов
        while (logs.children.length > 100) {
            logs.removeChild(logs.lastChild);
        }
    }
}

// Вспомогательная функция для сортировки вложенных ключей
function sortedNestedKeys(keys) {
    const order = ['osc1', 'osc2', 'osc3', 'noise', 'filter1', 'filter2', 'env', 'lfo', 'arp', 'global'];
    return keys.sort((a, b) => {
        const keyA = a.replace('controls_', '');
        const keyB = b.replace('controls_', '');
        const idxA = order.indexOf(keyA);
        const idxB = order.indexOf(keyB);
        return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
    });
}

// Динамический рендеринг контроллеров из загруженной схемы устройства
ControllerUI.prototype.renderDynamicControls = function(deviceName, inputId, scheme) {
    const container = document.getElementById('devices-container');
    if (!container || !scheme) return;

    console.log(`[CONTROLLER-UI] Rendering dynamic controls for: ${deviceName}`);

    // Создаём карточку для динамического устройства
    const card = this._createDynamicCard(deviceName, inputId, scheme);
    container.appendChild(card);

    // Обновляем счётчик устройств
    const countEl = document.getElementById('device-count');
    if (countEl) {
        countEl.textContent = `${container.children.length} устройств`;
    }
};

ControllerUI.prototype._createDynamicCard = function(name, portId, scheme) {
    const card = document.createElement('div');
    card.className = 'device-card';

    // Header
    const header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML = `
        <h2>${name}</h2>
        <span class="arrow">▶</span>
    `;

    const body = document.createElement('div');
    body.className = 'device-body';

    // Инициализация значений по умолчанию
    this.deviceValues.set(name, {});

    header.addEventListener('click', () => {
        const isOpen = body.classList.toggle('open');
        header.querySelector('.arrow').classList.toggle('open', isOpen);
    });

    // Рендерим контролы из схемы
    if (scheme.controls) {
        this._renderFlatControls(body, scheme.controls, { model: name, portId: portId });
    } else if (scheme.controls_cc || scheme.controls_nrpn) {
        if (scheme.controls_cc) {
            const ccSection = document.createElement('div');
            ccSection.className = 'section-title';
            ccSection.textContent = 'MIDI CC Controls';
            body.appendChild(ccSection);
            this._renderFlatControls(body, scheme.controls_cc, { model: name, portId: portId });
        }
        if (scheme.controls_nrpn?.parameters) {
            const nrpnSection = document.createElement('div');
            nrpnSection.className = 'section-title';
            nrpnSection.textContent = 'NRPN Controls';
            body.appendChild(nrpnSection);
            this._renderFlatControls(body, scheme.controls_nrpn.parameters, { model: name, portId: portId }, true);
        }
    } else {
        // Вложенная структура (controls_osc1, controls_filter и т.д.)
        const nestedKeys = Object.keys(scheme).filter(k => k.startsWith('controls_'));
        for (const key of sortedNestedKeys(nestedKeys)) {
            const sectionTitle = document.createElement('div');
            sectionTitle.className = 'section-title';
            sectionTitle.textContent = this._formatSectionName(key);
            body.appendChild(sectionTitle);

            this._renderFlatControls(body, scheme[key], { model: name, portId: portId });
        }
    }

    card.appendChild(header);
    card.appendChild(body);

    return card;
};
