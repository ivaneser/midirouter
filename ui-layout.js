import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

// Order of the page sections, kept across server restarts (ui-layout.json).
export class UiLayoutSettings {
    constructor(path) {
        this.path = path;
        this.order = [];
        try {
            if (existsSync(path)) this.order = UiLayoutSettings.clean(JSON.parse(readFileSync(path, 'utf8')).order);
        } catch (error) {
            console.error('[SERVER] Could not load UI layout:', error.message);
        }
    }

    static clean(order) {
        if (!Array.isArray(order)) return [];
        return [...new Set(order.filter(key => typeof key === 'string' && /^[a-z0-9-]{1,40}$/.test(key)))].slice(0, 30);
    }

    set(order) {
        const next = UiLayoutSettings.clean(order);
        writeFileSync(`${this.path}.tmp`, JSON.stringify({ order: next }, null, 2));
        renameSync(`${this.path}.tmp`, this.path);
        this.order = next;
        return next;
    }
}
