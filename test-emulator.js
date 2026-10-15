/* === USB-MIDI Device Emulator (ALSA-based) === */
// Emulates a controller and a synthesizer using the existing ALSA seq MIDI ports
// Works through a WebSocket connection to the router server

import { WebSocket } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

class MidiEmulator {
    constructor() {
        this.wsClient = null;
        this.serverProcess = null;
        this.connected = false;
        this.testResults = [];
        
        // Controller emulation (sends CC/NoteOn)
        this.controllerPortIndex = 0;
        this.controllerDeviceName = 'Emulated Controller';
        
        // Synthesizer emulation (receives MIDI)
        this.synthPortIndex = 1;
        this.synthDeviceName = 'Emulated Synth';
    }
    
    async start() {
        console.log('[EMULATOR] Starting USB-MIDI device emulator...\n');
        
        // Check that the server is running
        await this.checkServer();
        
        if (!this.connected) {
            await this.startServer();
            await this.waitForServer();
        }
        
        this.connectToServer();
    }
    
    async checkServer() {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 2000);
            
            const wsClient = new WebSocket('ws://localhost:8765');
            
            wsClient.on('open', () => {
                clearTimeout(timeout);
                console.log('[EMULATOR] Server already running');
                this.wsClient = wsClient;
                resolve(true);
            });
            
