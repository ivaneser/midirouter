/**
 * MIDI Filters — аналог PiMidiBox filters
 * ChannelFilter, VelocityFilter, MessageTypeFilter
 */

export class Filter {
    process(message) {
        return this._process(message);
    }
    
    _process(message) {
        return message;
    }
}

/**
 * ChannelFilter — фильтрация по каналам
 * - whitelist: только эти каналы проходят
 * - blacklist: эти каналы блокируются
 * - map: маппинг каналов (вход -> выход)
 */
export class ChannelFilter extends Filter {
    constructor({ whitelist = [], blacklist = [], map = {} } = {}) {
        super();
        this._whitelist = whitelist;
        this._blacklist = blacklist;
        this._map = map;
    }
    
    _process(message) {
        const channel = message.channel + 1; // 1-based
        
        // Whitelist имеет приоритет
        if (this._whitelist.length > 0) {
            if (!this._whitelist.includes(channel)) {
                return false;
            }
        } else if (this._blacklist.length > 0) {
            if (this._blacklist.includes(channel)) {
                return false;
            }
        }
        
        // Маппинг каналов
        if (channel.toString() in this._map) {
            message.channel = this._map[channel] - 1; // 0-based
        }
        
        return message;
    }
    
    get settings() {
        return {
            whitelist: this._whitelist,
            blacklist: this._blacklist,
            map: this._map
        };
    }
}

/**
 * VelocityFilter — фильтрация по velocity
 * - min: минимальная velocity
 * - max: максимальная velocity
 * - mode: 'clip' | 'drop' | 'scaled'
 */
export class VelocityFilter extends Filter {
    static MIN = 0;
    static MAX = 127;
    
    constructor({ min = 0, max = 127, mode = 'clip' } = {}) {
        super();
        this.min = min;
        this.max = max;
        this.mode = mode;
    }
    
    set min(value) {
        this._min = Math.max(VelocityFilter.MIN, Math.min(VelocityFilter.MAX, value));
    }
    
    set max(value) {
        this._max = Math.max(this._min, Math.min(VelocityFilter.MAX, value));
    }
    
    set mode(mode) {
        this._mode = mode;
        switch (mode) {
            case 'scaled':
                const scale = (this._max - this._min + 1) / 128;
                this._processor = (velocity) => Math.round(velocity * scale) + this._min;
                break;
            case 'drop':
                this._processor = (velocity) => 
                    (velocity >= this._min && velocity <= this._max) ? velocity : false;
                break;
            case 'clip':
            default:
                this._processor = (velocity) => 
                    Math.max(this._min, Math.min(this._max, velocity));
        }
    }
    
    get mode() { return this._mode || 'clip'; }
    get min() { return this._min || 0; }
    get max() { return this._max || 127; }
    
    _process(message) {
        if (!message.hasOwnProperty('velocity')) {
            return message;
        }
        
        const result = this._processor(message.velocity);
        if (result === false) {
            return false; // Drop
        }
        
        message.velocity = result;
        return message;
    }
    
    get settings() {
        return {
            min: this.min,
            max: this.max,
            mode: this.mode
        };
    }
}

/**
 * MessageTypeFilter — фильтрация по типу сообщения
 */
export class MessageTypeFilter extends Filter {
    constructor({ whitelist = [], blacklist = [] } = {}) {
        super();
        this._whitelist = whitelist;
        this._blacklist = blacklist;
    }
    
    _process(message) {
        if (this._whitelist.length > 0) {
            if (!this._whitelist.includes(message.type)) {
                return false;
            }
        } else if (this._blacklist.length > 0) {
            if (this._blacklist.includes(message.type)) {
                return false;
            }
        }
        return message;
    }
}
