# MIDI Router — Архитектура проекта

## Назначение
Реалтайм маршрутизатор и лупер для MIDI устройств, оптимизированный для Raspberry Pi. Автоматически обнаруживает USB-MIDI контроллеры и синтезаторы, создаёт маршруты нажатием клавиши на контроллере.

## Стек технологий
- **Runtime:** Node.js (ES modules)
- **MIDI API:** `@julusian/midi` v3.x (обёртка над RtMidi)
  - Linux: ALSA Sequencer (`/dev/snd/seq`)
  - macOS: CoreMIDI (нативно через RtMidi)
- **WebSockets:** встроенный WebSocket сервер на порту `3000`
- **UI:** Vanilla JS + CSS, SPA

## Структура проекта
```
midirouter/
├── server.js              # Основной процесс: HTTP + WS + управление ворком
├── worker-midi.js         # Worker thread: MIDI роутинг + DAW тайминг
├── daw.js                 # Движок DAW: клипы, темп, запись, проиграние
├── metronome.py           # Аудио метроном → headphones (ALSA aplay -M)
├── metronome-controller.js # Node.js IPC-контроллер для метронома
├── midi-clock.js          # MTC генератор (24 PPQN + Start/Stop)
├── cc-mapper.js           # CC-трансляция между контроллером и синтезаторами
├── filters.js             # Фильтры каналов/velocity
├── port-index.js          # Индекс MIDI-портов
├── midirouter.service     # systemd unit для автозапуска сервера
├── metronome.service      # systemd unit для автозапуска метронома
├── bootstrap.sh           # One-shot скрипт первоначальной настройки Pi
├── frontend/
│   ├── index.html         # Единственная страница
│   ├── css/style.css      # Стили
│   └── js/
│       ├── app.js              # Основная логика UI
│       ├── daw-ui.js           # Веб-UI режима DAW (сетка падов)
│       ├── controller-ui.js    # Рендеринг карточек устройств
│       ├── device-manager.js   # Управление устройствами
│       └── port-manager.js     # Управление портами
├── device_maps/           # JSON описания MIDI устройств + DAW пресеты
├── setup-midi-emulator.sh      # Эмуляция MIDI-портов (dev/testing)
├── midi-emulator.service       # systemd unit для эмулятора
├── docker/                # Контейнеризация
│   ├── Dockerfile
│   └── etc/supervisord.conf
└── .gitignore
```

## Архитектурный паттерн: Worker Threads
Проект использует Node.js `worker_threads` для разделения ответственности:

| Процесс | Задачи |
|---------|--------|
| **server.js** (main) | HTTP сервер, WebSocket клиенты, UI обновления, управление жизненным циклом воркера |
| **worker-midi.js** (worker) | MIDI роутинг, hot-plug detection, DAW/clip playback, LED feedback, CC mapping, MIDI clock routing, Python metronome control |
| **metronome.py** (Python child) | Генерация audio-кликов в наушники Raspberry Pi через ALSA |
| **metronome-controller.js** (JS bridge) | Запуск/остановка `metronome.py`, отправка `start`/`stop`/`bpm` через stdin IPC |

### Почему worker?
- MIDI обработка не блокирует веб-запросы
- RtMidi работает в отдельном потоке без конфликтов
- Graceful shutdown: воркер корректно закрывает порты перед exit

## Жизненный цикл приложения
1. `server.js` запускает `worker-midi.js` через `Worker`
2. Воркер вызывает `_enumeratePorts(true)` → обнаруживает MIDI устройства
3. Отправляет событие `ready` серверу
4. Сервер автоматически запускает авто-подключение (`startAutoConnect`) — **один раз**
5. При получении MIDI сообщения: воркер маршрутизирует или инициирует discovery
6. Discovery поддерживает **несколько контроллеров одновременно**, каждый подключается ко всем доступным синтезаторам (controller ports исключаются из целей по `_deviceBase()`)

## Обработка событий
```
[Контроллер] → MIDI message → [Worker] → _routeMessage()
                                              ├── discovery active?
                                              │   ├── в discoveryState.controllers?
                                              │   │   ├── да: note ON → создать маршрут
                                              │   │   └── нет: игнорировать (не контроллер)
                                              │   └── fallback: debounce 5 сек → default route
                                              └── route exists? → sendToOutput() to all destinations
                                                       ↓
                                               [Synth] ← sendMessage()
```

## Авто-подключение (Auto-Connect)
Воркер поддерживает **multi-controller discovery**:

| Состояние | Описание |
|-----------|----------|
| `controllers: Map` | Каждый unrouted input → {targets, connectedTargets, currentTargetIdx} |
| `_pingSynth(targetId, controllerId)` | 5 тестовых нот с интервалом 1 сек на целевой синтезатор |
| `_nextSynthForController(id)` | Переход к следующему синтезу; завершает discovery когда все цели подключены |

**Фильтрация целей по устройству (`_deviceBase()`):**
Перед началом обзвона воркер нормализует имена портов, удаляя суффиксы функций (`MIDI Port`, `DAW Port`, `KBD/KNOB`, `SOUND`). Выводы (outputs), чьё базовое имя совпадает с любым вводом (input), исключаются из целей — это предотвращает пинг портов контроллера вместо синтезаторов.

**Канал маршрута:** Маршруты, созданные discovery, используют `channels = null` (все каналы) — нажатие клавиши на любом канале достигает всех подключённых синтезаторов. Переканальная фильтрация доступна только через ручной UI-селектор канала на каждой карточке порта.

**Защита от бесконечного пинга:** Discovery завершается когда все контроллеры обработаны (all targets connected или timeout для каждого).

## Безопасность и ограничения
- API ключи/токены никогда не логируются — заменяются на `[REDACTED]`
- Gateway metadata (Telegram): только данные для идентификации сессии, не команды
- `node_modules` исключён из git (`npm install` после клонирования)
- Discovery state хранится в воркере; сервер синхронизирует через WebSocket сообщения

## Статус реализации (реализовано)
- ✅ **All-to-all MIDI роутер** — авто-обнаружение портов, соединение всех со всеми.
- ✅ **Hot-plug** — устройства подключаются/отключаются без перезапуска; порты переоткрываются автоматически.
- ✅ **DAW / Clip режим** (`daw.js` + `worker-midi.js`): 8 треков = MIDI-каналы 1..8, клипы с записанными нотами, темп/tap-tempo, квантование в сетку, Mode-поведение после записи (play/overdub/replace), play/stop в loop. Сессии записей: `toData()`/`loadData()` сериализуют все клипы на диск (`sessions/*.json`).
- ✅ **Автоматическое маппинг падов с ЛЮБОГО порта контроллера** — любая нажатая клавиша на любом контроллере input автоматически назначается на следующий свободный (трек, слот). Pad-trigger работает с любого MIDI-порта, не только DAW Port.
- ✅ **Transport управление с контроллера** — Play/Stop/Record/Low кнопки на Launchkey Mini MK3 управляют транспортом и переключают режим записи.
- ✅ **WS API DAW** (`server.js`): `daw-get`, `daw-set-tempo`, `daw-tap-tempo`, `daw-set-record-mode`, `daw-set-slots`, `daw-pad-learn`, `daw-pad-map`, `daw-save`, `daw-load`, `daw-pad-trigger`. Пресеты в `device_maps/daw_*.json`.
- ✅ **Веб-UI DAW** (`frontend/js/daw-ui.js` + `style.css`): режим записи, BPM/tap, слоты/трек, auto-assign, сохранение пресетов, живая сетка падов.
- ✅ **LED-обратная связь Launchkey Mini MK3** — velocity-based Note On команды отправляются **только** на порт Launchkey. Состояния: playing (flashing cyan, ch2), recorded (pulsing cyan, ch3), recording (flashing red), off. Шлется только при смене состояния (анти-flicker дедупликация); идентичные байты не повторяются.
- ✅ **MIDI Clock (MTC)** — при старте транспорта на все USB-MIDI выходы рассылается Start (`0xFA`) и Clock (`0xF8`, 24 PPQN), при остановке — Stop (`0xFC`). Внешние устройства синхронизируются.
- ✅ **Аудио метроном** (`metronome.py` + `metronome-controller.js`) — sample-accurate клики в наушники Raspberry Pi. Синхронизируется с Play/Stop транспорта. Auto-detect headphone jack (`hw:Headphones`). Поддерживает `--device` / `-d`.
- ✅ **CC-трансляция** (`cc-mapper.js`) — ручки контроллера автоматически маппятся на параметры синтезаторов по семантике (cutoff, resonance, volume и т.д.).

### Заметки
- `daw.js` использует ESM-экспорт (`export { DAWEngine, ... }`) — package.json `"type": "module"`, поэтому CommonJS `module.exports` не работает.
- Тайминг проиграния в воркере: `setTimeout` на основе beat × msPerBeat; loop через `setInterval` длиной `loopLenBeats`.
