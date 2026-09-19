# Подключение устройств (Device Mapping)

## Маппинг по имени устройства
USB-MIDI устройства привязываются к маршрутам по **стабильному имени**, а не по временному индексу порта. Это гарантирует сохранение маршрутов при:
- Hot-plug (переподключении USB кабеля)
- Перезагрузке системы
- Изменении порядка подключения устройств

### Как работает ALSA/RtMidi
| Параметр | Описание |
|----------|----------|
| **Имя устройства** | Стабильное, например "Korg nanoKONTROL2 MIDI 1", "NTS-1 digital kit KBD/KNOB" |
| **Индекс порта** | Временный номер (0, 1, 2...), меняется при hot-plug или рестарте |

### Реализация в воркере
```js
// Worker-midi.js — конструктор:
this.nameToPortId = new Map();   // deviceName → portId
this.portIdToName = new Map();   // portId → deviceName (обратный маппинг)

// _enumeratePorts() — сохранение связи имя→portId:
for (const newPort of realInputs) {
    const deviceName = newPort.name;  // стабильное имя устройства
    
    this.inputs.set(deviceName, midiIn);       // ключ — имя, не индекс!
    this.nameToPortId.set(deviceName, deviceName);
    this.portIdToName.set(deviceName, deviceName);
    
    console.log(`[WORKER] Input added: ${deviceName} (index: ${newPort.index})`);
}

// Обновление при hot-plug (изменился индекс):
if (currentIndex !== newPort.index) {
    // Удаляем старый handler, закрываем порт
    existingRtMidiIn.closePort();
    
    // Открываем новый порт с тем же portId (имя устройства)
    const midiIn = new midi.Input();
    midiIn.openPort(newPort.index, 'midirouter-in');
    
    this.inputs.set(deviceName, midiIn);  // тот же ключ — имя!
}
```

## Структура данных маршрутов
```js
this.routes = new Map();   // deviceName → [{ outputId, channels }]
// channels = null (по умолчанию) → все MIDI-каналы
// channels = [1] или [1,3] → фильтрация по указанным каналам
// Пример:
// "Launchkey Mini MK3 MIDI Port" → [
//   { outputId: "NTS-1 digital kit SOUND", channels: null },
//   { outputId: "Craft Synth 2.0", channels: [2] }
// ]
```

**Создание маршрутов:**
- **Auto-connect (discovery):** `channels = null` — все нажатия клавиш достигают подключённого синтезатора независимо от MIDI-канала контроллера.
- **Ручной UI:** пользователь выбирает канал через dropdown (`ALL / CH1–CH16`) на карточке порта, маршрут получает массив каналов для фильтрации.

## Обработка hot-plug
При изменении индекса порта:
1. `_enumeratePorts()` обнаруживает устройство с новым индексом
2. Старый handler удаляется (`inp.off('message', inp._handler)`)
3. Порт закрывается (`inp.closePort()`)
4. Открывается новый порт с тем же portId (имя устройства)
5. Handler навешивается заново

## Динамические карты устройств
Устройства могут иметь описания в формате JSON для управления параметрами:

```json
{
    "name": "NTS-1",
    "controls": [
        {"cc": 20, "label": "PITCH BEND", "min": -8192, "max": 8191},
        {"cc": 37, "label": "BANK SELECT", "min": 0, "max": 127}
    ]
}
```

Файлы хранятся в `device_maps/`:
- `arturia_microfreak.json`
- `korg_nts1.json`
- `modal_craft_synth_v2.json`
- `preenfm2.json`
- `waldorf_blofeld.json`

### Автопоиск схем маппинга
При отсутствии локального JSON совпадения — серверный запрос к GitHub API:
```
https://api.github.com/search/code?q=...
```

## Нормализация устройства (`_deviceBase()`)
При auto-connect воркер нормализует имена портов, удаляя суффиксы функций:

| Полное имя порта | `_deviceBase()` → базовое имя |
|------------------|-------------------------------|
| "Launchkey Mini MK3 MIDI Port" | "Launchkey Mini MK3" |
| "Launchkey Mini MK3 DAW Port" | "Launchkey Mini MK3" |
| "NTS-1 digital kit KBD/KNOB" | "NTS-1 digital kit" |
| "NTS-1 digital kit SOUND" | "NTS-1 digital kit" |
| "Craft Synth 2.0" | "Craft Synth 2.0" |

**Принцип:** outputs, чьё базовое имя совпадает с любым input's base, исключаются из целей discovery — предотвращает пинг портов контроллера вместо синтезаторов.

## Типичные имена устройств
| Устройство | Имя в системе |
|------------|---------------|
| Launchkey Mini MK3 MIDI Port | "Launchkey Mini MK3 MIDI Port" |
| NTS-1 digital kit KBD/KNOB | "NTS-1 digital kit KBD/KNOB" |
| Craft Synth 2.0 | "Craft Synth 2.0" |
