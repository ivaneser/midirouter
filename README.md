# MIDI Router / Looper (midirouter)

Веб-приложение + сервер на Raspberry Pi 4 для маршрутизации и записи MIDI в реальном времени.
Управляется с браузера/смартфона через WebSocket, работает с физическими USB-MIDI устройствами.

## Возможности

### 1. MIDI роутер (all-to-all)
Автоматически обнаруживает входные и выходные MIDI-порты и соединяет их все со всеми в реальном времени. Контроллеры, синтезаторы, loopback — всё работает сразу после подключения. **Hot-plug**: устройства подключаются/отключаются без перезапуска сервера.

### 2. DAW / Clip режим (Ableton Live style)
Превращает роутер в мини-DAW: каждый **MIDI-канал = трек**, записанный паттерн = **клип**. Управление с помощью клавиш контроллера (LaunchKey, nanoPAD2 и любого другого):

| Концепция | Реализация |
|---|---|
| Track (канал) | MIDI-канал 1–16 |
| Clip slot | записанный паттерн на канале |
| Нажатие пада → play/loop, повторное → stop | переключение клипа |
| Record / Overdub / Replace | режимы записи `none` / `overdub` / `replace` |
| Записанные ноты | привязаны к темпу и квантованы в сетку |

**Профили контроллеров:** входные порты, пады, транспортные кнопки и LED-ответы задаются JSON-файлами в `controller_profiles/`. Профиль Launchkey Mini MK3 включён; пример для nanoPAD2 находится в `controller_profiles/examples/` и требует сверки с настройками устройства. Обычные клавиши остаются на MIDI-маршруте к синтезаторам. Для нового контроллера см. [CONTROLLERS.md](CONTROLLERS.md).

### 3. Аудио метроном → наушники Raspberry Pi
Python-метроном `metronome.py` генерирует точные клики через ALSA `aplay —M` прямо в 3.5-мм разъём Raspberry Pi. Синхронизируется с транспортом DAW и MIDI Clock: Play/Stop/Clock от Launchkey автоматически запускают и останавливают метроном.

### 4. MIDI Clock (MTC) — синхронизация внешних устройств
При старте транспорта на все USB-MIDI выходы рассылаются сообщения Start (`0xFA`) и Clock (`0xF8`, 24 PPQN), при остановке — Stop (`0xFC`). Ваши синтезаторы и драм-машины слушают общий темп.

### 5. Светодиоды контроллеров
Профиль задаёт MIDI-сообщения для статусов клипа: играет, запись, начало цикла и выключен. Профиль Launchkey Mini MK3 использует cyan и красный на DAW-порту. Для других устройств можно задать Note, CC или SysEx байты в JSON.

## Быстрый старт

### Одноразовая настройка (новая Pi / новая SD-карта)
```bash
ssh pi@<ip>
sudo bash ~/myprojects/midirouter/bootstrap.sh
# Скрипт сам поставит Node.js, ALSA, добавит в группу audio,
# включит автозапуск и перезагрузит Pi.
```

### Ежедневный запуск (если автозапуск не нужен)
```bash
cd ~/myprojects/midirouter
npm start          # запуск server.js
# открыть http://<ip-pi>:3000
```

### Проверка что работает
```bash
sudo systemctl status midirouter.service   # статус сервера
sudo journalctl -u midirouter.service -n 30 # логи
aconnect -i                                 # список MIDI-портов
```

Требования: Raspberry Pi 4 (или 3B+), USB-MIDI контроллер/синтезатор, ALSA (`/dev/snd`), alsa-utils, Python 3.

**ALSA device для наушников:**
- Метроном автоматически ищет `hw:Headphones` или `headphones` через `aplay -L`.
- Для принудительного выбора: `python3 metronome.py -d hw:0,0`.

