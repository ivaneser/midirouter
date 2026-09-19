/* === Configuration Editor — визуальный редактор конфигурации MIDI Router === */

export class ConfigEditor {
    constructor(app) {
        this.app = app;
        this.config = {
            ignore: ["loopback", "timer", "announce"],
            devices: {},
            mappings: {}
        };
        this.currentTab = 'mappings';
        this.editingMapping = null;
        this.editingDevice = null;
        
        this._initTabs();
        this._initEventListeners();
    }
    
    _initTabs() {
        const tabs = document.querySelectorAll('.tab-btn');
        const contents = document.querySelectorAll('.tab-content');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                this._switchTab(targetTab);
            });
        });
    }
    
    _switchTab(tabName) {
        this.currentTab = tabName;
        
        // Update tabs
        document.querySelectorAll('.tab-btn').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        
        // Update content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `tab-${tabName}`);
        });
        
        // Refresh content
        if (tabName === 'mappings') this._renderMappings();
        else if (tabName === 'devices') this._renderDevices();
        else if (tabName === 'json') this._renderJSON();
    }
    
    _initEventListeners() {
        // Добавить маппинг
        document.getElementById('btn-add-mapping')?.addEventListener('click', () => {
            this._addMapping();
        });
        
        // Добавить устройство
        document.getElementById('btn-add-device')?.addEventListener('click', () => {
            this._addDevice();
        });
        
        // Сохранить конфигурацию
        document.getElementById('btn-save-config')?.addEventListener('click', () => {
            this._saveConfig();
        });
        
        // Загрузить конфигурацию
        document.getElementById('btn-load-config')?.addEventListener('click', () => {
            this._loadConfig();
        });
        
        // Форматировать JSON
        document.getElementById('btn-format-json')?.addEventListener('click', () => {
            this._formatJSON();
        });
        
        // Автообновление JSON при редактировании
        document.getElementById('config-json')?.addEventListener('input', (e) => {
            try {
                this.config = JSON.parse(e.target.value);
                this._syncUIFromConfig();
            } catch (e) {
                // Не обновляем UI при ошибке парсинга
            }
        });
        
        // Обработка hot-plug событий
        this._handleHotplugEvent = (msg) => {
            this._handleHotplug(msg);
        };
    }
    
    _handleHotplug(msg) {
        const { deviceName, action, direction } = msg;
        const emoji = action === 'added' ? '🔌' : '🔌';
        const directionLabel = direction === 'input' ? 'input' : 'output';
        const actionLabel = action === 'added' ? 'connected' : 'disconnected';
        
        // Show notification
        this._showNotification(`${emoji} ${deviceName} (${directionLabel}) — ${actionLabel}`);
        
        // Обновляем UI если нужно
        if (this.currentTab === 'mappings') {
            this._renderMappings();
        } else if (this.currentTab === 'devices') {
            this._renderDevices();
        }
        
        // Обновляем JSON
        this._renderJSON();
    }
    
    _showNotification(message, type = 'info') {
        const colors = {
            success: { bg: '#0a7c2e', border: '#4ade80' },
            error: { bg: '#8b0000', border: '#e94560' },
            info: { bg: '#0f3460', border: '#e94560' }
        };
        const c = colors[type] || colors.info;
        
        const notification = document.createElement('div');
        notification.className = 'hotplug-notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${c.bg};
            color: #eee;
            padding: 12px 20px;
            border-radius: 8px;
            border: 2px solid ${c.border};
            z-index: 1000;
            animation: slideIn 0.3s ease;
            font-size: 0.9rem;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
    
    // ---- Загрузка конфигурации ----
    loadConfig(config) {
        if (config) {
            this.config = { ...this.config, ...config };
            if (!this.config.ignore) this.config.ignore = ["loopback", "timer", "announce"];
            if (!this.config.devices) this.config.devices = {};
            if (!this.config.mappings) this.config.mappings = {};
        }
        this._syncUIFromConfig();
        this._renderMappings();
        this._renderDevices();
        this._renderJSON();
    }
    
    _syncUIFromConfig() {
        // Синхронизация UI с конфигурацией
        // (если нужно)
    }
    
    // ---- Рендеринг маппингов ----
    _renderMappings() {
        const container = document.getElementById('mapping-list');
        if (!container) return;
        
        container.innerHTML = '';
        
        const mappings = this.config.mappings || {};
        const inputPorts = this.app.deviceManager?.inputs || [];
        const outputPorts = this.app.deviceManager?.outputs || [];
        const devices = this.config.devices || {};
        
        for (const [name, mapping] of Object.entries(mappings)) {
            const mappingEl = this._createMappingEditor(name, mapping, inputPorts, outputPorts, devices);
            container.appendChild(mappingEl);
        }
        
        if (Object.keys(mappings).length === 0) {
            container.innerHTML = '<p class="empty-state">No routes yet. Click "+ Add Route" to create one.</p>';
        }
    }
    
    _createMappingEditor(name, mapping, inputs, outputs, devices) {
        const container = document.createElement('div');
        container.className = 'mapping-editor';
        
        // Helper: get display name (nickname if exists, else full name)
        const getDisplayName = (portId) => {
            // Handle objects from loaded config (e.g. {name: '...', channels: null})
            if (typeof portId === 'object' && portId !== null) {
                return portId.name || String(portId);
            }
            portId = String(portId);
            for (const [nick, dev] of Object.entries(devices || {})) {
                if (dev.name && portId.startsWith(dev.name)) return nick;
            }
            return portId.split(':')[0]; // Just the base name
        };
        
        // Header
        const header = document.createElement('div');
        header.className = 'mapping-header';
        header.innerHTML = `
            <input type="text" class="mapping-name" value="${name}" placeholder="route name">
            <button class="btn btn-danger btn-sm mapping-delete">Delete</button>
        `;
        container.appendChild(header);
        
        // Route summary
        const summary = document.createElement('div');
        summary.className = 'route-summary';
        const inputNames = (mapping.inputs || []).map(id => getDisplayName(id)).join(', ') || 'All inputs';
        const outputNames = (mapping.outputs || []).map(id => getDisplayName(id)).join(', ') || 'All outputs';
        summary.innerHTML = `<strong>${inputNames}</strong> → <strong>${outputNames}</strong>`;
        container.appendChild(summary);
        
        // Inputs
        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'mapping-section';
        inputsDiv.innerHTML = '<h4>📥 Input (source)</h4>';
        const inputsSelect = document.createElement('select');
        inputsSelect.className = 'mapping-select';
        inputsSelect.multiple = true;
        inputsSelect.size = Math.min(inputs.length, 5);
        
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All inputs';
        if ((mapping.inputs || []).length === 0) allOption.selected = true;
        inputsSelect.appendChild(allOption);
        
        inputs.forEach(input => {
            const option = document.createElement('option');
            option.value = input.id;
            option.textContent = getDisplayName(input.id);
            option.selected = (mapping.inputs || []).includes(input.id);
            inputsSelect.appendChild(option);
        });
        inputsDiv.appendChild(inputsSelect);
        container.appendChild(inputsDiv);
        
        // Outputs
        const outputsDiv = document.createElement('div');
        outputsDiv.className = 'mapping-section';
        outputsDiv.innerHTML = '<h4>📤 Output (target)</h4>';
        const outputsSelect = document.createElement('select');
        outputsSelect.className = 'mapping-select';
        outputsSelect.multiple = true;
        outputsSelect.size = Math.min(outputs.length, 5);
        
        const allOptionOut = document.createElement('option');
        allOptionOut.value = 'all';
        allOptionOut.textContent = 'All outputs';
        if ((mapping.outputs || []).length === 0) allOptionOut.selected = true;
        outputsSelect.appendChild(allOptionOut);
        
        outputs.forEach(output => {
            const option = document.createElement('option');
            option.value = output.id;
            option.textContent = getDisplayName(output.id);
            option.selected = (mapping.outputs || []).includes(output.id);
            outputsSelect.appendChild(option);
        });
        outputsDiv.appendChild(outputsSelect);
        container.appendChild(outputsDiv);
        
        // Filters (collapsed by default)
        const filtersDiv = document.createElement('div');
        filtersDiv.className = 'mapping-section filters-section';
        filtersDiv.innerHTML = '<h4>⚙️ Filters (optional)</h4>';
        
        // Channel filter
        const channelFilter = mapping.filters?.channels || {};
        const channelDiv = document.createElement('div');
        channelDiv.className = 'filter-group';
        channelDiv.innerHTML = `
            <label>Channel:</label>
            <select class="filter-select channel-mode">
                <option value="none" ${(channelFilter.whitelist?.length === 0 && channelFilter.blacklist?.length === 0) ? 'selected' : ''}>All channels</option>
                <option value="whitelist" ${(channelFilter.whitelist?.length > 0) ? 'selected' : ''}>Whitelist</option>
                <option value="blacklist" ${(channelFilter.blacklist?.length > 0) ? 'selected' : ''}>Blacklist</option>
            </select>
            <input type="text" class="filter-input channel-values" placeholder="1,2,3" value="${channelFilter.whitelist?.join(',') || channelFilter.blacklist?.join(',') || ''}">
        `;
        filtersDiv.appendChild(channelDiv);
        
        // Velocity filter
        const velocityFilter = mapping.filters?.velocity || {};
        const velocityDiv = document.createElement('div');
        velocityDiv.className = 'filter-group';
        velocityDiv.innerHTML = `
            <label>Velocity:</label>
            <select class="filter-select velocity-mode">
                <option value="none" ${!velocityFilter.min && !velocityFilter.max ? 'selected' : ''}>None</option>
                <option value="clip" ${velocityFilter.mode === 'clip' ? 'selected' : ''}>Clip</option>
                <option value="drop" ${velocityFilter.mode === 'drop' ? 'selected' : ''}>Drop</option>
                <option value="scaled" ${velocityFilter.mode === 'scaled' ? 'selected' : ''}>Scaled</option>
            </select>
            <div class="velocity-inputs">
                <input type="number" class="filter-input velocity-min" placeholder="Min" min="0" max="127" value="${velocityFilter.min || ''}">
                <input type="number" class="filter-input velocity-max" placeholder="Max" min="0" max="127" value="${velocityFilter.max || ''}">
            </div>
        `;
        filtersDiv.appendChild(velocityDiv);
        
        container.appendChild(filtersDiv);
        
        // Event listeners
        const nameInput = container.querySelector('.mapping-name');
        const deleteBtn = container.querySelector('.mapping-delete');
        const channelMode = container.querySelector('.channel-mode');
        const channelValues = container.querySelector('.channel-values');
        const velocityMode = container.querySelector('.velocity-mode');
        const velocityMin = container.querySelector('.velocity-min');
        const velocityMax = container.querySelector('.velocity-max');
        
        // Delete route
        deleteBtn.addEventListener('click', () => {
            if (confirm(`Delete route "${name}"?`)) {
                delete this.config.mappings[name];
                this._renderMappings();
                this._saveToServer();
            }
        });
        
        // Rename route
        nameInput.addEventListener('change', (e) => {
            const newName = e.target.value.trim();
            if (newName && newName !== name) {
                this.config.mappings[newName] = this.config.mappings[name];
                delete this.config.mappings[name];
                this._renderMappings();
                this._saveToServer();
            }
        });
        
        // Save on change
        const saveOnChange = () => {
            const selectedInputs = Array.from(inputsSelect.selectedOptions).map(o => o.value);
            const selectedOutputs = Array.from(outputsSelect.selectedOptions).map(o => o.value);
            
            // Remove "all" if specific devices selected
            let finalInputs = selectedInputs.filter(v => v !== 'all');
            let finalOutputs = selectedOutputs.filter(v => v !== 'all');
            
            // "All" means empty array (route everything)
            if (selectedInputs.includes('all')) finalInputs = [];
            if (selectedOutputs.includes('all')) finalOutputs = [];
            
            // Get route name
            const mappingName = nameInput.value.trim() || name;
            
            // Update config
            if (name !== mappingName) {
                delete this.config.mappings[name];
            }
            
            this.config.mappings[mappingName] = {
                inputs: finalInputs,
                outputs: finalOutputs,
                filters: {}
            };
            
            // Channel filter
            if (channelMode.value !== 'none' && channelValues.value.trim()) {
                const values = channelValues.value.split(',').map(v => parseInt(v.trim())).filter(v => !isNaN(v));
                if (channelMode.value === 'whitelist') {
                    this.config.mappings[mappingName].filters.channels = { whitelist: values };
                } else if (channelMode.value === 'blacklist') {
                    this.config.mappings[mappingName].filters.channels = { blacklist: values };
                }
            }
            
            // Velocity filter
            if (velocityMode.value !== 'none') {
                const min = parseInt(velocityMin.value);
                const max = parseInt(velocityMax.value);
                this.config.mappings[mappingName].filters.velocity = {
                    mode: velocityMode.value,
                    min: isNaN(min) ? 0 : min,
                    max: isNaN(max) ? 127 : max
                };
            }
            
            this._renderJSON();
            this._saveToServer();
        };
        
        inputsSelect.addEventListener('change', saveOnChange);
        outputsSelect.addEventListener('change', saveOnChange);
        channelMode.addEventListener('change', saveOnChange);
        channelValues.addEventListener('input', saveOnChange);
        velocityMode.addEventListener('change', saveOnChange);
        velocityMin.addEventListener('input', saveOnChange);
        velocityMax.addEventListener('input', saveOnChange);
        
        return container;
    }
    
    // ---- Device rendering ----
    _renderDevices() {
        const container = document.getElementById('device-config-list');
        if (!container) return;
        
        container.innerHTML = '';
        
        const devices = this.config.devices || {};
        
        for (const [name, device] of Object.entries(devices)) {
            const deviceEl = this._createDeviceEditor(name, device);
            container.appendChild(deviceEl);
        }
        
        if (Object.keys(devices).length === 0) {
            container.innerHTML = '<p class="empty-state">No devices defined. Click "+ Add Device" to add one.</p>';
        }
    }
    
    _createDeviceEditor(name, device) {
        const container = document.createElement('div');
        container.className = 'device-editor';
        
        container.innerHTML = `
            <div class="device-header">
                <input type="text" class="device-name" value="${name}" placeholder="nickname">
                <button class="btn btn-danger btn-sm device-delete">Delete</button>
            </div>
            <div class="device-fields">
                <input type="text" class="device-full-name" placeholder="Full device name" value="${device.name || ''}">
                <input type="number" class="device-port" placeholder="Port" min="0" value="${device.port ?? ''}">
            </div>
        `;
        
        const nameInput = container.querySelector('.device-name');
        const fullNameInput = container.querySelector('.device-full-name');
        const portInput = container.querySelector('.device-port');
        const deleteBtn = container.querySelector('.device-delete');
        
        // Delete device
        deleteBtn.addEventListener('click', () => {
            if (confirm(`Delete device "${name}"?`)) {
                delete this.config.devices[name];
                this._renderDevices();
                this._saveToServer();
            }
        });
        
        // Rename device
        nameInput.addEventListener('change', (e) => {
            const newName = e.target.value.trim();
            if (newName && newName !== name) {
                this.config.devices[newName] = this.config.devices[name];
                delete this.config.devices[name];
                this._renderDevices();
                this._saveToServer();
            }
        });
        
        // Save on change
        const saveOnChange = () => {
            const deviceName = nameInput.value.trim() || name;
            const fullName = fullNameInput.value.trim();
            const port = parseInt(portInput.value);
            
            if (name !== deviceName) {
                delete this.config.devices[name];
            }
            
            this.config.devices[deviceName] = {
                name: fullName,
                port: isNaN(port) ? 0 : port
            };
            
            this._renderJSON();
            this._saveToServer();
        };
        
        nameInput.addEventListener('change', saveOnChange);
        fullNameInput.addEventListener('input', saveOnChange);
        portInput.addEventListener('input', saveOnChange);
        
        return container;
    }
    
    // ---- Рендеринг JSON ----
    _renderJSON() {
        const textarea = document.getElementById('config-json');
        if (textarea) {
            textarea.value = JSON.stringify(this.config, null, 2);
        }
    }
    
    _formatJSON() {
        const textarea = document.getElementById('config-json');
        if (textarea) {
            try {
                const config = JSON.parse(textarea.value);
                textarea.value = JSON.stringify(config, null, 2);
            } catch (e) {
                alert('Ошибка форматирования: неверный JSON');
            }
        }
    }
    
    // ---- Добавление ----
    _addMapping() {
        const name = `mapping_${Object.keys(this.config.mappings).length + 1}`;
        this.config.mappings[name] = {
            inputs: [],
            outputs: [],
            filters: {}
        };
        this._renderMappings();
        this._renderJSON();
        this._saveToServer();
    }
    
    _addDevice() {
        const name = `device_${Object.keys(this.config.devices).length + 1}`;
        this.config.devices[name] = {
            name: '',
            port: 0
        };
        this._renderDevices();
        this._renderJSON();
        this._saveToServer();
    }
    
    // ---- Сохранение/загрузка ----
    _saveConfig() {
        const textarea = document.getElementById('config-json');
        if (textarea) {
            try {
                const config = JSON.parse(textarea.value);
                this.config = config;
                this._syncUIFromConfig();
                this._renderMappings();
                this._renderDevices();
                this._saveToServer();
            } catch (e) {
                alert('Ошибка: неверный JSON');
            }
        }
    }
    
    _loadConfig() {
        const textarea = document.getElementById('config-json');
        if (textarea) {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json';
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        try {
                            const config = JSON.parse(event.target.result);
                            this.loadConfig(config);
                        } catch (e) {
                            alert('Ошибка загрузки: неверный JSON');
                        }
                    };
                    reader.readAsText(file);
                }
            });
            fileInput.click();
        }
    }
    
    _saveToServer() {
        if (this.app.ws && this.app.ws.readyState === WebSocket.OPEN) {
            this.app.ws.send(JSON.stringify({
                type: 'save-config',
                config: this.config
            }));
        }
    }
    
    // Handle config saved message from server
    handleConfigSaved() {
        this._showNotification('✅ Configuration saved to config.json', 'success');
    }
}
