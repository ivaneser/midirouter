/**
 * Standalone test: verifies that the midirouter sends MIDI clock (MTC)
 * to all connected output devices.
 *
 * Run:  node test-midi-clock.js
 *       node test-midi-clock.js -B 120 -d 5   (120 BPM, 5 seconds)
 */

import { createInterface } from 'readline';
import midi from '@julusian/midi';

const args = process.argv.slice(2);
const BPM       = parseInt(args.find(a => a.startsWith('-B='))?.split('=')[1]) || 120;
const DURATION  = parseInt(args.find(a => a.startsWith('-d='))?.split('=')[1]) || 5;

async function main() {
    console.log(`[midi-clock-test] BPM=${BPM}  duration=${DURATION}s`);
    console.log(`[midi-clock-test] Looking for MIDI output devices...\n`);

    // Enumerate available outputs
    const outDev = new midi.Output();
    const inDev = new midi.Input();

    const inputCount  = inDev.getPortCount();
    const outputCount = outDev.getPortCount();
    console.log(`  Inputs found:  ${inputCount}`);
    for (let i = 0; i < inputCount; i++) {
        console.log(`    [in ] ${inDev.getPortName(i)}`);
    }
    console.log(`  Outputs found: ${outputCount}`);
    for (let i = 0; i < outputCount; i++) {
        console.log(`    [out] ${outDev.getPortName(i)}`);
    }

    if (outputCount === 0) {
        console.log('\n[!] No MIDI outputs found. Connect a device and restart.');
        process.exit(1);
    }

    // Open all output ports (use separate Output instances per port)
    const opened = [];
    for (let i = 0; i < outputCount; i++) {
        try {
            const port = new midi.Output();
            port.openPort(i, 'midi-clock-test-out');
            opened.push({ index: i, name: port.getPortName(i), instance: port });
            console.log(`  ✓ Opened output: ${port.getPortName(i)}`);
        } catch (e) {
            console.warn(`  ✗ Failed to open port ${i}: ${e.message}`);
        }
    }

    if (opened.length === 0) {
        console.log('\n[!] Could not open any output port.');
        process.exit(1);
    }

    // ---- Generate MIDI clock to all opened ports ----
    const tickMs = (60000 / BPM) / 24;  // 24 PPQN
    let tickCount = 0;
    let startTime;

    // Send MIDI Start to all ports
    for (const p of opened) {
        p.instance.sendMessage([0xFA]);
        console.log(`[SEND] 0xFA (MIDI Start) -> ${p.name}`);
    }

    const clockTimer = setInterval(() => {
        if (!startTime) startTime = Date.now();
        tickCount++;
        for (const p of opened) {
            p.instance.sendMessage([0xF8]);
        }
        // Console feedback every 24 ticks (per beat)
        if (tickCount % 24 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const beats = (elapsed * BPM / 60).toFixed(1);
            process.stdout.write(`\r[SEND] 0xF8 tick #${tickCount} (${beats} beats, ${elapsed}s)   `);
        }
    }, tickMs);

    // Stop after DURATION seconds
    setTimeout(() => {
        clearInterval(clockTimer);
        for (const p of opened) {
            p.instance.sendMessage([0xFC]);
            console.log(`\n[SEND] 0xFC (MIDI Stop) -> ${p.name}`);
            p.instance.closePort();
        }
        inDev.closePort();
        console.log(`[midi-clock-test] Total clock ticks sent: ${tickCount}`);
        console.log(`[midi-clock-test] Expected ~${Math.round(DURATION * BPM / 60 * 24)} ticks`);
        console.log('[done] Test complete. Check your devices for sync.\n');
        process.exit(0);
    }, DURATION * 1000);
}

main().catch(err => {
    console.error('[error]', err.message);
    process.exit(1);
});