            wsClient.on('error', (err) => {
                clearTimeout(timeout);
                console.log('[EMULATOR] Server not running, will start it...');
                resolve(false);
            });
        });
    }
    
    async startServer() {
        console.log('\n[EMULATOR] Starting router server...\n');
        
        this.serverProcess = spawn('node', ['server.js'], {
            cwd: path.join(process.cwd()),
            stdio: 'pipe'
        });
        
        // Log the server output
        this.serverProcess.stdout.on('data', (data) => {
            console.log(`[SERVER] ${data.toString().trim()}`);
        });
        
        this.serverProcess.stderr.on('data', (data) => {
            console.error(`[SERVER ERROR] ${data.toString().trim()}`);
        });
    }
    
    async waitForServer() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Server startup timeout'));
            }, 30000); // 30 seconds to start
            
            // Periodically check the connection
            const checkInterval = setInterval(async () => {
                try {
                    await this.checkServer();
                    if (this.connected) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve(true);
                    }
                } catch (e) {
                    // Keep waiting
                }
            }, 1000);
        });
    }
    
    connectToServer() {
        this.wsClient = new WebSocket('ws://localhost:8765');
        
        this.wsClient.on('open', () => {
            console.log('[EMULATOR] Connected to router server\n');
            this.connected = true;
            
            // Subscribe to server events
            this.wsClient.send(JSON.stringify({
                type: 'subscribe',
                events: ['ports-enumerated', 'midi-routed', 'route-updated']
            }));
        });
        
        this.wsClient.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            this.handleServerMessage(msg);
        });
        
        this.wsClient.on('error', (err) => {
            console.error('[EMULATOR] WebSocket error:', err.message);
        });
    }
    
    handleServerMessage(msg) {
        switch (msg.type) {
            case 'ports-enumerated':
                console.log(`[EMULATOR] Found ${msg.inputs.length} inputs, ${msg.outputs.length} outputs`);
                
                // Find the ports for emulation
                if (msg.inputs.length > 0 && msg.outputs.length > 0) {
                    this.controllerPortIndex = parseInt(msg.inputs[0].id.split('_')[1]);
                    this.synthPortIndex = parseInt(msg.outputs[0].id.split('_')[1]);
                    
                    console.log(`[EMULATOR] Controller: ${msg.inputs[0].name} (index: ${this.controllerPortIndex})`);
                    console.log(`[EMULATOR] Synth: ${msg.outputs[0].name} (index: ${this.synthPortIndex})\n`);
                    
                    // Start the routing tests
                    this.startRoutingTest(msg);
                } else {
                    console.log('[EMULATOR] No ports available for emulation');
                }
                break;
                
            case 'midi-routed':
                console.log(`[TEST] MIDI routed: ${msg.inputId} → ${msg.outputId}`);
                this.testResults.push({
                    type: 'routed',
                    inputId: msg.inputId,
                    outputId: msg.outputId,
                    message: msg.message
                });
                
                // Check the test result
                if (this.testResults.length >= 3) {
                    this.reportResults();
                }
                break;
                
            case 'route-updated':
                console.log(`[TEST] Route updated: ${msg.inputId} → ${msg.outputId}`);
                this.testResults.push({
                    type: 'route',
                    inputId: msg.inputId,
                    outputId: msg.outputId
                });
                
                // Check the test result
                if (this.testResults.length >= 3) {
                    this.reportResults();
                }
                break;
        }
    }
    
    startRoutingTest(portsData) {
        console.log('[EMULATOR] Starting routing test sequence...\n');
        
        // Test 1: send CC from the controller (emulates a button press)
        setTimeout(() => {
            this.sendCCFromController(0, 1, 64);
            console.log('[TEST] Sent CC from controller to router\n');
            
            // Wait for routing
            setTimeout(() => {
                // Test 2: send NoteOn from the controller
                this.sendNoteOnFromController(0, 60, 127);
                console.log('[TEST] Sent NoteOn from controller to router\n');
                
                setTimeout(() => {
                    // Test 3: send CC from the synthesizer (emulates feedback)
                    this.sendCCFromSynth(0, 2, 127);
                    console.log('[TEST] Sent CC from synth to router\n');
                    
                    // Wait for the tests to finish
                    setTimeout(() => {
                        this.reportResults();
                    }, 3000);
                }, 1500);
            }, 1500);
        }, 2000);
    }
    
    sendCCFromController(channel, controller, value) {
        // Controller emulation sends a CC message through WebSocket
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(JSON.stringify({
                type: 'send-midi',
                outputId: `output_${this.synthPortIndex}`,
                message: [0xB0 | channel, controller, value]
            }));
        }
    }
    
    sendNoteOnFromController(channel, note, velocity) {
        // Controller emulation sends a NoteOn message through WebSocket
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(JSON.stringify({
                type: 'send-midi',
                outputId: `output_${this.synthPortIndex}`,
                message: [0x90 | channel, note, velocity]
            }));
        }
    }
    
    sendCCFromSynth(channel, controller, value) {
        // Synthesizer emulation sends a CC message through WebSocket
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(JSON.stringify({
                type: 'send-midi',
                outputId: `output_${this.synthPortIndex}`,
                message: [0xB0 | channel, controller, value]
            }));
        }
    }
    
    reportResults() {
        console.log('\n[EMULATOR] Test Results Summary:');
        console.log('='.repeat(50));
        
        const routed = this.testResults.filter(r => r.type === 'routed');
        const routes = this.testResults.filter(r => r.type === 'route');
        
        console.log(`\nMessages Routed: ${routed.length}`);
        routed.forEach((result, i) => {
            console.log(`  ${i + 1}. ${JSON.stringify(result.message)} → ${result.outputId}`);
        });
        
        console.log(`\nRoutes Created: ${routes.length}`);
        routes.forEach((result, i) => {
            console.log(`  ${i + 1}. ${result.inputId} → ${result.outputId}`);
        });
        
        console.log('\n' + '='.repeat(50));
        this.stop();
    }
    
    stop() {
        console.log('\n[EMULATOR] Shutting down...');
        
        if (this.wsClient) {
            this.wsClient.close();
        }
        
        if (this.serverProcess) {
            setTimeout(() => {
                this.serverProcess.kill('SIGINT');
                process.exit(0);
            }, 1000);
        } else {
            process.exit(0);
        }
    }
}

// Start the emulator
const emulator = new MidiEmulator();

emulator.start().catch(err => {
    console.error('[EMULATOR] Startup error:', err.message);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n[EMULATOR] Interrupted');
    emulator.stop();
});
