#!/usr/bin/env bash
# =============================================================================
# fix-midi-perms.sh — починить доступ к ALSA (/dev/snd) для midirouter.service
# -----------------------------------------------------------------------------
# Проблема: worker падает с "open /dev/snd/seq failed: Operation not permitted",
# из-за чего HTTP/WS-сервер не стартует. Скрипт применяет юнит и автоматически
# подбирает рабочий режим: сначала non-root с CAP_SYS_RAWIO, а если всё ещё
# EPERM — переключается на запуск от root (надёжно для выделенного устройства).
#
#     sudo bash fix-midi-perms.sh
# Скрипт ипотентен, можно гонять повторно.
# =============================================================================

set -uo pipefail

USER_NAME="${MIDIR_USER:-pi}"
TARGET_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)
[ -z "$TARGET_HOME" ] && TARGET_HOME="$HOME"
REPO_DIR="${MIDIR_REPO:-$TARGET_HOME/myprojects/midirouter}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
log() { echo -e "${GRN}[midirouter]${NC} $*"; }
warn() { echo -e "${YEL}[warning]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; }

if [ "$(id -u)" -ne 0 ]; then
    err "Нужен sudo:  sudo bash fix-midi-perms.sh"
    exit 1
fi
SUDO=""

write_unit() {
    # $1 = User= значение ("" -> юзер ${USER_NAME}, "root" -> root)
    local user_arg="$1"
    local cap_line=""
    [ "$user_arg" = "${USER_NAME}" ] && cap_line="AmbientCapabilities=CAP_SYS_RAWIO"

    cat > /etc/systemd/system/midirouter.service <<EOF
[Unit]
Description=MIDI Router / DAW Looper (midirouter)
After=network-online.target snd-seq.service
Wants=network-online.target

[Service]
Type=simple
User=${user_arg}
Group=audio
SupplementaryGroups=audio
${cap_line}
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
PrivateDevices=no
DeviceAllow=/dev/snd rw

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl restart midirouter.service
}

log "Применяю юнит для юзера '${USER_NAME}', репо: ${REPO_DIR}"

# 1) Попытка non-root с CAP_SYS_RAWIO
write_unit "${USER_NAME}"
sleep 6
if $SUDO systemctl is-active --quiet midirouter && grep -q "Worker is ready" <($SUDO journalctl -u midirouter.service --since "+7s ago" --no-pager 2>/dev/null); then
    log "non-root с CAP_SYS_RAWIO работает"
else
    warn "non-root не запустился — переключаюсь на запуск от root (надёжно для /dev/snd)"
    write_unit "root"
fi

# 2) Проверка результата
if grep -q "Worker is ready" <($SUDO journalctl -u midirouter.service --since "+8s ago" --no-pager 2>/dev/null); then
    log "✅ Worker дошёл до 'Worker is ready'"
else
    warn "worker не дошёл до готовности — смотри логи:"
fi

echo
if $SUDO systemctl is-active --quiet midirouter && curl -fsS http://localhost:3000 >/dev/null 2>&1; then
    log "✅ OK — веб-сервер отвечает на http://localhost:3000"
else
    warn "curl не ответил. Последние 40 строк логов:"
    $SUDO journalctl -u midirouter.service -n 40 --no-pager
fi
