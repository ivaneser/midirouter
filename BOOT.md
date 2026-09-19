# BOOT — plug & play для Raspberry Pi

Готовый сценарий «вставил карту → работает». Никаких команд не нужно, кроме **одного** запуска `bootstrap.sh` по SSH в первый раз.

## Что нужно на старте
1. Образ **Raspberry Pi OS (64-bit, Bookworm)** — залей через *Raspberry Pi Imager*.
2. В Imager (Advanced options / ⚙) включи:
   - **SSH** — Remote SSH access enabled
   - Wi-Fi — можно оставить пустым, сеть `master` настроит сам bootstrap
3. Вставь карту в Pi, включи.

## Первый запуск (один раз)
Зайди по SSH (или через HDMI+клавиатуру):
```bash
ssh pi@<ip>                 # пароль по умолчанию raspberry
sudo bash ~/myprojects/midirouter/bootstrap.sh   # если скопировал репозиторий
# или, если репозитория ещё нет:
cd /tmp && curl -fsSL https://raw.githubusercontent.com/ivaneser/midirouter/main/bootstrap.sh -o bootstrap.sh && sudo bash bootstrap.sh
```

Скрипт сам:
- находит Wi-Fi `master` и подключается;
- ставит Node.js, ALSA, git;
- добавляет юзера `pi` в группу `audio`;
- применяет фикс UMP для ALSA (`enable_ump=0`) — иначе порты не видны;
- клонирует/обновляет репозиторий и делает `npm install`;
- включает автозапуск `midirouter.service`;
- **перезагружает Pi** (чтобы применился фикс UMP).

После перезагрузки сервер стартует автоматически. Открой в браузере:
```
http://<ip-pi>:3000
```

## Настройки под себя
Все параметры меняются переменными окружения перед запуском:
```bash
MIDIR_USER=pi MIDIR_REPO=/home/pi/myprojects/midirouter sudo bash bootstrap.sh
```
- `WIFI_SSID` / `WIFI_PASS` — имя и пароль Wi-Fi (внутри скрипта).

## Если что-то не запустилось
```bash
sudo journalctl -u midirouter.service -n 50     # логи сервера
aconnect -i                                      # видны ли MIDI-порты?
lsmod | grep snd                                 # snd_seq с enable_ump=0
systemctl status midirouter.service              # статус сервиса
```

## Откат / удаление автозапуска
```bash
sudo systemctl disable --now midirouter.service
sudo rm /etc/systemd/system/midirouter.service