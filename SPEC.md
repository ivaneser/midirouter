# ТЗ: MIDI Router / Looper для Raspberry Pi 4

## 1. Обзор проекта

Веб-приложение + сервер на базе Raspberry Pi 4, который:
- Роутит MIDI-сообщения между физическими MIDI-портами в реальном времени
- Записывает и воспроизводит (лупит) MIDI-клипы с точным таймингом
- Управляется через веб-интерфейс со смартфона/планшета/браузера

**Стек:** Node.js + `@julusian/midi` (RtMidi) на сервере, vanilla JS SPA на клиенте, WebSocket для связи.

---

## 2. Аппаратные требования

- Raspberry Pi 4 (2GB+ RAM)
- MIDI-интерфейс (USB-MIDI): Focusrite Scarlett 6e, Audient iD4, Behringer U-Phoria UM2 и т.п.
- Wi-Fi/Ethernet для подключения клиентов управления

---

## 3. Архитектура

```
┌──────────────────────────────────────────────┐
│              Raspberry Pi 4                  │
│                                              │
│   ┌─────────────┐     ┌──────────────────┐   │
│   │  @julusian/  │◄───►│   Node.js Server  │   │
│   │    midi      │     │   (ALSA backend)  │   │
│   └──────┬───────┘     └────────┬─────────┘   │
│          │                      │              │
│   USB-MIDI порты                │              │
│   (ALSA sequencer)             │              │
│                                  ▼              │
│                    ┌──────────────────────┐    │
│                    │  WebSocket Server    │    │
│                    │  + MIDI Engine       │    │
│                    └──────────┬───────────┘    │
└───────────────────────────────┼───────────────┘
                                │ WebSocket (WS)
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        📱 Телефон         🖥 Браузер         📱 Планшет
     (Web UI SPA)       (Web UI SPA)    (Web UI SPA)
```

**Принцип работы:**
- **Node.js сервер** на Pi — единственный компонент с доступом к MIDI через RtMidi/ALSA. Обрабатывает маршрутизацию и лупинг.
- **Клиентское веб-приложение** подключается по WebSocket для управления. Не имеет прямого доступа к MIDI.

---

## 4. Функциональные требования

### 4.1 Роутинг (Routing)

| № | Требование | Описание |
|---|-----------|----------|
| R1 | Enumerate портов | При старте сервер обнаруживает все доступные MIDI In/Out через ALSA и отдаёт список клиентам |
| R2 | Drag & Drop маршруты | Клиент перетаскивает порт Input на Output — создаётся маршрут |
| R3 | 1:N routing | Один input → несколько outputs (сплит) |
| R4 | N:1 routing | Несколько inputs → один output с приоритизацией по MIDI-каналу |
| R5 | Auto-discovery learning mode | **Основной режим**: когда событие приходит на порт без маршрута, роутер переходит в режим ожидания первого CC-сигнала от синтезатора и автоматически связывает порты |
| R6 | Фильтрация каналов | Маршрут может фильтровать по MIDI-каналу (1–16) или маршрутизировать все каналы |
| R7 | Включение/отключение маршрута | Toggle On/Off для каждого маршрута |
| R8 | Визуализация потоков | Клиент показывает активные маршруты с индикацией трафика |

### 4.2 Лупер (Looper)

| № | Требование | Описание |
|---|-----------|----------|
| L1 | Запись клипа | Record → буферизация входящих MIDI-событий с таймстампами |
| L2 | Воспроизведение клипа | Play → воспроизведение в выбранный output-порт |
| L3 | Циклический луп | Loop mode: автоповтор после окончания |
| L4 | Несколько клипов | Минимум 8 слотов |
| L5 | Overdub / Punch-in | Запись нового слоя поверх во время воспроизведения |
| L6 | Stop/Reset | Стоп с мгновенным сбросом или graceful finish |
| L7 | Quantization | Авто-выравнивание по сетке (1/4, 1/8, 1/16) |

