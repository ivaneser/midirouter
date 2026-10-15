/* === Port Manager — rendering of physical MIDI ports and drag-and-drop routing === */

class PortManager {
    constructor(deviceManager) {
        this.dm = deviceManager;
        this.inputs = [];  // [{ id, name }]
        this.outputs = []; // [{ id, name }]
        // routes: Map<inputId, [{ outputId, channels }]> — each route with channel filtering
        this.routes = new Map();
        this.dragState = null;   // { sourceId, type: 'input'|'output' }
    }

    /** Refresh the port list from the server */
    updatePorts(inputs, outputs) {
        this.inputs = inputs || [];
        this.outputs = outputs || [];
        this._render();
    }

    /** Refresh the routes */
    updateRoutes(routeMsg) {
        if (routeMsg.action === 'add') {
            const key = routeMsg.inputId;
            if (!this.routes.has(key)) this.routes.set(key, []);
            const dests = this.routes.get(key);
            // Check — is there already such a route with these channels?
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

    /** Remove the route input → output */
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

    /** Create a route input → output (no channels = all channels) */
    createRoute(inputId, outputId) {
        // Already checked in _onDrop — send to the server
        this.dm.createRoute(inputId, outputId);
    }

    /** Update the route's channel — send the new route with channels */
    _updateRouteChannels(inputId, channel) {
        const dests = this.routes.get(inputId);
        if (!dests || dests.length === 0) return;
        
        // If "ALL" (null) is selected — remove all existing routes and create one without a filter
        if (channel === null) {
            for (const route of [...dests]) {
                this.dm.removeRoute(inputId, route.outputId);
            }
            // Create a new route without channels
            if (dests.length > 0) {
                this.dm.createRoute(inputId, dests[0].outputId);
            }
        } else {
            // A specific channel is selected — remove the old routes and create one with the channel
            for (const route of [...dests]) {
                this.dm.removeRoute(inputId, route.outputId);
            }
            if (dests.length > 0) {
                this.dm.createRoute(inputId, dests[0].outputId, [channel]);
            }
        }
    }

    /** Render the whole ports section */
    _render() {
        const container = document.getElementById('port-section');
        if (!container) return;

        // If there is no section — create it
        if (container.id !== 'port-section') {
            this._injectPortSection();
        }

        this._renderPorts(container);
    }

    /** Insert the HTML of the ports section into the DOM */
    _injectPortSection() {
        const app = document.getElementById('app');
        const connectPanel = document.querySelector('.connect-panel');
        
        const sectionHTML = `
            <section id="port-section" class="port-section">
                <div class="port-column">
                    <h2>INPUTS (sources)</h2>
                    <div class="port-list input-ports"></div>
                </div>
                <div class="port-column outputs-column">
                    <h2>OUTPUTS (sinks)</h2>
                    <div class="port-list output-ports"></div>
                </div>
            </section>
        `;

        // Insert after connect-panel, before devices-container
        const devicesContainer = document.getElementById('devices-container');
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = sectionHTML;
        const newSection = tempDiv.firstElementChild;
        
        app.insertBefore(newSection, devicesContainer);
    }

    /** Render the port lists */
    _renderPorts(container) {
        const inputList = container.querySelector('.input-ports');
        const outputList = container.querySelector('.output-ports');

        // Render INPUTS
        if (this.inputs.length === 0 && this.outputs.length === 0) {
            inputList.innerHTML = '<p class="empty-hint">No connected MIDI devices</p>';
            outputList.innerHTML = '<p class="empty-hint">No available OUTPUT ports</p>';
            return;
        }

        // Clear if this is the first render (without empty hints)
        if (!container.dataset.rendered) {
            inputList.innerHTML = '';
            outputList.innerHTML = '';
        } else {
            // On re-render — update the existing ones or recreate them
            const existingInputIds = new Set([...inputList.querySelectorAll('.port-card')].map(c => c.dataset.portId));
            const newInputIds = new Set(this.inputs.map(i => i.id));

            // Remove the ones that disappeared
            for (const card of inputList.querySelectorAll('.port-card')) {
                if (!newInputIds.has(card.dataset.portId)) {
                    card.remove();
                }
            }
            // Add new ones
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

            // Update the visual state of the connections
            this._updateConnections();
        }

        container.dataset.rendered = 'true';
    }

    /** Create a port card */
    _createPortCard(port, type) {
        const card = document.createElement('div');
        card.className = `port-card ${type}`;
        card.dataset.portId = port.id;
        card.dataset.type = type;

        // Type marker icon
        const icon = document.createElement('span');
        icon.className = 'port-icon';
        icon.textContent = type === 'input' ? '▶' : '◀';

        // Port name
        const name = document.createElement('span');
        name.className = 'port-name';
        name.textContent = port.name;

        card.appendChild(icon);
        card.appendChild(name);

        // For INPUT: drag start + channel selector
        if (type === 'input') {
            card.draggable = true;
            card.addEventListener('dragstart', (e) => this._onDragStart(e, port.id));
            card.addEventListener('dragend', (e) => this._onDragEnd(e));

            // Add the channel selector
            const channelSelect = document.createElement('select');
            channelSelect.className = 'channel-selector';
            channelSelect.dataset.portId = port.id;
            
            // "All channels" option (default)
            const allOption = document.createElement('option');
            allOption.value = '';
            allOption.textContent = 'ALL';
            channelSelect.appendChild(allOption);
            
            // Channels 1-16
            for (let ch = 1; ch <= 16; ch++) {
                const opt = document.createElement('option');
                opt.value = ch;
                opt.textContent = `CH${ch}`;
                channelSelect.appendChild(opt);
            }
            
            // Channel update — send to the server
            channelSelect.addEventListener('change', () => {
                const newChannel = channelSelect.value ? parseInt(channelSelect.value) : null;
                this._updateRouteChannels(port.id, newChannel);
            });
            
            card.appendChild(channelSelect);

            // Click — remove all routes from this port
            card.addEventListener('dblclick', () => {
                const dests = this.routes.get(port.id);
                if (dests) {
                    for (const route of dests) {
                        this.removeRoute(port.id, route.outputId);
                    }
                }
            });
        }

        // For OUTPUT: drop target
        if (type === 'output') {
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                card.classList.add('drop-hover');
            });
            card.addEventListener('dragleave', () => {
                card.classList.remove('drop-hover');
            });
            card.addEventListener('drop', (e) => this._onDrop(e, port.id));

            // Double click — remove the route from this port
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

    /** Update the visual connection lines + channel selectors */
    _updateConnections() {
        // Add connected-state indicators on the cards
        for (const [inputId, routes] of this.routes) {
            const inputCard = document.querySelector(`.port-card[data-port-id="${inputId}"][data-type="input"]`);
            if (inputCard) {
                inputCard.classList.add('connected');
                // Show the number of connections
                let badge = inputCard.querySelector('.route-count');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'route-count';
                    inputCard.appendChild(badge);
                }
                badge.textContent = routes.length;

                // Update the channel selector
                const selector = inputCard.querySelector('.channel-selector');
                if (selector) {
                    // If all routes have no channels — select "ALL"
                    const allChannels = routes.every(r => !r.channels || r.channels.length === 0);
                    if (allChannels && routes.length > 0) {
                        selector.value = '';
                    } else if (!allChannels && routes.length > 0) {
                        // Take the channels of the first route
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
        // Remove hover from all OUTPUTs
        document.querySelectorAll('.port-card.drop-hover').forEach(c => c.classList.remove('drop-hover'));
    }

    _onDrop(e, outputId) {
        e.preventDefault();
        e.currentTarget.classList.remove('drop-hover');

        if (!this.dragState) return;

        const inputId = this.dragState.sourceId;

        // Cannot route to itself (although input→output are different types)
        if (inputId === outputId) return;

        // Check — is there already such a route?
        const existing = this.routes.get(inputId);
        if (existing && existing.some(r => r.outputId === outputId)) {
            console.log('[PortManager] Route already exists:', inputId, '→', outputId);
            return;
        }

        // Create the route — without channels (all channels)
        this.createRoute(inputId, outputId);

        // Visual feedback — a short highlight
        const outCard = e.currentTarget;
        outCard.classList.add('drop-success');
        setTimeout(() => outCard.classList.remove('drop-success'), 500);
    }

    /** Show the route confirmation dialog (Learning Mode) */
    showSuggestedRoute(data) {
        const modal = document.getElementById('suggested-route-modal');
        if (!modal) return;

        const inputName = data.inputName || data.inputId;
        // Show only the first output port as a suggestion
        const suggestedOutput = this.outputs[0]?.name || 'any available';
        
        document.getElementById('suggested-route-text').textContent = 
            `Signal detected from ${inputName}. Create route?`;

        modal.style.display = 'flex';

        // Save the data for the confirm button
        this._pendingRoute = data;
    }

    hideSuggestedRoute() {
        const modal = document.getElementById('suggested-route-modal');
        if (modal) modal.style.display = 'none';
        this._pendingRoute = null;
    }

    /** Accept the suggested route */
    acceptSuggestedRoute(outputId) {
        if (!this._pendingRoute) return;
        
        const data = this._pendingRoute;
        console.log('[PortManager] Accepting route:', data.inputId, '→', outputId);
        
        // Create the route through device-manager
        this.dm.createRoute(data.inputId, outputId);
        
        // Hide the modal
        this.hideSuggestedRoute();
    }

    /** Reject the suggested route */
    rejectSuggestedRoute() {
        console.log('[PortManager] Rejecting suggested route');
        this.hideSuggestedRoute();
    }
}
