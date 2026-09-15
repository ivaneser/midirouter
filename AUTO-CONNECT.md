# Авто-подключение (Auto-Connect)

## Цель
Автоматически определять MIDI контроллеры и синтезаторы, создавать маршруты нажатием клавиши на контроллере — без ручных действий в интерфейсе. Поддерживает **несколько контроллеров**, каждый из которых подключается ко всем доступным синтезаторам.

## Логика работы

### 1. Инициация
Авто-подключение запускается **автоматически** при старте сервера после обнаружения портов (событие `ready`):

```js
// server.js: ready handler
case 'ready':
    if (!this.autoConnectStarted) {
        this.autoConnectStarted = true;
        console.log('[SERVER] MIDI initialized — starting auto-connect...');
        setTimeout(() => this.startAutoConnect(), 200);
    }
    break;
```

**Защита от дублирования:** Сервер отслеживает флаг `discoveryActive` и не запускает повторный обзвон, если discovery уже активен. Воркер также проверяет `this.discoveryState.active`.

### 2. Классификация устройств
Воркер собирает все unrouted (без маршрутов) input и output порты:

- **Все unrouted inputs** — становятся контроллерами
- **Все unrouted outputs** — становятся целями для каждого контроллера

```js
// Для каждого controller создаём список целей из всех unrouted outputs
for (const controller of allInputs) {
    const targets = [...allOutputs.map(o => o.id)];  // все synths
    
    this.discoveryState.controllers.set(controller.id, {
        targets: targets,
        connectedTargets: new Set(),
        currentTargetIdx: 0
    });
}
```

**Пример:** Если подключены Launchkey (1 input) и два синтезатора Korg NTS-1 + Craft Synth (2 outputs), то Launchkey получит маршруты на оба синтезатора.

### 3. Обзвон синтезаторов (ping sequence)
Для каждого целевого устройства запускается последовательность из **5 нот** с интервалом **1 секунда**:

```js
_pingSynth(targetId, controllerId):
    sentCount = 0, maxPings = 5
    
    pingOnce():
        if sentCount >= 5:
            → таймаут, переход к следующему синтезу для этого контроллера
            _nextSynthForController(controllerId)
            
        _sendTestNoteToOutput(targetId)   // C4 (0x90 0x3C 0x7F) + note off через 100мс
        sentCount++
        
        timer = setTimeout(pingOnce, 1000)  # следующая нота через 1 сек
```

### 4. Ожидание note ON от контроллеров
Во время пинга воркер фильтрует входящие MIDI сообщения:

```js
// _routeMessage() во время discovery active:
controllerState = discoveryState.controllers.get(inputPortId)

if (!controllerState):
    → не активный контроллер, игнорируем
    
statusByte = message[0]
isNoteOn = (statusByte & 0xF0) === 0x90 && message[2] > 0

if (!isNoteOn):
    → игнорируем (CC от knobs, note off и т.д.)
    
if inputPortId в controllers:
    → создаём маршрут controller → synth по текущему индексу
    → отправляем двойную ноту подтверждения
    → _nextSynthForController(inputPortId)
```

**Важно:** Фильтр `(statusByte & 0xF0) === 0x90` оставляет только note on (0x90-0x9F). CC сообщения (0xB0-0xBF) игнорируются — они могут приходить от поворота knobs на синтезаторах.

### 5. Подтверждение подключения
При получении note ON:
1. Останавливается текущий таймер пинга
2. Создаётся маршрут `input → output` через `_createRoute()`
3. Отправляется двойная нота подтверждения (`_sendConfirmationNote()`) — две ноты C4 с интервалом 200мс каждая
4. Целевой синтез помечается как подключённый в `connectedTargets`
5. Переход к следующему синтезу для этого контроллера

### 6. Завершение discovery
```js
_nextSynthForController(controllerId):
    controllerState.currentTargetIdx++
    
    if connectedTargets.size == targets.length:
        → все цели подключены, удаляем контроллер из discoveryState.controllers
        
    if controllers.size == 0:
        → все контроллеры завершены, _endDiscovery()
        
    else:
        → continue ping cycle с следующего синтезатора
```