## Управление
- **Режим записи:** Play / Replace / Overdub (в веб-UI).
- **BPM + Tap Tempo.**
- **Слоты на трек:** 1 / 2 / 4 / 8.
- **Auto-assign pads:** вкл/выкл автоматическое маппинг клавиш.
- **Пресеты:** сохранение/загрузка состояния DAW (`device_maps/daw_*.json`).

### Как играть (LaunchKey или любой MIDI-клавиатуры)
1. Нажми паду на входе, указанном в JSON-профиле контроллера. Неконфигурированные устройства с `pad` в имени порта могут назначаться автоматически.
2. Нажми паду ещё раз или переключи режим записи:
   - **Play** — клип играет в loop; повторное нажатие останавливает его.
   - **Replace / Overdub** — нажатие пады = запись, release пады = финализация и проиграние. Ноты, которые ты играешь, запишутся в клип.
3. **Transport кнопки** на Launchkey (Play/Stop/Record) управляют транспортом и режимом записи прямо из контроллера.
4. **Кнопки DAW** на Launchkey переключают режим записи между None → Replace → Overdub.
5. **Play на Launchkey** стартует транспорт: раздаётся MIDI Clock, запускается метроном в наушниках, начинает играть активный клип.

### Свет падов (LaunchKey Mini MK3 RGB)
Пады светятся через Note On/Off на **Launchkey DAW Port**. Нижний ряд Session mode отправляет ноты 112–119, верхний — 96–103:
- **Cyan** — клип играет в loop.
- **Красный** — armed для записи (нажал паду в режиме Replace/Overdub).
- **Вспышка на 1-м бите** (downbeat) каждого цикла — ориентируешь ритм.
- **Все пады гасятся** перед входом в DAW режим и при остановке клипов.

LED-команды отправляются на выход, указанный в профиле, не на синтезаторы. Палитра Launchkey задаётся velocity в сообщении Note On.

## Структура проекта
```
midirouter/
├── server.js              # HTTP + WS + управление воркером + DAW API
├── worker-midi.js         # Worker thread: MIDI роутинг + тайминг DAW
├── controller-engine.js   # Загрузка и исполнение JSON-профилей контроллеров
├── controller_profiles/   # Пады, транспорт, LED, выбор MIDI-портов
├── daw.js                 # Движок DAW (клипы, темп, запись, проиграние)
├── metronome.py           # Аудио метроном → Raspberry Pi наушники (ALSA aplay)
├── metronome-controller.js # Node.js контроллер метронома (stdin IPC)
├── midi-clock.js          # MIDI Time Code (MTC): 24 PPQN + Start/Stop
├── metronome.service      # systemd unit для метронома
├── midirouter.service     # systemd unit для самого сервера
├── bootstrap.sh           # One-time setup: Wi-Fi + Node.js + ALSA + autostart
├── frontend/
│   ├── index.html         # Страница с панелью роутера и DAW
│   ├── css/style.css
│   └── js/
│       ├── app.js              # Основная логика UI + WS
│       └── daw-ui.js           # Веб-UI для режима DAW (сетка падов)
├── device_maps/           # Пресеты DAW: daw_<name>.json
└── docs/*.md              # Документация (SPEC, ARCHITECTURE и т.д.)
```

## Автозапуск при включении Pi
Сервис уже настроен через `bootstrap.sh`. Если нужно вручную:
```bash
sudo cp midirouter.service /etc/systemd/system/
sudo cp metronome.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now midirouter.service
sudo systemctl enable --now metronome.service
```

## Документация
- `SPEC.md` — техническое задание
- `ARCHITECTURE.md` — архитектура проекта
- `AUTO-CONNECT.md` — авто-соединение портов
- `DEVICE-MAPPING.md` — маппинг устройств
- `DEBUGGING.md` — диагностика

## Зависимости
- `@julusian/midi` (RtMidi)
- `ws` (WebSocket)

Проверка логики записи и карты падов без MIDI-оборудования: `npm test`.
