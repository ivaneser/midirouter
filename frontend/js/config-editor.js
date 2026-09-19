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
        
        this._initEventListeners();
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
        console.log('[CONFIG] _renderMappings called, mappings:', Object.keys(this.config.mappings || {}));
        const container = document.getElementById('mapping-list');
        if (!container) {
            console.error('[CONFIG] mapping-list container not found');
            return;
        }
        
        container.innerHTML = '';
        
        const mappings = this.config.mappings || {};
        const inputPorts = this.app.deviceManager?.inputs || [];
        const outputPorts = this.app.deviceManager?.outputs || [];
        const devices = this.config.devices || {};
        
        console.log('[CONFIG] inputPorts:', inputPorts.length, 'outputPorts:', outputPorts.length);
        
        for (const [name, mapping] of Object.entries(mappings)) {
            try {
                const mappingEl = this._createMappingEditor(name, mapping, inputPorts, outputPorts, devices);
                container.appendChild(mappingEl);
                console.log('[CONFIG] Added mapping:', name);
            } catch (e) {
                console.error('[CONFIG] Error rendering mapping:', name, e);
            }
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
        
        // Auto-generate route name from selection
        const generateRouteName = () => {
            const selInputs = container.querySelector('.mapping-select')?.selectedOptions;
            const selOutputs = container.querySelectorAll('.mapping-select')[1]?.selectedOptions;
            if (!selInputs || !selOutputs) return name;
            const inName = selInputs[0]?.value === 'all' ? 'All' : getDisplayName(selInputs[0]?.value);
            const outName = selOutputs[0]?.value === 'all' ? 'All' : getDisplayName(selOutputs[0]?.value);
            return `${inName} → ${outName}`;
        };
        
        // Route name with delete button on same line
        const routeHeader = document.createElement('div');
        routeHeader.className = 'route-header';
        routeHeader.innerHTML = `
            <span class="route-name"></span>
            <button class="btn btn-danger btn-sm mapping-delete">Delete</button>
        `;
        container.appendChild(routeHeader);
        
        // Auto-generated route name
        const routeName = routeHeader.querySelector('.route-name');
        routeName.textContent = generateRouteName();
        
        // Inputs + Outputs side by side
        const rowDiv = document.createElement('div');
        rowDiv.className = 'mapping-row';
        
        const inputsDiv = document.createElement('div');
        inputsDiv.className = 'mapping-section';
        inputsDiv.innerHTML = '<h4>📥 Input (source)</h4>';
        const inputsSelect = document.createElement('select');
        inputsSelect.className = 'mapping-select';
        
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All inputs';
        if ((mapping.inputs || []).length === 0) allOption.selected = true;
        inputsSelect.appendChild(allOption);
        
        inputs.forEach(input => {
            const option = document.createElement('option');
            option.value = input.id;
            option.textContent = input.name; // Full ALSA name
            const inputIds = (mapping.inputs || []).map(i => typeof i === 'object' ? i.name : i);
            option.selected = inputIds.includes(input.id) || inputIds.includes(input.name);
            inputsSelect.appendChild(option);
        });
        inputsDiv.appendChild(inputsSelect);
        rowDiv.appendChild(inputsDiv);
        
        // Outputs
        const outputsDiv = document.createElement('div');
        outputsDiv.className = 'mapping-section';
        outputsDiv.innerHTML = '<h4>📤 Output (target)</h4>';
        const outputsSelect = document.createElement('select');
        outputsSelect.className = 'mapping-select';
        
        const allOptionOut = document.createElement('option');
        allOptionOut.value = 'all';
        allOptionOut.textContent = 'All outputs';
        if ((mapping.outputs || []).length === 0) allOptionOut.selected = true;
        outputsSelect.appendChild(allOptionOut);
        
        outputs.forEach(output => {
            const option = document.createElement('option');
            option.value = output.id;
            option.textContent = output.name; // Full ALSA name
            const outputIds = (mapping.outputs || []).map(o => typeof o === 'object' ? o.name : o);
            option.selected = outputIds.includes(output.id) || outputIds.includes(output.name);
            outputsSelect.appendChild(option);
        });
        outputsDiv.appendChild(outputsSelect);
        rowDiv.appendChild(outputsDiv);
        
        container.appendChild(rowDiv);
        
        // Filters (collapsed by default)
        const filtersDiv = document.createElement('div');
        filtersDiv.className = 'mapping-section filters-section';
        filtersDiv.innerHTML = '<h4>⚙️ Filters (optional)</h4>';
        
        // Channel filter — 16 toggle buttons
        const channelFilter = mapping.filters?.channels || {};
        const channelDiv = document.createElement('div');
        channelDiv.className = 'channel-buttons';
        const whitelist = channelFilter.whitelist || [];
        const allChannels = whitelist.length === 0; // true = all channels allowed (no filter)
        
        console.log('[CONFIG] Channel filter:', { whitelist, allChannels });
        
        for (let ch = 1; ch <= 16; ch++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'channel-btn' + (allChannels || whitelist.includes(ch) ? ' active' : '');
            btn.textContent = ch;
            btn.dataset.channel = ch;
            channelDiv.appendChild(btn);
        }
        filtersDiv.appendChild(channelDiv);
        
        container.appendChild(filtersDiv);
        
        // Event listeners
        const deleteBtn = container.querySelector('.mapping-delete');
        const channelBtns = container.querySelectorAll('.channel-btn');
        
        // Channel button toggle
        channelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
                console.log('[CONFIG] Channel toggled, active buttons:', Array.from(channelBtns).filter(b => b.classList.contains('active')).map(b => b.dataset.channel));
                saveOnChange();
            });
        });
        
        // Update route name display when selection changes
        const updateRouteName = () => {
            const inVal = inputsSelect.value;
            const outVal = outputsSelect.value;
            const inName = inVal === 'all' ? 'All' : getDisplayName(inVal);
            const outName = outVal === 'all' ? 'All' : getDisplayName(outVal);
            routeName.textContent = `${inName} → ${outName}`;
        };
        
        // Delete route
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const ws = window.app?.ws;
            console.log('[DELETE] Clicked, ws readyState:', ws?.readyState);
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                this.app.log('⚠️ Not connected — cannot delete route');
                return;
            }
            if (confirm('Delete this route?')) {
                console.log('[DELETE] Deleting route:', name);
                delete this.config.mappings[name];
                this.app.log('🗑 Route deleted — applying...');
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
            
            // Update route name display
            updateRouteName();
            
            // Generate new name from input/output selection
            const inName = finalInputs.length > 0 ? getDisplayName(finalInputs[0]).replace(/[^a-zA-Z0-9]/g, '_') : 'all';
            const outName = finalOutputs.length > 0 ? getDisplayName(finalOutputs[0]).replace(/[^a-zA-Z0-9]/g, '_') : 'all';
            const newName = `${inName}_to_${outName}`;
            
            // Rename mapping if name changed
            if (newName !== name) {
                this.config.mappings[newName] = { ...this.config.mappings[name] };
                delete this.config.mappings[name];
                // Update all references to use newName
                const oldContainer = container;
                const inputPorts = this.app.deviceManager?.inputs || [];
                const outputPorts = this.app.deviceManager?.outputs || [];
                const devices = this.config.devices || {};
                const newContainer = this._createMappingEditor(newName, this.config.mappings[newName], inputPorts, outputPorts, devices);
                oldContainer.parentNode.replaceChild(newContainer, oldContainer);
            }
            
            // Update config
            this.config.mappings[newName] = {
                inputs: finalInputs,
                outputs: finalOutputs,
                filters: {}
            };
            
            // Channel filter — collect active buttons
            const activeChannels = [];
            channelBtns.forEach(btn => {
                if (btn.classList.contains('active')) {
                    activeChannels.push(parseInt(btn.dataset.channel));
                }
            });
            if (activeChannels.length > 0 && activeChannels.length < 16) {
                this.config.mappings[newName].filters.channels = { whitelist: activeChannels };
            } else {
                delete this.config.mappings[newName].filters.channels;
            }
            
            console.log('[CONFIG] Filters:', JSON.stringify(this.config.mappings[newName].filters));
            this._renderJSON();
            this._saveToServer();
        };
        
        inputsSelect.addEventListener('change', saveOnChange);
        outputsSelect.addEventListener('change', saveOnChange);
        
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
        // Save the current config (already updated in memory from UI changes)
        this.app.log('💾 Saving configuration...');
        this._saveToServer();
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
        const ws = window.app?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('[CONFIG] Sending config to server...');
            ws.send(JSON.stringify({
                type: 'save-config',
                config: this.config
            }));
        } else {
            console.warn('[CONFIG] WebSocket not open, cannot save');
        }
    }
    
    // Handle config saved message from server
    handleConfigSaved() {
        this._showNotification('✅ Configuration saved to config.json', 'success');
    }
}
