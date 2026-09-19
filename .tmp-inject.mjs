const midi = (await import('@julusian/midi')).default;
const out = new midi.Output();
out.openPort(0, 'injector');   // list index 0 = Midi Through loopback
console.log('injected noteOn 60 v100 -> Midi Through');
out.sendMessage([0x90, 60, 100]);
setTimeout(() => { out.sendMessage([0x80, 60, 0]); console.log('noteOff sent'); }, 300);
setTimeout(() => process.exit(0), 2000);
