import { cpus, totalmem, freemem } from 'os';
import { readFileSync, statfsSync } from 'fs';

const THERMAL_FILE = '/sys/class/thermal/thermal_zone0/temp';

function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const { times } of cpus()) {
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
}

// Pi health numbers for the page footer. Each reading is null when the host cannot provide it
// (no thermal zone on a Mac, for instance), so the UI simply leaves it out.
export class SystemStats {
    constructor({ readCpu = cpuTimes, readTemp = defaultTemp, readDisk = defaultDisk, readMem = defaultMem } = {}) {
        this.readCpu = readCpu;
        this.readTemp = readTemp;
        this.readDisk = readDisk;
        this.readMem = readMem;
        this.last = readCpu();
    }

    sample() {
        const now = this.readCpu();
        const total = now.total - this.last.total;
        const idle = now.idle - this.last.idle;
        this.last = now;
        return {
            cpu: total > 0 ? Math.round((1 - idle / total) * 100) : null,
            tempC: this.readTemp(),
            disk: this.readDisk(),
            mem: this.readMem(),
        };
    }
}

function defaultTemp() {
    try {
        const value = Number(readFileSync(THERMAL_FILE, 'utf8')) / 1000;
        return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    } catch {
        return null;
    }
}

function defaultDisk() {
    try {
        const stats = statfsSync('/');
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        return total > 0 ? { usedPercent: Math.round((1 - free / total) * 100), freeGb: Math.round(free / 1e8) / 10 } : null;
    } catch {
        return null;
    }
}

function defaultMem() {
    const total = totalmem();
    return total > 0 ? { usedPercent: Math.round((1 - freemem() / total) * 100) } : null;
}
