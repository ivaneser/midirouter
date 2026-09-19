# SETUP & DEPLOYMENT

## 🟢 Plug & Play для Raspberry Pi (рекомендуется)
Залуй Raspberry Pi OS через Imager → зайди по SSH → один раз:
```bash
sudo bash bootstrap.sh
```
Всё сделает само: Wi-Fi `master`, Node.js, группа `audio`, фикс UMP, автозапуск сервера. Подробнее — **`BOOT.md`**.

## Установка на Ubuntu (Raspberry Pi)

### Системные требования
- Node.js v22+ 
- ALSA Sequencer (`/dev/snd/seq`) — драйвер MIDI ядра Linux
- Права доступа к `/dev/snd/*` (группа `audio` или `plugdev`)

### Установка зависимостей
```bash
cd ~/myprojects/midirouter
npm install
```

### Настройка ALSA Sequencer

#### 1. Загрузка виртуальных MIDI портов (для тестирования)
```bash
# Автоматический скрипт:
sudo bash setup-midi-emulator.sh

# Или вручную:
sudo modprobe snd-seq-dummy midi_devs=2
sudo modprobe snd-seq-virmidi midi_devs=2
```

#### 2. Отключение UMP Mode (Universal MIDI Ports)
ALSA 1.2+ работает в режиме UMP, который скрывает legacy порты от `aconnect`.

**Решение:** Создать конфигурационный файл:
```bash
sudo bash -c 'echo "options snd-seq enable_ump=0" > /etc/modprobe.d/snd-seq-ump.conf'
```
⚠️ **Требует перезагрузки системы!** Без этого `aconnect` не покажет виртуальные порты.

#### 3. Права доступа к `/dev/snd/seq`
Если ошибка `Permission denied`:
```bash
# Добавить пользователя в группу audio:
sudo usermod -aG audio $USER
sudo usermod -aG plugdev $USER
# Перезайти в систему!
```

#### 4. Проверка работы
```bash
aconnect -o        # Показать output порты
aconnect -i        # Показать input порты  
lsmod | grep snd   # Загруженные модули ALSA
cat /proc/asound/seq/devices  # Устройства sequencer
```

### Автозагрузка эмулятора (systemd)
```bash
sudo cp midi-emulator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable midi-emulator.service
sudo systemctl start midi-emulator.service
```

## Установка на macOS (Mac Mini)

На Mac ALSA отсутствует — используется нативный CoreMIDI через RtMidi.

### Установка
```bash
cd ~/myprojects/midirouter
npm install
node server.js
```

CoreMIDI работает без дополнительных настроек. Все USB-MIDI устройства автоматически обнаруживаются системой.

## Запуск сервера
```bash
# Обычный режим:
node server.js

# Режим разработки (автоперезагрузка):
node --watch server.js
```

Сервер запускается на `http://localhost:3000` и WebSocket на порту 3000.

## Контейнеризация (Docker)
```bash
docker build -t midirouter .
docker run --privileged -p 3000:3000 midirouter
```

Файлы `Dockerfile` и `docker/etc/supervisord.conf` предоставляют базовую конфигурацию.

## Структура данных устройств

### device_maps/*.json
Описания MIDI устройств для динамического рендеринга контролов в UI:
- `arturia_microfreak.json`
- `korg_nts1.json`  
- `modal_craft_synth_v2.json`
- `preenfm2.json`
- `waldorf_blofeld.json`

Формат:
```json
{
    "name": "NTS-1",
    "controls": [
        {"cc": 20, "label": "PITCH BEND", "min": -8192, "max": 8191},
        {"cc": 37, "label": "BANK SELECT", "min": 0, "max": 127}
    ]
}
```

### Автопоиск схем маппинга
При отсутствии локального JSON — серверный запрос к GitHub API:
```
https://api.github.com/search/code?q=...
```