**Статус реализации:** DAW-режим реализован в `daw.js` + `worker-midi.js`. Клипы = записанные паттерны на MIDI-канале; проиграние в loop; Overdub (наложение слоя), Replace (перезапись) и Record поддерживаются (`daw-set-record-mode`); квантование в сетку по темпу; до 8 слотов на трек (`daw-set-slots`). Активация клипа нажатием пады LaunchKey — автоматическое маппинг.

### 4.3 Виртуальные контроллеры на веб-интерфейсе

Клиентский UI отображает **виртуальные элементы управления** для каждого подключённого синтезатора согласно его MIDI-карте (CC/NRPN). Это позволяет управлять синтезатором через любой браузер/телефон, даже если физические ручки недоступны.

#### 4.3.1 Korg NTS-1 — CC Map

| № | Параметр | CC MSB | Описание | Тип элемента UI |
|---|---------|--------|----------|----------------|
| V1 | Volume EG Type | 14 | ADSR/AHR/AR/AR loop/Open | Dropdown/select |
| V2 | Attack | 16 | Time | Слайдер (0-127) |
| V3 | Release | 19 | Time | Слайдер |
| V4 | Tremolo Depth | 20 | Глубина тремоло | Слайдер |
| V5 | Tremolo Rate | 21 | Частота тремоло | Слайдер |
| V6 | Osc LFO Rate | 24 | LFO rate | Слайдер |
| V7 | Osc LFO Depth | 26 | LFO depth | Слайдер |
| V8 | Osc Type | 53 | Saw/Tri/Square/VPM/Waves | Dropdown |
| V9 | Wave Shaping | 54 | Формирование волны | Слайдер |
| V10 | Alt | 55 | Альтернативная волна | Слайдер |
| V11 | Mod Time | 28 | Модуляция время | Слайдер |
| V12 | Mod Depth | 29 | Модуляция глубина | Слайдер |
| V13 | Delay Time | 30 | Delay время | Слайдер |
| V14 | Delay Depth | 31 | Delay глубина | Слайдер |
| V15 | Mix | 33 | Dry/Wet mix | Слайдер |
| V16 | Reverb Time | 34 | Reverb time | Слайдер |
| V17 | Reverb Depth | 35 | Reverb depth | Слайдер |
| V18 | FX Dry/Wet | 36 | Dry/Wet mix FX | Слайдер |
| V19 | Filter Type | 42 | LP2/LP4/BP2/BP4/HP2/HP4/Off | Dropdown |
| V20 | Cutoff | 43 | Частота среза фильтра | **Основной слайдер** |
| V21 | Resonance | 44 | Резонанс фильтра | Слайдер |
| V22 | Sweep Depth | 45 | Глубина sweep | Слайдер |
| V23 | Sweep Cutoff | 46 | Cutoff sweep | Слайдер |
| V24 | FX Mod Type | 88 | Chorus/Ensemble/Phase/Flanger | Dropdown |
| V25 | FX Delay Type | 89 | Stereo/MNono/PingPong/Tape | Dropdown |
| V26 | FX Reverb Type | 90 | Hall/Plate/Space/Riser/Submarine | Dropdown |
| V27 | Arp Pattern Length | 117 | Up/Down/Up-Down/Down-Up/Conv/etc. | Dropdown |
| V28 | Arp Intervals | 118 | Oct/Maj/Sus/Aug/Min/Dim | Dropdown |
| V29 | Arp Length | 119 | Длина арпеджиатора | Слайдер |

#### 4.3.2 Modal/Craft Synth 2.0 — CC Map (основные ручки)

