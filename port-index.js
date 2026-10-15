/**
 * PortIndex — registry of MIDI ports by nicknames
 * Analogous to the PortIndex of PiMidiBox
 */
export class PortRecord {
    constructor(name, port, nickname) {
        this._name = name;
        this._port = parseInt(port) || port;
        this._nickname = nickname || this._normalizeName(name) + '_' + port;
    }
    
    get name() { return this._name; }
    get port() { return this._port; }
    get nickname() { return this._nickname; }
    
    _normalizeName(name) {
        // Remove special characters and make snake_case
        return name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
    }
}

export class PortIndex {
    constructor() {
        this._records = {};
    }
    
    get count() { return Object.keys(this._records).length; }
    get records() { return { ...this._records }; }
    
    /** Add ports */
    add(...items) {
        for (const item of items) {
            this.put(item.nickname, item);
        }
    }
    
    /** Set an entry */
    put(nickname, record) {
        if (!record) {
            this.remove(nickname);
            return;
        }
        if (record instanceof PortRecord) {
            this._records[nickname] = record;
        } else if (record.name != null && record.port != null) {
            this._records[nickname] = new PortRecord(record.name, record.port, record.nickname);
        }
    }
    
    /** Remove an entry */
    remove(nickname) {
        delete this._records[nickname];
    }
    
    /** Get an entry by nickname */
    get(nickname) {
        return this._records[nickname];
    }
    
    /** Collect entries by nickname */
    gather(...nicknames) {
        return nicknames
            .filter(n => this._records[n])
            .map(n => this._records[n]);
    }
    
    /** Find by device name */
    find(name) {
        const result = [];
        for (const record of Object.values(this._records)) {
            if (record.name === name || record.nickname === name) {
                result.push(record);
            }
        }
        return result;
    }
    
    /** Clear all entries */
    clear() {
        for (const name in this._records) {
            delete this._records[name];
        }
    }
}

// Global instance
export const portIndex = new PortIndex();
