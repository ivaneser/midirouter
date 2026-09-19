/* === USB-MIDI Device Emulator (ALSA-based) === */
// Эмулирует контроллер и синтезатор используя существующие MIDI порты ALSA seq
// Работает через WebSocket подключение к серверу роутера

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
        
        // Эмуляция контроллера (отправляет CC/NoteOn)
        this.controllerPortIndex = 0;
        this.controllerDeviceName = 'Emulated Controller';
        
        // Эмуляция синтезатора (принимает MIDI)
        this.synthPortIndex = 1;
        this.synthDeviceName = 'Emulated Synth';
    }
    
    async start() {
        console.log('[EMULATOR] Starting USB-MIDI device emulator...\n');
        
        // Проверяем что сервер запущен
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
        
        // Логируем вывод сервера
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
            }, 30000); // 30 секунд на запуск
            
            // Периодически проверяем подключение
            const checkInterval = setInterval(async () => {
                try {
                    await this.checkServer();
                    if (this.connected) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve(true);
                    }
                } catch (e) {
                    // Продолжаем ждать
                }
            }, 1000);
        });
    }
    
    connectToServer() {
        this.wsClient = new WebSocket('ws://localhost:8765');
        
        this.wsClient.on('open', () => {
            console.log('[EMULATOR] Connected to router server\n');
            this.connected = true;
            
            // Подписываемся на события сервера
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
                
                // Находим порты для эмуляции
                if (msg.inputs.length > 0 && msg.outputs.length > 0) {
                    this.controllerPortIndex = parseInt(msg.inputs[0].id.split('_')[1]);
                    this.synthPortIndex = parseInt(msg.outputs[0].id.split('_')[1]);
                    
                    console.log(`[EMULATOR] Controller: ${msg.inputs[0].name} (index: ${this.controllerPortIndex})`);
                    console.log(`[EMULATOR] Synth: ${msg.outputs[0].name} (index: ${this.synthPortIndex})\n`);
                    
                    // Начинаем тестирование маршрутизации
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
                
                // Проверяем результат тестирования
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
                
                // Проверяем результат тестирования
                if (this.testResults.length >= 3) {
                    this.reportResults();
                }
                break;
        }
    }
    
    startRoutingTest(portsData) {
        console.log('[EMULATOR] Starting routing test sequence...\n');
        
        // Тест 1: Отправляем CC от контроллера (эмуляция нажатия кнопки)
        setTimeout(() => {
            this.sendCCFromController(0, 1, 64);
            console.log('[TEST] Sent CC from controller to router\n');
            
            // Ждём маршрутизации
            setTimeout(() => {
                // Тест 2: Отправляем NoteOn от контроллера
                this.sendNoteOnFromController(0, 60, 127);
                console.log('[TEST] Sent NoteOn from controller to router\n');
                
                setTimeout(() => {
                    // Тест 3: Отправляем CC от синтезатора (эмуляция обратной связи)
                    this.sendCCFromSynth(0, 2, 127);
                    console.log('[TEST] Sent CC from synth to router\n');
                    
                    // Ждём завершения тестирования
                    setTimeout(() => {
                        this.reportResults();
                    }, 3000);
                }, 1500);
            }, 1500);
        }, 2000);
    }
    
    sendCCFromController(channel, controller, value) {
        // Эмуляция контроллера отправляет CC сообщение через WebSocket
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(JSON.stringify({
                type: 'send-midi',
                outputId: `output_${this.synthPortIndex}`,
                message: [0xB0 | channel, controller, value]
            }));
        }
    }
    
    sendNoteOnFromController(channel, note, velocity) {
        // Эмуляция контроллера отправляет NoteOn сообщение через WebSocket
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(JSON.stringify({
                type: 'send-midi',
                outputId: `output_${this.synthPortIndex}`,
                message: [0x90 | channel, note, velocity]
            }));
        }
    }
    
    sendCCFromSynth(channel, controller, value) {
        // Эмуляция синтезатора отправляет CC сообщение через WebSocket
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

// Запуск эмулятора
const emulator = new MidiEmulator();

emulator.start().catch(err => {
    console.error('[EMULATOR] Startup error:', err.message);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n[EMULATOR] Interrupted');
    emulator.stop();
});