| № | Параметр | CC MSB | Описание | Тип элемента UI |
|---|---------|--------|----------|----------------|
| C1 | Modulation | 1 | Mod wheel / LFO modulation | Слайдер/ручка |
| C2 | Portamento Time | 5 | Время портаменто | Слайдер |
| C3 | Volume | 7 | Общая громкость | Слайдер |
| C4 | Panpot | 11 | Панорама | Слайдер (-64 до +63) |
| C5 | Expression | 11 | Expression pedal | Слайдер |
| C6 | Hold 1 (Sustain) | 64 | Педаль сустейна | Toggle/кнопка |
| C7 | Portamento | 66 | Вкл/выкл портаменто | Toggle/кнопка |
| C8 | Resonance | 72 | Резонанс фильтра | Слайдер |
| C9 | Release Time | 73 | Время затухания | Слайдер |
| C10 | Attack Time | 74 | Время атаки | Слайдер |
| C11 | Cutoff | 75 | Частота среза фильтра | **Основной слайдер** |
| C12 | Decay Time | 76 | Время спада | Слайдер |
| C13 | Vibrato Rate | 77 | Частота вибрато | Слайдер |
| C14 | Vibrato Depth | 78 | Глубина вибрато | Слайдер |
| C15 | Vibrato Delay | 80 | Задержка вибрато | Слайдер |
| C16 | FILTER Knob | 81 | Ручка фильтра (user assignable) | **Основной слайдер** |
| C17 | MOD Knob | 82 | Rучка модуляции | **Слайдер** |
| C18 | FX Knob | 83 | Ручка эффектов | Слайдер |
| C19 | SOUND Knob | 84 | Rучка звука | Слайдер |

#### 4.3.4 Arturia MicroFreak — CC Map (основные параметры)

| № | Параметр | CC MSB | Описание | Тип элемента UI |
|--|---------|--------|----------|----------------|
| M1 | Spice | 2 | Speech/Vocoder/Resonant FM/Analog/Vacuum/Oscillator Type | Dropdown |
| M2 | Glide | 5 | Время глиссады (плавный переход между нотами) | Слайдер |
| M3 | Osc Type | 9 | Тип осциллятора (Speech/Sampler/Resonant FM/Analog/Vacuum/Wave Table) | Dropdown |
| M4 | Osc Wave | 10 | Форма волны | Слайдер |
| M5 | Osc Timbre | 12 | Тимбр | Слайдер |
| M6 | Osc Shape | 13 | Формы осциллятора | Слайдер |
| M7 | Filter Cutoff | 23 | Частота среза фильтра | **Основной слайдер** |
| M8 | Cycl Env Amt | 24 | Amount Cycling Envelope | Слайдер |
| M9 | Filter Amt | 26 | Amount envelope to filter | Слайдер |
| M10 | Cycl Env Hld | 28 | Hold Cycling Envelope | Слайдер |
| M11 | Env Sustain | 29 | Уровень sustain стандартного огибающего | Слайдер |
| M12 | Keyboard Hold | 64 | Кнопка Key Hold (toggle) | Toggle/кнопка |
| M13 | Filter Resonance | 83 | Резонанс фильтра | Слайдер |
| M14 | Arp Rate Free | 91 | Частота арпеджиатора (free mode) | Слайдер |
| M15 | Arp Rate Sync | 92 | Частота арпеджиатора (sync mode) | Слайдер |
| M16 | LFO Rate | 93/94 | Частота LFO | Слайдер |
| M17 | Cycl Env Rise | 102 | Восхождение Cycling Envelope | Слайдер |
| M18 | Cycl Env Fall | 103 | Спад Cycling Envelope | Слайдер |
| M19 | Env Attack | 105 | Время атаки огибающего | Слайдер |
| M20 | Env Decay | 106 | Время спада огибающего | Слайдер |

#### 4.3.5 Waldorf Blofeld — CC Map (основные параметры)

Waldorf Blofeld поддерживает MIDI Learn для большинства параметров. Стандартный маппинг:

| № | Параметр | CC MSB | Описание | Тип элемента UI |
|--|---------|--------|----------|----------------|
| W1 | Modulation Wheel | 1 | Колесо модуляции (LFO/Filter) | Слайдер/ручка |
| W2 | Breath Control | 2 | Дыхание (можно привязать к wind controller) | Слайдер |
| W3 | Foot Control | 4 | Педаль управления | Toggle/кнопка |
| W4 | Glide Rate | 5 | Скорость глиссады | Слайдер |
| W5 | Detune Common | 29 | Расстройка осцилляторов | Слайдер |
| W6 | FM Amount | 30 |Amount частотной модуляции (FM) | Слайдер |
| W7 | Shape Modulation | 31/39/46 | Формы для Osc 1/2/3 | Слайдеры |
| W8 | PW (Pulse Width) | 33/40/47 | Ширина импульса | Слайдер |
| W9 | PWM Modulation | 34/41/48 | Модуляция ширины импульса | Слайдер |
| W10 | Sync Amount | 49 |Amount синхронизации осцилляторов | Слайдер |
| W11 | Pitchmod Depth | 50 | Глубина модуляции питча | Слайдер |
| W12 | Glide Mode | 51 | Режим глиссады (legato/free) | Toggle/кнопка |
| W13 | Osc Level | 52/56/58/60 | Уровни Osc 1/Osc 2/Osc 3/Noise | Слайдеры |
| W14 | Noise Colour | 62 | Цвет шума (белый/розовый) | Toggle/кнопка |
| W15 | Octave Select | 63/35/42 | Выбор октавы Osc 1/2/3 | Dropdown |
| W16 | Semitone | 64/36/43 | Полутон для Osc 1/2/3 | Слайдеры |
| W17 | Filter Type | 68/79 | Тип фильтра Filt1/Filt2 (LP/BP/HP) | Dropdown |
| W18 | Filter Cutoff | 69/80 | Частота среза Filt1/Filt2 | **Основные слайдеры** |
| W19 | Filter Resonance | 70/81 | Резонанс Filt1/Filt2 | Слайдеры |
| W20 | Filter Drive | 71/82 | Драйв фильтра | Слайдер |
| W21 | Keytrack | 72/83 | Трекинг клавиш по фильтру | Toggle/кнопка |
| W22 | Env Amount to Filt | 73/84 |Amount огибающей на фильтр | Слайдеры |
| W23 | Env Velocity to Filt | 74/85 |Velocity на фильтр | Слайдер |
| W24 | Cutoff Mod | 75/86 | Модуляция cutoff | Слайдер |
| W25 | FM Amount (Filt) | 76/87 | FM для Filt1/Filt2 | Слайдеры |
| W26 | Pan Filter | 77/88 | Панорама фильтра | Слайдер |
| W27 | Pan Modulation | 78/89 | Пан модуляции | Слайдер |
| W28 | LFO Shape | 15/19/23 | Форма LFO 1/2/3 | Dropdown |
| W29 | LFO Speed | 16/20/24 | Частота LFO 1/2/3 | Слайдеры |
| W30 | LFO Delay | 18/22/26 | Задержка LFO 1/2/3 | Слайдеры |
| W31 | Arp Range | 12 | Диапазон арпеджиатора | Dropdown |
| W32 | Arp Active | 14 | Вкл/выкл арпеджиатор | Toggle/кнопка |
| W33 | Amp Volume | 90 | Громкость | **Основной слайдер** |
| W34 | FX1 Mix | 93 | Микс эффекта 1 | Слайдер |
| W35 | FX2 Mix | 94 | Микс эффекта 2 | Слайдер |
| W36 | Env Attack (Filt) | 95/101/107/113 | Атака огибающей Filt 1-4 | Слайдеры |
| W37 | Env Decay | 96/102/108/114 | Спад огибающей Filt 1-4 | Слайдеры |
| W38 | Env Sustain | 97/103/109/115 | Sustan огибающей Filt 1-4 | Слайдеры |
| W39 | Env Release | 100/106/112/118 | Затухание огибающей Filt 1-4 | Слайдеры |

#### 4.3.6 Mutable Instruments PreenFM2 — CC Map (основные параметры)

PreenFM2 использует FM-синтез (Yamaha DX7-style). Основные параметры через CC и NRPN:

| № | Параметр | CC MSB | Описание | Тип элемента UI |
|--|---------|--------|----------|----------------|
| P1 | Volume | 22 | Громкость | Слайдер |
| P2 | Pan | 23 | Панорама | Слайдер |
| P3 | Algorithm | 16 | FM-алгоритм (0–28) | Dropdown/select |
| P4 | Op 1 Frequency | 50 | Частота оператора 1 (Carrier) | Слайдер |
| P5 | Op 1 Env Attack | 74 | Атака огибающей оператора 1 | Слайдер |
| P6 | Op 1 Env Decay | — NRPN | Спад огибающей оператора 1 | NRPN slider |
| P7 | Op 1 Env Sustain | — NRPN | Уровень sustain оператора 1 | NRPN slider |
| P8 | Op 1 Env Release | — NRPN | Затухание оператора 1 | NRPN slider |
| P9 | Mod Index 1 | — NRPN | Индекс модуляции оператора 1 | NRPN slider |
| P10 | Mod Index 2–5 | — NRPN | Индексы модуляции операторов 2-5 | NRPN sliders |
| P11 | Mix 1–4 | 16/18/20/22 | Микс операторов (CC, первые 4) | Слайдеры |
| P12 | Pan 1–4 | 17/19/21/23 | Панорама операторов (CC, первые 4) | Слайдеры |
| P13 | LFO Rate | — NRPN | Частота LFO | NRPN slider |
| P14 | LFO Depth | — NRPN | Глубина LFO | NRPN slider |
| P15 | Glide Time | — NRPN | Время глиссады | NRPN slider |
| P16 | Velocity Sensitivity | — NRPN | Чувствительность к velocity | NRPN slider |
| P17 | Arp Clock | 97 | Частота арпеджиатора | Слайдер |
| P18 | Arp Direction | 98 | Направление арпеджиатора (Up/Down/Bidir) | Dropdown |
| P19 | Arp Octave | 99 | Октава арпеджиатора | Dropdown |
| P20 | Arp Pattern | 100 | Паттерн арпеджиатора | Dropdown |
| P21 | Matrix ModW → Env | 62/63 | Матричная модуляция (Attack/Release mod ops) | Слайдеры |

#### 4.3.7 Arturia Bruteforce 2 — CC Map (основные ручки)

| № | Параметр | CC MSB | Описание | Тип элемента UI |
|---|---------|--------|----------|----------------|
| B1 | Volume | 7 | Громкость | Слайдер |
| B2 | Cutoff | 74 | Частота среза | **Основной слайдер** |
| B3 | Resonance | 71 | Резонанс фильтра | Слайдер |
| B4 | Attack | 74 | Время атаки (ADSR) | Слайдер |
| B5 | Decay | 76 | Время спада | Слайдер |
| B6 | Sustain | 74 | Уровень sustain | Слайдер |
| B7 | Release | 73 | Время затухания | Слайдер |
| B8 | LFO Rate | 1 | Скорость LFO | Слайдер |
| B9 | LFO Depth | 1 | Глубина LFO | Слайдер |
| B10 | Mod Wheel | 1 | Модуляция | Слайдер/ручка |
| B11 | Pitch Bend | PB | Вибрато/питч-бенд | **Двухосевой джойстик** |

### 4.4 Auto-discovery Learning Mode (детали)

Режим автоматически обнаруживает связь между контроллером и синтезаторами:

```
Phase 1: ОБНАРУЖЕНИЕ
┌─────────────────────────────────────────────┐
│  Все unrouted inputs → контроллеры          │
│  Unrouted outputs, исключая порты тех же    │
│  физических устройств (по _deviceBase())    │
│  Запуск ping sequence (5 нот × 1 сек)       │
└─────────────────────────────────────────────┘

Phase 2: ПОДКЛЮЧЕНИЕ
┌─────────────────────────────────────────────┐
│  Нажатие клавиши на контроллере             │
│  → Создан маршрут controller → synth        │
│     channels = null (все каналы)            │
│  → Подтверждение двойной нотой              │
│  → Переход к следующему синтезатору         │
└─────────────────────────────────────────────┘

Phase 3: РАБОТА
┌─────────────────────────────────────────────┐
│  Каждый контроллер подключён ко всем        │
│  доступным синтезаторам                     │
│  → Визуальная схема показывает все связи    │
│  → Можно отредактировать маршрут вручную    │
│     (выбор MIDI-канала через dropdown)      │
└─────────────────────────────────────────────┘
```

**Нормализация устройств (`_deviceBase()`):**
Порты одного физического устройства имеют разные суффиксы функций: `MIDI Port`, `DAW Port`, `KBD/KNOB`, `SOUND`. Функция `_deviceBase(name)` удаляет эти суффиксы, чтобы определить базовое имя устройства. Выводы (outputs), чьё base совпадает с любым вводом (input), исключаются из целей.

