import midi from '@julusian/midi';

// Проверяем какие MIDI порты видит RtMidi (через ALSA seq)
console.log('=== RtMidi Port Detection ===\n');

try {
    const tempInput = new midi.Input();
    const inputCount = tempInput.getPortCount();
    console.log(`Total input ports: ${inputCount}`);
    
    for (let i = 0; i < inputCount; i++) {
        try {
            const name = tempInput.getPortName(i);
            console.log(`  Input ${i}: ${name}`);
        } catch (e) {
            console.log(`  Input ${i}: [error reading name]`);
        }
    }
    
    tempInput.closePort();
} catch (e) {
    console.error('Error enumerating inputs:', e.message);
}

try {
    const tempOutput = new midi.Output();
    const outputCount = tempOutput.getPortCount();
    console.log(`\nTotal output ports: ${outputCount}`);
    
    for (let i = 0; i < outputCount; i++) {
        try {
            const name = tempOutput.getPortName(i);
            console.log(`  Output ${i}: ${name}`);
        } catch (e) {
            console.log(`  Output ${i}: [error reading name]`);
        }
    }
    
    tempOutput.closePort();
} catch (e) {
    console.error('Error enumerating outputs:', e.message);
}

console.log('\n=== ALSA Sequencer Info ===');
// Показываем что видит ALSA seq напрямую
const fs = await import('fs');
try {
    const clients = fs.readFileSync('/proc/asound/seq/clients', 'utf-8');
    console.log(clients);
} catch (e) {
    console.error('Cannot read /proc/asound/seq/clients:', e.message);
}
