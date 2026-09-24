/**
 * CC Mapper — трансляция команд контроллера в команды синтезатора
 * 
 * Архитектура:
 * 1. DeviceProfile — база всех MIDI-команд каждого устройства
 * 2. FunctionMap — маппинг функций (cutoff, resonance...) → CC номера для каждого синта
 * 3. ControllerLayout — раскладка контроллера (какая ручка = какой CC)
 * 4. AutoMapper — автоматический перевод по семантике функции
 */

export class CCMapper {
    constructor() {
        // deviceProfiles: { deviceName: DeviceProfile }
        this.profiles = new Map();
        
        // userMappings: { routeId: { controllerCC: targetCC } }
        this.userMappings = new Map();
        
        // functionAliases — синонимы функций для умного маппинга
        this.functionAliases = {
            'cutoff': ['filter', 'cut', 'lowpass', 'lpf', 'freq'],
            'resonance': ['res', 'rc', 'peak', 'q'],
            'volume': ['level', 'amp', 'gain', 'vol'],
            'pan': ['position', 'stereo'],
            'modulation': ['lfo depth', 'mod', 'tremolo'],
            'lfo_rate': ['lfo speed', 'lfo freq', 'rate'],
            'lfo_depth': ['lfo amount', 'depth'],
            'reverb': ['rev', 'room'],
            'delay': ['dly', 'echo'],
        };
        
        this._initProfiles();
    }
    
    /**
     * Инициализация профилей устройств — полная база команд
     */
    _initProfiles() {
        // ===== Craft Synth 2.0 (Arturia) =====
        this.profiles.set('craft synth', new DeviceProfile({
            name: 'Craft Synth 2.0',
            vendor: 'Arturia',
            functions: {
                'cutoff':     { cc: 1,  min: 0, max: 127 },   // CC 1 = Filter Cutoff
                'resonance':  { cc: 2,  min: 0, max: 127 },   // CC 2 = Resonance  
                'reverb':     { cc: 3,  min: 0, max: 127 },   // CC 3 = Reverb Level
                'portamento': { cc: 4,  min: 0, max: 127 },   // CC 4 = Portamento Time
                'vibrato_rate': { cc: 5, min: 0, max: 127 },  // CC 5 = Vibrato Rate
                'modulation': { cc: 6,  min: 0, max: 127 },   // CC 6 = Modulation Depth
                'volume':     { cc: 7,  min: 0, max: 127 },   // CC 7 = Volume
                'pan':        { cc: 8,  min: 0, max: 127 },   // CC 8 = Pan
                'attack':     { cc: 9,  min: 0, max: 127 },   // CC 9 = Attack
                'release':    { cc: 10, min: 0, max: 127 },   // CC 10 = Release
                'effect1':    { cc: 11, min: 0, max: 127 },   // CC 11 = Effect 1 Depth
                'effect2':    { cc: 12, min: 0, max: 127 },   // CC 12 = Effect 2 Depth
            }
        }));
        
        // ===== Novation Launchkey Mini MK3 =====
        this.profiles.set('launchkey', new DeviceProfile({
            name: 'Launchkey Mini MK3',
            vendor: 'Novation',
            layout: {
                'fader1':  { cc: 7,  label: 'Fader 1' },
                'fader2':  { cc: 8,  label: 'Fader 2' },
                'fader3':  { cc: 9,  label: 'Fader 3' },
                'fader4':  { cc: 10, label: 'Fader 4' },
                'knob1':   { cc: 16, label: 'Knob 1' },
                'knob2':   { cc: 17, label: 'Knob 2' },
                'knob3':   { cc: 18, label: 'Knob 3' },
                'knob4':   { cc: 19, label: 'Knob 4' },
                'assign1': { cc: 74, label: 'Assignable 1' },
                'assign2': { cc: 75, label: 'Assignable 2' },
                'assign3': { cc: 76, label: 'Assignable 3' },
                'assign4': { cc: 77, label: 'Assignable 4' },
                'pad1':    { note: 36, label: 'Pad 1' },
                'pad2':    { note: 37, label: 'Pad 2' },
                'pad3':    { note: 38, label: 'Pad 3' },
                'pad4':    { note: 39, label: 'Pad 4' },
                'pad5':    { note: 40, label: 'Pad 5' },
                'pad6':    { note: 41, label: 'Pad 6' },
                'pad7':    { note: 42, label: 'Pad 7' },
                'pad8':    { note: 43, label: 'Pad 8' },
            }
        }));
        
        console.log('[CC-MAPPER] Profiles initialized:', this.profiles.size, 'devices');
    }
    