**Детали реализации:**

1. **Multi-controller**: Все unrouted inputs становятся контроллерами, каждый подключается к unrouted outputs, исключая порты тех же физических устройств.
2. **Ping timeout**: 5 тестовых нот с интервалом 1 сек; после таймаута — переход к следующему синтезатору (не зацикливание).
3. **Каналы маршрутов**: Discovery создаёт маршруты с `channels = null` (все каналы). Канальная фильтрация доступна через ручной UI-селектор.
4. **Fallback discovery**: Если устройство шлёт MIDI без маршрута — через 5 секунд создаётся маршрут по умолчанию на первый доступный output порт.
5. **Защита от дублирования**: Флаги `discoveryActive` в сервере и воркере предотвращают повторные запуски auto-connect.

### 4.5 Управление через веб-интерфейс

| № | Требование | Описание |
|---|-----------|----------|
| U1 | Адаптивный UI | Работает на мобильных (320px+), планшетах, десктопах |
| U2 | Визуальная схема маршрутизации | Drag-and-drop или автообнаружение через learning mode |
| U3 | Панель лупера | 8+ слотов с кнопками Record/Play/Stop/Loop/Overdub |
| U4 | Global controls | Tap Tempo, MIDI Clock Out, Master Volume (CC7), Mute Group |
| U5 | Пресеты маршрутов | Сохранение/загрузка конфигурации |
| U6 | Real-time feedback | Индикация активности портов, прогресс лупа, BPM |

### 4.6 API и протокол

| № | Требование | Описание |
|---|-----------|----------|
| P1 | WebSocket для управления | Команды через WS JSON |
| P2 | Бинарный MIDI поверх WS | Сырые байты как `ArrayBuffer`/`Uint8Array` (не JSON — latency) |
| P3 | REST API для пресетов | HTTP GET/POST для сохранения конфигураций |

---

## 5. Протокол коммуникации (WebSocket)

### 5.1 Команды клиента → сервера

```jsonc
// Запрос списка портов
{ "type": "request_ports" }

// Создать маршрут вручную: inputPortId -> outputPortId [каналы]
{
  "type": "create_route",
  "payload": {
    "from": "input_0",
    "to": "output_2",
    "channels": [1, 3, 5],     // null = все каналы
    "messageTypes": ["noteOn", "cc"]  // null = всё
  }
}

// Вкл/выкл learning mode для порта
{ "type": "start_learning", "payload": { "inputPortId": "input_0" } }

// Отменить обучение
{ "type": "cancel_learning", "payload": { "inputPortId": "input_0" } }

// Подтвердить обнаруженную связь
{ "type": "confirm_route", "payload": { "routeId": "r1" } }

// Удалить маршрут
{ "type": "delete_route", "payload": { "routeId": "r1" } }

// Вкл/выкл маршрут
{ "type": "toggle_route", "payload": { "routeId": "r1", "enabled": true } }

// Запись лупа
{ "type": "loop_record", "payload": { "slot": 0 } }

// Воспроизведение лупа
{ "type": "loop_play", "payload": { "slot": 0, "outputPort": "output_2" } }

// Стоп лупа
{ "type": "loop_stop", "payload": { "slot": 0 } }

// Overdub запись поверх
{ "type": "loop_overdub", "payload": { "slot": 0 } }

// Tap Tempo
{ "type": "tap_tempo" }

// ---- DAW / Clip режим (4.2) ----
// Запросить текущее состояние DAW
{ "type": "daw-get" }

// Установить темп (BPM)
{ "type": "daw-set-tempo", "bpm": 120 }

// Режим записи: 'none' | 'replace' | 'overdub'
{ "type": "daw-set-record-mode", "mode": "replace" }

// Кол-во слотов на трек (1/2/4/8)
{ "type": "daw-set-slots", "n": 4 }

// Вкл/выкл автоматическое маппинг падов (клавиша -> трек/слот)
{ "type": "daw-pad-learn", "on": true }

// Ручное маппинг note -> (трек, слот)
{ "type": "daw-pad-map", "note": 60, "trackIdx": 0, "slot": 0 }

// Симуляция нажатия пады из веб-UI (тестирование без контроллера)
{ "type": "daw-pad-trigger", "trackIdx": 0, "slot": 0 }

// Сохранить пресет DAW
{ "type": "daw-save", "name": "my_clip" }

// Загрузить пресет DAW
{ "type": "daw-load", "name": "my_clip" }

// Сохранить пресет
{ "type": "save_preset", "payload": { "name": "my_setup", "config": {...} } }

// Загрузить пресет
{ "type": "load_preset", "payload": { "name": "my_setup" } }

// Отправить CC на порт (из виртуального контроллера)
{
  "type": "send_cc",
  "payload": {
    "outputPortId": "output_0",
    "channel": 1,
    "controller": 43,     // Cutoff NTS-1
    "value": 64
  }
}

// Отправить NoteOn (из виртуального контроллера)
{
  "type": "send_note",
  "payload": {
    "outputPortId": "output_0",
    "channel": 1,
    "note": 60,
    "velocity": 80
  }
}

// Запросить список контроллеров для порта (получить CC map синтезатора)
{ "type": "request_device_info", "payload": { "outputPortId": "output_0" } }
```

