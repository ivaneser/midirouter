/* Footer usage stats — formats the server's 'system-stats' messages. */

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatUptime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

/** Text and warning level for each footer field. */
export function formatSystemStats(stats) {
    const memPercent = stats.memTotal ? Math.round(100 * stats.memUsed / stats.memTotal) : NaN;
    const level = (value, warn, hot) => value >= hot ? 'hot' : value >= warn ? 'warn' : '';
    return {
        cpu: { text: Number.isFinite(stats.cpu) ? `${stats.cpu}%` : '—', level: level(stats.cpu, 70, 90) },
        load: { text: Number.isFinite(stats.load) ? stats.load.toFixed(2) : '—', level: '' },
        mem: {
            text: Number.isFinite(memPercent) ? `${formatBytes(stats.memUsed)} / ${formatBytes(stats.memTotal)} (${memPercent}%)` : '—',
            level: level(memPercent, 75, 90)
        },
        temp: { text: Number.isFinite(stats.tempC) ? `${stats.tempC.toFixed(1)} °C` : '—', level: level(stats.tempC, 70, 80) },
        rss: { text: formatBytes(stats.processRss), level: '' },
        uptime: { text: formatUptime(stats.uptime), level: '' }
    };
}

export function renderSystemStats(root, stats) {
    if (!root) return;
    for (const [key, { text, level }] of Object.entries(formatSystemStats(stats))) {
        const el = root.querySelector(`[data-stat="${key}"]`);
        if (!el) continue;
        el.textContent = text;
        el.className = level;
    }
}