    /**
     * Добавить пользовательский маппинг для маршрута
     */
    addUserMapping(routeId, controllerCC, targetCC) {
        if (!this.userMappings.has(routeId)) {
            this.userMappings.set(routeId, {});
        }
        this.userMappings.get(routeId)[controllerCC] = targetCC;
        console.log(`[CC-MAPPER] User mapping: route=${routeId} CC${controllerCC} → CC${targetCC}`);
    }
    
    /**
     * Удалить маппинг маршрута
     */
    removeUserMapping(routeId) {
        this.userMappings.delete(routeId);
    }
    
    /**
     * Получить все маппинги для маршрута
     */
    getUserMappings(routeId) {
        return this.userMappings.get(routeId) || {};
    }
    
    /**
     * Найти CC функции по имени устройства и функции
     */
    getCCForFunction(deviceName, functionName) {
        const profile = this._findProfile(deviceName);
        if (!profile) return null;
        
        // Нормализуем имя функции
        const normalized = functionName.toLowerCase().replace(/[\s_-]/g, '');
        
        // Прямой поиск
        for (const [key, func] of Object.entries(profile.functions)) {
            if (key === normalized) return func.cc;
            
            // Поиск по алиасам
            for (const alias of this.functionAliases[normalized] || []) {
                if (alias === key) return func.cc;
            }
        }
        
        // Поиск по алиасам функции
        for (const [funcKey, aliases] of Object.entries(this.functionAliases)) {
            if (aliases.includes(normalized)) {
                const func = profile.functions[funcKey];
                if (func) return func.cc;
            }
        }
        
        return null;
    }
    
    /**
     * Автоматический маппинг по семантике функции
     *   Launchkey Knob1(CC16) → Craft Synth Cutoff(CC1) если оба маппятся на 'filter/cutoff'
     */
    autoMapByFunction(controllerDevice, targetDevice, controllerCC) {
        const ctrlProfile = this._findProfile(controllerDevice);
        const tgtProfile = this._findProfile(targetDevice);
        
        if (!ctrlProfile || !tgtProfile) return null;
        
        // Безопасная работа с layout — если его нет, используем пустой объект
        const layout = ctrlProfile.layout || {};
        
        // Находим какую функцию контролирует CC на контроллере
        let ctrlFunction = null;
        for (const [key, layoutEntry] of Object.entries(layout)) {
            if (!layoutEntry || !layoutEntry.label) continue;
            // Layout keys are symbolic names ('knob1', 'fader1'); match by the real CC number.
            const entryCC = typeof layoutEntry.cc === 'number' ? layoutEntry.cc : parseInt(layoutEntry.cc, 10);
            if (entryCC === controllerCC) {
                // Определяем функцию по названию лейбла (убираем пробелы, чтобы "knob 1" совпадало с 'knob1').
                const label = layoutEntry.label.toLowerCase().replace(/\s+/g, '');
                if (label.includes('fader1') || label.includes('knob1')) ctrlFunction = 'volume';
                else if (label.includes('fader2') || label.includes('knob2')) ctrlFunction = 'pan';
                else if (label.includes('fader3') || label.includes('knob3')) ctrlFunction = 'cutoff';
                else if (label.includes('fader4') || label.includes('knob4')) ctrlFunction = 'resonance';
                else if (label.includes('assign1')) ctrlFunction = 'modulation';
                else if (label.includes('assign2')) ctrlFunction = 'lfo_rate';
                else if (label.includes('assign3')) ctrlFunction = 'lfo_depth';
                else if (label.includes('assign4')) ctrlFunction = 'reverb';
                break;
            }
        }
        
        if (!ctrlFunction) return null;
        
        // Ищем тот же CC для функции на целевом устройстве
        const targetFunc = tgtProfile.functions[ctrlFunction];
        if (targetFunc) {
            console.log(`[CC-MAPPER] Auto-map: ${controllerDevice}.${ctrlFunction}(CC${controllerCC}) → ${targetDevice}.CC${targetFunc.cc}`);
            return targetFunc.cc;
        }
        
        // Если функция не найдена, ищем ближайшую по типу
        const typeMap = {
            'cutoff': ['filter', 'freq'],
            'resonance': ['rc', 'q'],
            'volume': ['level', 'amp'],
            'pan': ['position'],
            'modulation': ['lfo depth'],
            'reverb': ['rev'],
        };
        
        const alternatives = typeMap[ctrlFunction] || [];
        for (const alt of alternatives) {
            for (const [key, func] of Object.entries(tgtProfile.functions)) {
                if (key.includes(alt)) {
                    console.log(`[CC-MAPPER] Auto-map fallback: ${controllerDevice}.${ctrlFunction}(CC${controllerCC}) → ${targetDevice}.CC${func.cc}`);
                    return func.cc;
                }
            }
        }
        
        return null;
    }
    
