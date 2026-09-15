# Настройка и развёртывание (Setup & Deployment)

## Системные требования
- **Linux:** Ubuntu 20.04+ с ALSA sequencer (`/dev/snd/seq`)
- **macOS:** CoreMIDI через RtMidi (нативно, без ALSA проблем)
- **Raspberry Pi:** ALSA sequencer предпочтительнее PipeWire MIDI

## Зависимости проекта
```bash
npm install  # @julusian/midi ^3.8.1, ws ^8.16.0
```

**Важно:** `node_modules/` и `package-lock.json` исключены из git репозитория. После клонирования всегда запускайте `npm install`.

## Запуск сервера
```bash
# Linux / Raspberry Pi
cd ~/myprojects/midirouter
node server.js

# macOS (CoreMIDI)
git pull --rebase && npm install && node server.js
```

Сервер запускается на:
- HTTP/WS: `http://localhost:3000`
- Worker Thread: ALSA/CoreMIDI routing (<2ms latency)

## Настройка виртуальных MIDI портов (Ubuntu)

### Проблема UMP Mode
Modern Ubuntu 24.04+ использует PipeWire UMP MIDI2 вместо legacy ALSA sequencer. В этом режиме виртуальные порты не видны RtMidi — они появляются как PipeWire MIDI2 клиенты, а не ALSA endpoints.

### Решение: отключение UMP
Создан файл `/etc/modprobe.d/snd-seq-ump.conf`:
```
options snd-seq enable_ump=0
```

### Загрузка виртуальных модулей
После перезагрузки или ручной загрузки:
```bash
# Требуется sudo доступ (настроен через /etc/sudoers.d/midirouter)
sudo modprobe snd-seq-dummy midi_devs=2
sudo modprobe snd-seq-virmidi midi_devs=2

# Проверка
aconnect -o  # Должно показать виртуальные порты
cat /proc/asound/seq/clients | grep "User Legacy"
```

### Автоматическая загрузка при старте
Используйте предоставленные файлы:
- `setup-midi-emulator.sh` — ручной скрипт загрузки модулей
- `midi-emulator.service` — systemd unit для автозагрузки

```bash
sudo cp midi-emulator.service /etc/systemd/system/
sudo systemctl enable --now midi-emulator.service
```

### Права доступа к ALSA sequencer
Пользователь должен иметь доступ к `/dev/snd/seq`:
- Группа `audio` или `plugdev`
- Или udev правила для разрешения доступа

## Настройка на Mac Mini (CoreMIDI)
На macOS проблем с UMP нет — CoreMIDI работает нативно через RtMidi.

```bash
cd ~/myprojects/midirouter
git pull --rebase
npm install
node server.js
```

Все USB-MIDI устройства видны напрямую:
- Контроллеры (Launchkey, nanoKONTROL2)
- Синтезаторы (NTS-1, Craft Synth 2.0, MODALapp)

## Docker развёртывание
Проект поддерживает контейнеризацию через `Dockerfile` и supervisord.

```bash
# Сборка образа
docker build -t midirouter .

# Запуск
docker run --privileged -p 3000:3000 midirouter
```

## Troubleshooting

### Port не виден в aconnect
```bash
# Проверьте загружены ли модули
lsmod | grep snd_seq

# Перезагрузите с отключённым UMP
sudo rmmod snd-seq-dummy snd-seq-virmidi 2>/dev/null
sudo modprobe snd-seq enable_ump=0 midi_devs=2 virmidi_midi_devs=2 dummy_midi_devs=2

# Проверьте права доступа
ls -la /dev/snd/seq
```

### Permission denied на sequencer
```bash
# Добавьте пользователя в группу audio (требует logout/relogin)
sudo usermod -aG audio $USER

# Или временное разрешение (не рекомендуется для production)
sudo chmod 666 /dev/snd/seq
```

### RtMidi не видит USB устройства
- Проверьте что устройства подключены до запуска сервера
- Убедитесь что нет конфликта с другими MIDI приложениями
- На macOS: System Preferences → Security & Privacy → MIDI access (разрешить)
