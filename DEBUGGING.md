# DEBUGGING & KNOWN ISSUES

## Типичные ошибки и решения

### 1. `open /dev/snd/seq failed: Permission denied`
**Причина:** Пользователь не в группе `audio` или `plugdev`.  
**Решение:**
```bash
sudo usermod -aG audio $USER
sudo usermod -aG plugdev $USER
# Перезайти в систему! (logout/login)
```

### 2. ALSA UMP Mode — порты не видны через `aconnect`
**Признак:** `aconnect -o` показывает только `Midi Through`, хотя модули загружены.  
**Причина:** ALSA 1.2+ работает в режиме Universal MIDI Ports, legacy endpoints скрыты.  
**Решение:**
```bash
# Создать конфиг отключения UMP:
sudo bash -c 'echo "options snd-seq enable_ump=0" > /etc/modprobe.d/snd-seq-ump.conf'
# Перезагрузка системы обязательна!
```

### 3. `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`
**Причина:** `node_modules` исключён из git, не установлен локально.  
**Решение:**
```bash
npm install
```

### 4. Сервер не останавливается по Ctrl-C
**Причина:** Воркер блокирует exit или WebSocket соединения не закрыты.  
**Диагностика:** Многократное нажатие `ctrl-c` до остановки.  
**Решение:** В `server.js` метод `cleanup()` должен корректно завершать воркер:
```js
process.on('SIGINT', async () => {
    console.log('[SERVER] Shutting down...');
    if (worker) {
        worker.postMessage({ type: 'shutdown' });
        // Проверка: если воркер не вышел за 3 сек — terminate
        await new Promise(resolve => setTimeout(resolve, 3000));
        if (!worker.exited) {
            console.log('[SERVER] Worker did not exit gracefully — terminating');
            worker.terminate();
        }
    }
    server.close();
    process.exit(0);
});
```

### 5. `Cannot create route: invalid outputId undefined`
**Причина:** `_createRoute()` проверял `this.routes.has(outputId)` вместо `this.outputs.has(outputId)`.  
**Решение:** Заменить проверку на валидацию наличия порта в outputs.

### 6. Дублирование UI карточек устройств
**Причина:** `loadDevices()` загружал ВСЕ JSON файлы из `data/devices/`, а `renderDynamicControls()` не очищал контейнер перед рендерингом.  
**Решение:**
- Удалить загрузчик JSON из controller-ui.js
- Переписать `_updateDeviceList()` для фильтрации реальных устройств
- Очистка `devices-container.innerHTML = ''` перед рендерингом

### 7. Дублирование обработчиков MIDI событий (handler duplication)
**Причина:** Watchdog вызывал `_enumeratePorts()` каждые 5 секунд, добавляя новые `midiIn.on('message', ...)` без очистки старых.  
**Решение:** Полностью убрать watchdog из основного цикла. Обработчики навешиваются один раз при открытии порта.

### 8. Ложные маршруты от CC knobs синтезаторов
**Причина:** Во время auto-connect сервер ловил любое MIDI сообщение, включая CC (0xBx) от поворота knobs на синтезаторах.  
**Решение:** Фильтр `(statusByte & 0xF0) === 0x90` — принимать только note ON.

### 9. Авто-подключение запускается дважды
**Причина:** Автоматический запуск по событию `ready` И ручная кнопка во фронтенде.  
**Решение:** Удалить кнопку «Авто-соединение» из UI, оставить только автоматический запуск.

## Диагностика MIDI устройств

### Проверка загрузки модулей ALSA
```bash
lsmod | grep snd_seq
# Должно показать: snd_seq_dummy, snd_seq_virmidi, snd_seq_midi, ...
```

### Проверка портов
```bash
aconnect -o          # Output порты
aconnect -i          # Input порты  
aconnect -l          # Все подключения
```

### Проверка через RtMidi (Node.js)
Скрипт `test-midi-detection.js`:
```bash
node test-midi-detection.js
# Показывает все порты, видимые через @julusian/midi
```

### Просмотр устройств sequencer
```bash
cat /proc/asound/seq/devices
```

## Режимы отладки сервера
```bash
# С логированием:
node server.js 2>&1 | tee midirouter.log

# Автоперезагрузка при изменениях:
node --watch server.js
```