### 5.2 Ответы сервера → клиенту

```jsonc
// Список портов
{ "type": "ports_list", "payload": [
  { "id": "input_0", "name": "Akai LPK25 MIDI In", "type": "input" },
  { "id": "output_0", "name": "Korg NTS-1 MIDI Out", "type": "output" }
]}

// MIDI событие от физического устройства → клиенту (визуализация)
{ "type": "midi_event", "payload": { "portId": "input_0", "data": [144, 60, 100], "timestamp": 12345.678 } }

// Прогресс лупа
{ "type": "loop_progress", "payload": { "slot": 0, "progress": 0.45, "beat": 12 } }

// Активность маршрута (мигание)
{ "type": "route_activity", "payload": { "routeId": "r1" } }

// Подтверждение обнаруженной связи
{ "type": "route_discovered", "payload": {
    "routeId": "r1",
    "from": "input_0",
    "to": "output_0",
    "channels": [1],
    "messageTypes": ["noteOn", "cc"],
    "confirmed": false  // ждёт подтверждения от пользователя
}}

// Состояние learning mode
{ "type": "learning_status", "payload": {
    "inputPortId": "input_0",
    "state": "waiting" | "timeout" | "discovered"
}}

// DAW: состояние клипов/треков/темп
{ "type": "daw_state", "payload": {
    "tempo": 120,
    "recordMode": "replace",
    "slotsPerTrack": 4,
    "tracks": [ { "channel": 1, "playing": true, "clips": [ {"notes": 3, "length": 8} ] } ],
    "loopLenBeats": 16
}}

// DAW: список маппинга падов (note -> трек/слот)
{ "type": "daw_pad_map_list", "payload": {
    "learnMode": true,
    "map": [ { "note": 60, "trackIdx": 0, "slot": 0 } ]
}}

// DAW: пресеты доступны для загрузки
{ "type": "daw-presets", "payload": { "names": ["my_clip"] }}

// DAW: MIDI-событие клипа (визуализация проиграния/записи)
{ "type": "daw_event", "payload": { "trackIdx": 0, "slot": 0, "note": 60 } }

// Информация о устройстве (CC map)
{ "type": "device_info", "payload": {
    "portId": "output_0",
    "manufacturer": "Korg",
    "model": "NTS-1",
    "controls": [
      { "cc": 43, "name": "Cutoff", "type": "slider" },
      { "cc": 42, "name": "Filter Type", "type": "dropdown" }
    ]
}}

// Ошибка
{ "type": "error", "payload": { "message": "..." }}
```

---

## 6. Структура проекта