## Состояния discovery

### Структура `discoveryState`
| Поле | Описание |
|------|----------|
| `active` | true во время обзвона всех контроллеров |
| `controllers` | Map<controllerId, {targets, connectedTargets, currentTargetIdx}> — состояние каждого контроллера |
| `unroutedCounters` | Счётчик сообщений от unrouted входов (для fallback discovery) |

### Переходы состояний
```
[START] → discoveryState.active = true
           ↓
    [PING CYCLE] ← обзваниваем все цели по кругу
           ↓
    [NOTE ON received] → создаём маршрут, переходим к следующей цели
           ↓
    [ALL TARGETS CONNECTED] → controllers.delete(controllerId)
           ↓
    [NO CONTROLLERS LEFT] → _endDiscovery() → active = false
```

## Fallback Auto-Discovery (без auto-connect)
Если устройство шлёт MIDI без маршрута и discovery не запущен вручную:
1. Первые 3 сообщения шлются на клиент для визуализации
2. Через **5 секунд** без маршрута — создаётся маршрут по умолчанию на первый доступный output порт

## Команды
```js
// Отправка команды авто-подключения (из UI или автоматически):
server.worker.postMessage({ type: 'auto-connect' });

// Ответ сервера клиенту при завершении:
{ "type": "discovery-complete" }
```

## Типичные сценарии тестирования

### Сценарий 1: Один контроллер → несколько синтезаторов
1. Запуск сервера → автоматический обзвон всех unrouted outputs
2. Нажатие клавиши на Launchkey во время пинга первого синтезатора → маршрут создан
3. Повторное нажатие → маршрут ко второму синтезатору
4. Проверка лога: `received note ON from Launchkey → connecting to Korg NTS-1`

### Сценарий 2: Несколько контроллеров → несколько синтезаторов
1. Каждый unrouted input становится отдельным контроллером
2. Каждый контроллер обзванивает все unrouted outputs
3. Нажатие на каждом контроллере создаёт маршрут к следующему доступному синтезу

### Сценарий 3: Защита от бесконечного пинга
1. Если синтезатор не отвечает — после 5 попыток таймаут
2. Переход к следующему синтезору, а не зацикливание
3. Discovery завершается когда все контроллеры обработаны

## Ошибки и отладка

| Ситуация | Причина | Решение |
|----------|---------|---------|
| Бесконечный обзвон | Устаревший `_nextSynth()` без проверки `allConnected` | Исправлено: проверка завершённости для каждого контроллера |
| Ложные маршруты от CC knobs | Фильтр не применялся | `(statusByte & 0xF0) === 0x90` оставляет только note ON |
| Дублирование auto-connect | Несколько вызовов `startAutoConnect()` | Флаги `discoveryActive` в сервере и воркере |
| "Cannot create route: invalid outputId" | Порт не найден в `this.outputs` | Проверка `outputs.has(outputId)` перед созданием маршрута |

## Сравнение старой и новой архитектуры

### До исправления (single controller)
```
discoveryState: {
    waitingForInput: "Launchkey",  // ОДНОЗНАЧНО!
    unroutedOutputs: ["NTS-1", "Craft"],
    currentOutputIndex: 0          // Один индекс на всех
}

_nextSynth():
    index++ → _pingAllSynths()  // Всегда зацикливается!
```

### После исправления (multi-controller)
```
discoveryState: {
    controllers: Map {
        "Launchkey": { targets: ["NTS-1", "Craft"], connectedTargets: Set{}, currentTargetIdx: 0 },
        "AbletonPush2": { targets: ["NTS-1", "Craft"], connectedTargets: Set{}, currentTargetIdx: 0 }
    }
}

_nextSynthForController("Launchkey"):
    index++ → проверить всеConnected → если да, удалить из Map
    _endDiscovery() когда все контроллеры завершены
```
