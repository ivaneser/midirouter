# Авто-подключение (Auto-Connect)

## Цель
Автоматически определять MIDI контроллеры и синтезаторы, создавать маршруты нажатием клавиши на контроллере — без ручных действий в интерфейсе.

## Логика работы

### 1. Инициация
Авто-подключение запускается **автоматически** при старте сервера после обнаружения портов (событие `ready`):

```js
// server.js: ready handler
case 'ready':
    console.log('[SERVER] MIDI initialized — starting auto-connect...');
    this.worker.postMessage({ type: 'auto-connect' });
    break;
```

### 2. Классификация устройств
Воркер собирает все unrouted (без маршрутов) input порты:
- **Первый** — контроллер (от него ожидается note ON)
- **Остальные** — целевые синтезаторы (на них отправляются тестовые ноты)

```js
const controller = allInputs[0];      // Контроллер
const targets = allInputs.slice(1);   // Синтезаторы для обзвона
```

### 3. Обзвон синтезаторов (ping sequence)
Для каждого целевого устройства запускается последовательность из **5 нот** с интервалом **1 секунда**:

```js
_pingSynth(targetId, callbackOnSuccess):
    sentCount = 0, maxPings = 5
    
    pingOnce():
        if sentCount >= 5:
            → таймаут, переход к следующему
            
        _sendTestNoteToOutput(targetId)   // C4 (0x90 0x3C 0x7F) + note off через 100мс
        sentCount++
        
        timer = setTimeout(pingOnce, 1000)  // следующая нота через 1 сек
```

### 4. Ожидание note ON от контроллера
Во время пинга воркер фильтрует входящие MIDI сообщения:

```js
// _routeMessage() во время discovery active:
statusByte = message[0]
isNoteOn = (statusByte & 0xF0) === 0x90 && message[2] > 0

if (!isNoteOn):
    → игнорируем (CC от knobs, note off и т.д.)
    
if inputPortId === waitingForInput:
    → создаём маршрут controller → synth
    → отправляем двойную ноту подтверждения
    → переходим к следующему синтезатору
```

**Важно:** Фильтр `(statusByte & 0xF0) === 0x90` оставляет только note on (0x90-0x9F). CC сообщения (0xB0-0xBF) игнорируются — они могут приходить от поворота knobs на синтезаторах.

### 5. Подтверждение подключения
При получении note ON:
1. Останавливается текущий таймер пинга
2. Создаётся маршрут `input → output` через `_createRoute()`
3. Отправляется двойная нота подтверждения (`_sendConfirmationNote()`) — две ноты C4 с интервалом 200мс каждая
4. Переход к следующему синтезатору в очереди

### 6. Завершение
```js
_nextSynth():
    currentOutputIndex++
    
    if currentOutputIndex >= unroutedOutputs.length:
        → все подключены, _endDiscovery()
        
    else:
        → _pingSynth(nextTarget)
```

## Состояния discovery
| Поле | Описание |
|------|----------|
| `active` | true во время обзвона |
| `waitingForInput` | deviceName контроллера (ожидание note ON от него) |
| `unroutedOutputs` | массив deviceName синтезаторов для подключения |
| `currentOutputIndex` | индекс текущего синтезатора в очереди |

## Команды
```js
// Отправка команды авто-подключения:
server.worker.postMessage({ type: 'auto-connect' });
```

## Типичные сценарии тестирования
1. Запуск сервера → автоматический обзвон
2. Нажатие клавиши на Launchkey во время пинга любого синтезатора
3. Проверка лога: `received note ON from Launchkey... → creating route`
4. Двойная нота подтверждения звучит на подключённом синтезаторе

## Ошибки и отладка
- "Cannot create route: invalid outputId" — порт не найден в `this.outputs` (исправлено проверкой `outputs.has()`)
- Ложные маршруты от CC knobs — решено фильтром `(statusByte & 0xF0) === 0x90`
