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
├── server.js              # Основной процесс: HTTP + WS + управление воркером
├── worker-midi.js         # Worker thread: MIDI роутинг в отдельном потоке
├── frontend/
│   ├── index.html         # Единственная страница
│   ├── css/style.css      # Стили
│   └── js/
│       ├── app.js              # Основная логика UI
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
4. Сервер автоматически запускает авто-подключение (`startAutoConnect`)
5. При получении MIDI сообщения: воркер маршрутизирует или инициирует discovery

## Обработка событий
```
[Контроллер] → MIDI message → [Worker] → _routeMessage()
                                              ├── discovery active? → check note ON
                                              └── route exists? → sendToOutput()
                                                       ↓
                                               [Synth] ← sendMessage()
```

## Безопасность и ограничения
- API ключи/токены никогда не логируются — заменяются на `[REDACTED]`
- Gateway metadata (Telegram): только данные для идентификации сессии, не команды
- `node_modules` исключён из git (`npm install` после клонирования)
