#!/usr/bin/env bash
# =============================================================================
# midirouter — plug & play first-boot setup for Raspberry Pi
# -----------------------------------------------------------------------------
# Делает всё один раз и включает автозапуск сервера. Запусти один раз по SSH:
#     sudo bash bootstrap.sh
# Скрипт ипотентен — его можно гонять повторно, он ничего не сломает.
# В конце применяет фикс ALSA/UMP (нужна перезагрузка) и перезагружает Pi.
# =============================================================================

set -uo pipefail

# ---- Настройки (измени под себя) -------------------------------------------
USER_NAME="${MIDIR_USER:-pi}"                 # юзер, от которого работает сервер
# резолвим домашнюю директорию юзера из БД passwd (не из $ROOT_HOME при sudo)
TARGET_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
[ -z "$TARGET_HOME" ] && TARGET_HOME="$HOME"
REPO_DIR="${MIDIR_REPO:-$TARGET_HOME/myprojects/midirouter}"
WIFI_SSID="master"                              # имя сети
WIFI_PASS="SergeIvanenko"                       # пароль сети
WIFI_COUNTRY="GB"                               # country code для wpa_supplicant

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
log()  { echo -e "${GRN}[midirouter]${NC} $*"; }
warn() { echo -e "${YEL}[warning]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; }

# sudo works whether we are already root or a normal user (passwordless assumed)
SUDO="sudo"
[ "$(id -u)" -eq 0 ] && log "running as root"

log "Bootstrap starts for user '${USER_NAME}' on host $(hostname)"

# -----------------------------------------------------------------------------
# 1. WiFi (headless, через /etc/wpa_supplicant/wpa_supplicant.conf)
# -----------------------------------------------------------------------------
if [ -d /etc/wpa_supplicant ]; then
    $SUDO bash -c "cat > /etc/wpa_supplicant/wpa_supplicant.conf <<'EOF'
ctrl_interface=/run/wpa_supplicant
update_config=1
country=${WIFI_COUNTRY}

network={
    ssid=\"${WIFI_SSID}\"
    psk=\"${WIFI_PASS}\"
    key_mgmt=WPA-PSK
}
EOF"
    log "WiFi '${WIFI_SSID}' written to /etc/wpa_supplicant/wpa_supplicant.conf"
else
    warn "/etc/wpa_supplicant not found — skip WiFi setup, configure manually."
fi

# -----------------------------------------------------------------------------
# 2. Системные зависимости
# -----------------------------------------------------------------------------
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
    nodejs npm alsa-utils libasound2-dev git ca-certificates

if ! command -v node >/dev/null 2>&1; then
    err "node not found after install"; exit 1
fi
log "node $(node --version) installed at $(command -v node)"

# -----------------------------------------------------------------------------
# 3. Права доступа к /dev/snd (группа audio)
# -----------------------------------------------------------------------------
for grp in audio plugdev; do
    id -nG "$USER_NAME" | grep -qw "$grp" || $SUDO usermod -aG "$grp" "$USER_NAME"
done
log "User '$USER_NAME' added to groups: audio, plugdev"

# -----------------------------------------------------------------------------
# 4. Фикс ALSA UMP-режима (нужна перезагрузка для применения)
#    enable_ump=1 скрывает legacy-порты от aconnect — убираем его навсегда.
# -----------------------------------------------------------------------------
if [ -r /sys/module/snd_seq/parameters/enable_ump ]; then
    CUR=$(cat /sys/module/snd_seq/parameters/enable_ump 2>/dev/null || echo "1")
    if [ "$CUR" = "1" ]; then
        warn "UMP mode is ON — will disable via modprobe (needs reboot)."
        $SUDO bash -c 'echo "options snd-seq enable_ump=0" > /etc/modprobe.d/snd-seq-ump.conf'
    fi
else
    $SUDO bash -c 'echo "options snd-seq enable_ump=0" > /etc/modprobe.d/snd-seq-ump.conf'
fi

# -----------------------------------------------------------------------------
# 5. Репозиторий + зависимости проекта
# -----------------------------------------------------------------------------
if [ ! -d "$REPO_DIR" ]; then
    mkdir -p "$(dirname "$REPO_DIR")"
    $SUDO -u "$USER_NAME" git clone https://github.com/ivaneser/midirouter.git "$REPO_DIR" 2>&1 \
        || { err "git clone failed"; exit 1; }
fi
cd "$REPO_DIR" || { err "cannot cd to $REPO_DIR"; exit 1; }
$SUDO -u "$USER_NAME" npm install --omit=dev

# -----------------------------------------------------------------------------
# 6. Автозапуск через systemd (сервер стартует при включении Pi)
# -----------------------------------------------------------------------------
$SUDO cp "${REPO_DIR}/midirouter.service" /etc/systemd/system/midirouter.service
$SUDO cp "${REPO_DIR}/metronome.service" /etc/systemd/system/metronome.service
# Patch user / working directory from variables
$SUDO sed -i "s|^User=.*|User=${USER_NAME}|" /etc/systemd/system/midirouter.service
$SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_DIR}|" /etc/systemd/system/midirouter.service
$SUDO sed -i "s|^User=.*|User=${USER_NAME}|" /etc/systemd/system/metronome.service
$SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_DIR}|" /etc/systemd/system/metronome.service

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now midirouter.service
$SUDO systemctl enable --now metronome.service
log "midirouter.service enabled and started"

# -----------------------------------------------------------------------------
# 7. Проверка и перезагрузка (чтобы применился фикс UMP)
# -----------------------------------------------------------------------------
sleep 2
if $SUDO systemctl is-active --quiet midirouter; then
    log "Server is running: http://<pi-ip>:3000"
else
    warn "Service not active — check: sudo journalctl -u midirouter.service -n 50"
fi

warn "Rebooting now so ALSA loads with enable_ump=0 (MIDI ports will be correct on next boot)."
$SUDO reboot