    /**
     * Трансляция CC команды
     */
    transformCC(message, inputDeviceName, outputDeviceName, routeId) {
        if (!message || !message.bytes || !(message.bytes instanceof Uint8Array)) {
            console.warn(`[CC-MAPPER] Invalid message passed to transformCC`);
            return message;
        }
        
        const cc = message.bytes[1];
        if (cc === undefined || cc < 0 || cc > 127) {
            // Не является валидным CC номером — возвращаем без изменений
            return message;
        }
        
        // Проверяем пользовательские маппинги маршрута
        if (this.userMappings.has(routeId)) {
            const mappings = this.userMappings.get(routeId);
            if (cc in mappings) {
                const targetCC = mappings[cc];
                message.bytes[1] = targetCC;
                console.log(`[CC-MAPPER] Route ${routeId}: CC${cc} → CC${targetCC}`);
                return message;
            }
        }
        
        // Пробуем авто-маппинг по функции
        const targetCC = this.autoMapByFunction(inputDeviceName, outputDeviceName, cc);
        if (targetCC !== null) {
            message.bytes[1] = targetCC;
            return message;
        }
        
        // Без изменений
        return message;
    }
    
    /**
     * Найти профиль устройства по имени
     */
    _findProfile(deviceName) {
        const lower = deviceName.toLowerCase();
        for (const [key, profile] of this.profiles) {
            if (lower.includes(key)) return profile;
        }
        
        // Поиск по vendor
        for (const [k, profile] of this.profiles) {
            if (profile.vendor && lower.includes(profile.vendor.toLowerCase())) {
                return profile;
            }
        }
        
        return null;
    }
    
    /**
     * Получить список всех устройств и их функций
     */
    getDeviceFunctions(deviceName) {
        const profile = this._findProfile(deviceName);
        if (!profile) return {};
        return profile.functions;
    }
    
    /**
     * Начать Learn mode для маршрута
     */
    beginLearn(routeId) {
        this._learningRoute = routeId;
        console.log(`[CC-MAPPER] Learning mode started for route ${routeId}`);
    }
    
    recordLearnedMapping(controllerCC, targetFunctionOrCC) {
        if (this._learningRoute) {
            // Если target — функция, ищем CC для неё
            let targetCC = targetFunctionOrCC;
            if (typeof targetFunctionOrCC === 'string') {
                const profile = this._findProfile('craft synth'); // default target
                if (profile) {
                    targetCC = this.getCCForFunction('craft synth', targetFunctionOrCC);
                }
            }
            
            if (targetCC !== null && targetCC !== undefined) {
                this.addUserMapping(this._learningRoute, controllerCC, targetCC);
            }
            this._learningRoute = null;
        }
    }
    
    /**
     * Получить список профилей
     */
    getProfileNames() {
        return [...this.profiles.keys()];
    }
}

/**
 * DeviceProfile — профиль устройства с его MIDI-командами
 */
export class DeviceProfile {
    constructor({ name, vendor, functions = {}, layout = {} }) {
        this.name = name;
        this.vendor = vendor || '';
        this.functions = functions;  // { functionName: { cc, min, max } }
        this.layout = layout;       // { key: { cc, label } } — physical controls on the controller
    }
    
    /**
     * Добавить функцию
     */
    addFunction(name, cc, min = 0, max = 127) {
        this.functions[name] = { cc, min, max };
    }
    
    /**
     * Получить CC для функции
     */
    getCC(functionName) {
        const func = this.functions[functionName];
        return func ? func.cc : null;
    }
}
