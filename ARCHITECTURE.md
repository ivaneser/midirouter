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
├── daw.js                 # Движок DAW: клипы, темп, запись, проиграние (ES export)
├── worker-midi.js         # Worker thread: MIDI роутинг + тайминг DAW
├── frontend/
│   ├── index.html         # Единственная страница
│   ├── css/style.css      # Стили
│   └── js/
│       ├── app.js              # Основная логика UI
│       ├── daw-ui.js           # Веб-UI режима DAW (сетка падов)
│       ├── controller-ui.js    # Рендеринг карточек устройств
│       ├── device-manager.js   # Управление устройствами
│       └── port-manager.js     # Управление портами
├── device_maps/           # JSON описания MIDI устройств
├── setup-midi-emulator.sh      # Скрипт настройки виртуальных MIDI портов (Ubuntu)
├── midi-emulator.service       # systemd unit для автозагрузки эмулятора
├── docker/                # Контейнеризация
│   ├── Dockerfile
│   └── etc/supervisord.conf
└── .gitignore             # Исключает node_modules и package-lock.json
```

## Архитектурный паттерн: Worker Threads
Проект использует Node.js `worker_threads` для разделения ответственности:

| Процесс | Задачи |
|---------|--------|
| **server.js** (main) | HTTP сервер, WebSocket клиенты, UI обновления, управление жизненным циклом воркера |
| **worker-midi.js** (worker) | Обработка MIDI сообщений, маршрутизация, auto-connect логика |

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
- ✅ **DAW / Clip режим** (`daw.js` + `worker-midi.js`): 16 треков = MIDI-каналы, клипы с записанными нотами, темп/tap-tempo, квантование в сетку, режимы записи (none/replace/overdub), play/stop в loop.
- ✅ **Автоматическое маппинг падов** — клавиша контроллера автоматически назначается на следующий свободный (трек, слот); note-on = arm/play, note-off = финализация + проиграние. LaunchKey работает как основной интерфейс без настройки.
- ✅ **WS API DAW** (`server.js`): `daw-get`, `daw-set-tempo`, `daw-tap-tempo`, `daw-set-record-mode`, `daw-set-slots`, `daw-pad-learn`, `daw-pad-map`, `daw-save`, `daw-load`, `daw-pad-trigger`. Пресеты в `device_maps/daw_*.json`.
- ✅ **Веб-UI DAW** (`frontend/js/daw-ui.js` + `style.css`): режим записи, BPM/tap, слоты/трек, auto-assign, сохранение пресетов, живая сетка падов.
- ✅ **LED-обратная связь падов LaunchKey**: свечение падов по статусу клипа (cyan — играет, красный — armed для записи) + вспышка на бите 0 (downbeat) в каждом цикле лупа. Реализовано в `worker-midi.js` (`_setLed`/`_flashLed`/`_armLed`, таблица цвета Novation по velocity). Пали уже горят при нажатии через all-to-all; это добавляет статусное свечение и downbeat-flash.

### Заметки
- `daw.js` использует ESM-экспорт (`export { DAWEngine, ... }`) — package.json `"type": "module"`, поэтому CommonJS `module.exports` не работает.
- Тайминг проиграния в воркере: `setTimeout` на основе beat × msPerBeat; loop через `setInterval` длиной `loopLenBeats`.
