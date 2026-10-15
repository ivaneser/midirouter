/* === Controller UI — rendering of virtual controllers from JSON mappings === */

class ControllerUI {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.deviceValues = new Map();  // deviceId → { ccNumber: value }
    }

    // Load all devices and render the cards
    async loadDevices() {
        const container = document.getElementById('devices-container');
        if (!container) return;

        // Clear the container before loading — prevents duplicates on hot-plug
        container.innerHTML = '';

        // Do NOT load JSON files here — cards are created only for real devices
        // through _updateDeviceList() when the devices message arrives from the server
        
        // Update the device counter
        const countEl = document.getElementById('device-count');
        if (countEl) {
            countEl.textContent = `0 devices`;
        }
    }

    async _loadDeviceMap(file) {
        const resp = await fetch(`/device_maps/${file}.json`);
        return resp.json();
    }

    // Create the HTML card of a device
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

        // Initialize default values (64 for sliders, 0 for dropdowns)
        this.deviceValues.set(deviceData.model, {});

        header.addEventListener('click', () => {
            const isOpen = body.classList.toggle('open');
            header.querySelector('.arrow').classList.toggle('open', isOpen);
        });

        // Render parameters depending on the data structure
        if (deviceData.controls) {
            this._renderFlatControls(body, deviceData.controls, deviceData);
        } else if (deviceData.controls_cc || deviceData.controls_nrpn) {
            // PreenFM2 — mixed mode
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
            // Nested structure (Blofeld — osc1/osc2/filter/env...)
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

    // Render a flat list of controls
    _renderFlatControls(container, controls, deviceData, isNRPN = false) {
        for (const ctrl of controls) {
            const row = document.createElement('div');
            row.className = 'control-row' + (ctrl.primary ? ' primary' : '');

            // Label
            const label = document.createElement('span');
            label.className = 'control-label';
            label.textContent = ctrl.name;
            row.appendChild(label);

            // Control depending on its type
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

            // Send MIDI CC to the device port
            if (window.app?.ws?.readyState === WebSocket.OPEN) {
                const portId = deviceData.portId;  // Set when the device is connected
                if (portId) {
                    this.dm.sendMidi(portId, [0xB0, ctrl.cc, parseInt(slider.value)]);
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
            if (window.app?.ws?.readyState === WebSocket.OPEN) {
                const portId = deviceData.portId;
                if (portId) {
                    // For dropdowns send the index as the CC value
                    this.dm.sendMidi(portId, [0xB0, ctrl.cc, ctrl.options.indexOf(select.value)]);
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

            if (window.app?.ws?.readyState === WebSocket.OPEN) {
                const portId = deviceData.portId;
                if (portId) {
                    this.dm.sendMidi(portId, [0xB0, ctrl.cc, value]);
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

        // Limit the number of logs
        while (logs.children.length > 100) {
            logs.removeChild(logs.lastChild);
        }
    }
}

// Helper function to sort nested keys
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

// Dynamic rendering of controllers from the loaded device schema
ControllerUI.prototype.renderDynamicControls = function(deviceName, inputId, scheme) {
    const container = document.getElementById('devices-container');
    if (!container || !scheme) return;

    console.log(`[CONTROLLER-UI] Rendering dynamic controls for: ${deviceName}`);

    // Check whether there is already a card for this device (created through _createRealDeviceCard)
    const existingCards = container.querySelectorAll('.device-card[data-device-id]');
    let targetCard = null;
    
    for (const card of existingCards) {
        const h2 = card.querySelector('h2');
        if (h2 && h2.textContent === deviceName) {
            targetCard = card;
            break;
        }
    }

    // If the card already exists — just add the controls to the body of the existing card
    if (targetCard) {
        let body = targetCard.querySelector('.device-body');
        if (!body) {
            body = document.createElement('div');
            body.className = 'device-body';
            targetCard.appendChild(body);
        }
        
        // Clear old controls if there are any
        body.innerHTML = '';
        
        this._buildControlsFromBody(body, scheme, deviceName, inputId);
    } else {
        // No card — create a new one (for legacy compatibility)
        const card = this._createDynamicCard(deviceName, inputId, scheme);
        container.appendChild(card);

        // Update the device counter
        const countEl = document.getElementById('device-count');
        if (countEl) {
            countEl.textContent = `${container.querySelectorAll('.device-card[data-device-id]').length} devices`;
        }
    }
};

// Helper method — builds the controls from the schema and adds them to the body
ControllerUI.prototype._buildControlsFromBody = function(body, scheme, deviceName, inputId) {
    const renderData = { model: deviceName, portId: inputId };
    
    if (scheme.controls) {
        this._renderFlatControls(body, scheme.controls, renderData);
    } else if (scheme.controls_cc || scheme.controls_nrpn) {
        if (scheme.controls_cc) {
            const ccSection = document.createElement('div');
            ccSection.className = 'section-title';
            ccSection.textContent = 'MIDI CC Controls';
            body.appendChild(ccSection);
            this._renderFlatControls(body, scheme.controls_cc, renderData);
        }
        if (scheme.controls_nrpn?.parameters) {
            const nrpnSection = document.createElement('div');
            nrpnSection.className = 'section-title';
            nrpnSection.textContent = 'NRPN Controls';
            body.appendChild(nrpnSection);
            this._renderFlatControls(body, scheme.controls_nrpn.parameters, renderData, true);
        }
    } else {
        const nestedKeys = Object.keys(scheme).filter(k => k.startsWith('controls_'));
        for (const key of sortedNestedKeys(nestedKeys)) {
            const sectionTitle = document.createElement('div');
            sectionTitle.className = 'section-title';
            sectionTitle.textContent = this._formatSectionName(key);
            body.appendChild(sectionTitle);

            this._renderFlatControls(body, scheme[key], renderData);
        }
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

    // Initialize default values
    this.deviceValues.set(name, {});

    header.addEventListener('click', () => {
        const isOpen = body.classList.toggle('open');
        header.querySelector('.arrow').classList.toggle('open', isOpen);
    });

    // Render the controls from the schema
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
        // Nested structure (controls_osc1, controls_filter, etc.)
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
