/**
 * PortIndex — реестр MIDI портов по никнеймам
 * Аналог PortIndex из PiMidiBox
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
        // Убираем спецсимволы и делаем snake_case
        return name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
    }
}

export class PortIndex {
    constructor() {
        this._records = {};
    }
    
    get count() { return Object.keys(this._records).length; }
    get records() { return { ...this._records }; }
    
    /** Добавить порты */
    add(...items) {
        for (const item of items) {
            this.put(item.nickname, item);
        }
    }
    
    /** Установить запись */
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
    
    /** Удалить запись */
    remove(nickname) {
        delete this._records[nickname];
    }
    
    /** Получить запись по никнейму */
    get(nickname) {
        return this._records[nickname];
    }
    
    /** Собрать записи по никнеймам */
    gather(...nicknames) {
        return nicknames
            .filter(n => this._records[n])
            .map(n => this._records[n]);
    }
    
    /** Найти по имени устройства */
    find(name) {
        const result = [];
        for (const record of Object.values(this._records)) {
            if (record.name === name || record.nickname === name) {
                result.push(record);
            }
        }
        return result;
    }
    
    /** Очистить все записи */
    clear() {
        for (const name in this._records) {
            delete this._records[name];
        }
    }
}

// Глобальный экземпляр
export const portIndex = new PortIndex();
