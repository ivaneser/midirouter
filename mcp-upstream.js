// Client for the mcpi MCP server (audio capture and sound analysis, Python). The router's single
// /mcp endpoint forwards those tools, so an LLM client connects once. mcpi owns no MIDI ports;
// the MIDI tools it used to offer live in mcp-server.js.
export const DEFAULT_UPSTREAM_TOOLS = [
    'record_audio', 'analyze_audio', 'start_recording', 'stop_recording', 'record_song',
    'profile_patch', 'profile_attached_synth', 'profile_device', 'probe_patch_params',
    'list_patch_sounds', 'get_patch_sound', 'get_patch_sample', 'refresh_patch_sample', 'render_patch_sample',
    'mcpi_guide',
];

const PROTOCOL = '2025-06-18';

// Streamable HTTP replies are either one JSON object or an SSE stream holding it.
async function readReply(response) {
    const text = await response.text();
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
        const events = text.split(/\r?\n\r?\n/).map(chunk => chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''));
        return JSON.parse(events.filter(Boolean).at(-1) || 'null');
    }
    return text ? JSON.parse(text) : null;
}

export function createUpstream({ url, allow = DEFAULT_UPSTREAM_TOOLS, token, timeoutMs = 120_000, fetchImpl = fetch } = {}) {
    if (!url) return null;
    let session = null;      // Mcp-Session-Id once initialized
    let ready = null;        // initialize promise
    let nextId = 1;
    let toolsCache = null;   // { at, tools }

    const headers = extra => ({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(session ? { 'Mcp-Session-Id': session } : {}),
        ...extra,
    });

    async function post(body) {
        return fetchImpl(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    }

    async function initialize() {
        const response = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'midirouter', version: '0.1.0' } } });
        if (!response.ok) throw new Error(`mcpi initialize failed: HTTP ${response.status}`);
        session = response.headers.get('mcp-session-id');
        await readReply(response);
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then(r => r.body?.cancel?.());
    }

    async function request(method, params, retry = true) {
        try {
            await (ready ??= initialize().catch(error => { ready = null; throw error; }));
            const response = await post({ jsonrpc: '2.0', id: nextId++, method, params });
            if (response.status === 404 && retry) { session = null; ready = null; return request(method, params, false); }
            if (!response.ok) throw new Error(`mcpi HTTP ${response.status}`);
            const reply = await readReply(response);
            if (reply?.error) throw new Error(reply.error.message || 'mcpi error');
            return reply?.result;
        } catch (error) {
            if (retry && !String(error.message).startsWith('mcpi')) { ready = null; session = null; return request(method, params, false); }
            throw error;
        }
    }

    return {
        has: name => allow.includes(name),
        // Forwarded tools; empty (never throws) while mcpi is not running.
        async listTools() {
            if (toolsCache && Date.now() - toolsCache.at < 30_000) return toolsCache.tools;
            try {
                const result = await request('tools/list', {});
                toolsCache = { at: Date.now(), tools: (result?.tools || []).filter(t => allow.includes(t.name)) };
            } catch (error) {
                toolsCache = { at: Date.now() - 25_000, tools: [] };   // retry in ~5s
            }
            return toolsCache.tools;
        },
        async callTool(name, args) {
            try {
                return await request('tools/call', { name, arguments: args || {} });
            } catch (error) {
                return { isError: true, content: [{ type: 'text', text: `mcpi (audio/analysis backend at ${url}) is unavailable: ${error.message}` }] };
            }
        },
    };
}