```
~/myprojects/midirouter/
├── SPEC.md              ← этот документ
├── package.json
├── server/
│   ├── index.js         ← точка входа, WebSocket-сервер + HTTP
│   ├── midi_engine.js   ← RtMidi wrapper, routing logic, looper
│   ├── learning_mode.js ← Auto-discovery learning mode
│   ├── presets.js       ← сохранение/загрузка пресетов (JSON файлы)
│   └── config.js        ← конфигурация (порт WS, MIDI порты и т.д.)
├── client/
│   ├── index.html       ← SPA single-file app
│   ├── src/
│   │   ├── app.js       ← WebSocket клиент, UI-логика
│   │   ├── router_ui.js ← drag-and-drop схема маршрутов + learning mode
│   │   ├── looper_ui.js ← панель лупера
│   │   ├── controller_ui.js ← виртуальные контроллеры (CC map)
│   │   └── styles.css   ← адаптивные стили
├── presets/             ← JSON-файлы пресетов маршрутов
└── README.md            ← инструкция по запуску
```

---

## 7. Критерии качества

| Параметр | Требование |
|----------|-----------|
| **Латентность роутинга** | < 5ms от получения байта до отправки (внутренний, между портами Pi) |
| **Точность лупа** | Jitter < 1ms при воспроизведении |
| **Стабильность** | Сервер работает 24/7 без перезапуска |
| **UI-отклик** | WebSocket команда → реакция UI < 50ms на локальной сети |

---

## 8. Этапы разработки

### Этап 1: Базовый роутинг (MVP)
- [ ] Node.js сервер + RtMidi/ALSA подключение
- [ ] Enumerate MIDI портов
- [ ] Простой роутинг 1:1 между портами
- [ ] WebSocket API для управления маршрутами
- [ ] Минимальный веб-UI с drag-and-drop

### Этап 2: Auto-discovery learning mode
- [ ] Режим ожидания CC от синтезатора
- [ ] Автоматическое создание маршрута при обнаружении
- [ ] Подтверждение на клиенте
- [ ] Timeout и сброс режима

### Этап 3: Виртуальные контроллеры
- [ ] БД CC-мапов для Korg NTS-1, Modal Craft Synth 2.0, Arturia Bruteforce 2
- [ ] Отображение виртуальных слайдеров/кнопок на клиенте
- [ ] Отправка CC через WebSocket → сервер → MIDI Out

### Этап 4: Расширенный роутинг
- [ ] 1:N и N:1 маршрутизация
- [ ] Фильтрация по каналам и типам сообщений
- [ ] Toggle On/Off для маршрутов
- [ ] Визуализация трафика в реальном времени

### Этап 5: Лупер
- [ ] Запись/воспроизведение MIDI с таймингом
- [ ] Циклический луп (loop mode)
- [ ] 8+ слотов для клипов
- [ ] Overdub / Punch-in

### Этап 6: Полировка
- [ ] Tap Tempo, MIDI Clock Out
- [ ] Quantization
- [ ] Пресеты маршрутов (сохранение/загрузка)
- [ ] Адаптивный дизайн для мобильных
- [ ] README и инструкция по установке на Pi

---

## 9. Зависимости

### Сервер
| Пакет | Назначение |
|-------|-----------|
| `@julusian/midi` | RtMidi wrapper для Node.js (нативный доступ к MIDI через ALSA) |
| `ws` или `uWebSockets.js` | WebSocket сервер (uWebSockets — быстрее, меньше latency) |
| `express` | HTTP-сервер для отдачи статического UI |

### Клиент
- Чистый JavaScript (vanilla JS) без фреймворков — лёгкий SPA, быстрая загрузка с мобильного
- WebSocket API (нативный)
- CSS Grid / Flexbox для адаптивной вёрстки

---

## 10. Риски и ограничения

| Риск | Mitigation |
|------|-----------|
| Latency при высокой нагрузке | uWebSockets + ring buffer вместо JSON для MIDI-пакетов |
| Web MIDI API не работает на iOS Safari | Клиент подключается к серверу через WS, а не напрямую к MIDI — не проблема, так как Pi имеет доступ к устройствам |
| JACK vs ALSA на Linux | Поддержка обоих бэкендов в @julusian/midi; JACK даёт меньший latency но требует настройки |
| Конфликт портов несколькими приложениями | Сервер монопольно держит MIDI-порты; другие приложения не подключаются к тем же портам |
