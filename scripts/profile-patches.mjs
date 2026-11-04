// Reads every PreenFM2 preset once and stores its whole patch (raw NRPN values) in
// device_maps/presets/preenfm2-patches.json, so the router can show a preset's knobs without asking the synth
// (the read-back disturbs the sound for a moment).
//   node scripts/profile-patches.mjs [http://pi:3000/mcp] [device] [channel] [first] [last]
// It plays on the given channel; run it with nothing else using that part. It resumes from the existing file.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [url = 'http://10.251.15.94:3000/mcp', device = 'PreenFM', channel = '1', first = '1', last = '1024'] = process.argv.slice(2);
const file = fileURLToPath(new URL('../device_maps/presets/preenfm2-patches.json', import.meta.url));
const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { nrpns: [], patches: {} };
let id = 0;
const call = async (name, args) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    const body = JSON.parse(text.includes('data:') ? text.split('\n').find(l => l.startsWith('data:')).slice(5) : text);
    if (body.error || body.result?.isError) throw new Error(JSON.stringify(body.error ?? body.result.content));
    return JSON.parse(body.result.content[0].text);
};
const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(data) .replace(/"patches":\{/, '"patches":{\n').replace(/\],"(\d+)":/g, '],\n"$1":') + '\n'); renameSync(`${file}.tmp`, file); };

for (let number = Number(first); number <= Number(last); number++) {
    if (data.patches[number]) continue;
    for (let attempt = 1; ; attempt++) {
        try {
            await call('select_preset', { device, preset: number, channel: Number(channel) });
            await new Promise(r => setTimeout(r, 700));
            const { raw } = await call('read_nrpn_patch', { device, channel: Number(channel), raw: true });
            if (raw.length < 100) throw new Error(`only ${raw.length} values`);
            const map = new Map(raw);
            // The first dump fixes the parameter list (and so every stored patch's positions).
            if (!data.nrpns.length) data.nrpns = raw.map(([nrpn]) => nrpn).sort((a, b) => a - b);
            data.patches[number] = data.nrpns.map(nrpn => map.get(nrpn) ?? null);
            break;
        } catch (error) {
            console.error(`preset ${number}: ${error.message} (attempt ${attempt})`);
            if (attempt >= 3) process.exit(1);
        }
    }
    if (number % 10 === 0) { save(); console.log(`${number} done`); }
}
save();
console.log('finished');
