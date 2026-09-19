#!/usr/bin/env bash
# =============================================================================
# fix-user-namespace.sh — починить EPERM на open("/dev/snd/seq") в midirouter.service
# -----------------------------------------------------------------------------
# Причина: systemd по умолчанию ставит PrivateUsers=yes, и сервис стартует во
# вложенном user namespace. Внутри not-initial userns CAP_SYS_RAWIO НЕ даёт
# доступ к устройствам вроде /dev/snd/seq -> snd_seq_open возвращает EPERM.
# Из-за этого worker падает, HTTP/WS-сервер не стартует, :3000 недоступен.
#
# Решение: PrivateUsers=no  ->  сервис в init userns, устройства доступны.
#
#     sudo bash fix-user-namespace.sh
# Скрипт ипотентен, можно гонять повторно.
# =============================================================================

set -uo pipefail

SERVICE="midirouter.service"
DROPIN="/etc/systemd/system/${SERVICE}.d/10-fix-user-ns.conf"
SUDO=""   # скрипт требует root (проверка ниже), поэтому sudo не нужен внутри

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
log() { echo -e "${GRN}[midirouter]${NC} $*"; }
warn() { echo -e "${YEL}[warning]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; }

if [ "$(id -u)" -ne 0 ]; then
    err "Нужен sudo:  sudo bash fix-user-namespace.sh"
    exit 1
fi

# 1) Пишем drop-in (перезаписываем каждый раз -> ипотентно)
log "Пишу override: ${DROPIN} (PrivateUsers=no)"
mkdir -p "$(dirname "$DROPIN")"
cat > "$DROPIN" <<'EOF'
[Service]
# Запуск в init user namespace. Во вложенном userns CAP_SYS_RAWIO не даёт
# доступ к /dev/snd/* -> snd_seq_open -> EPERM, worker падает, :3000 не поднимается.
PrivateUsers=no
EOF

# 2) Перезагрузка systemd + перезапуск сервиса
$SUDO systemctl daemon-reload
log "Перезапускаю ${SERVICE}"
$SUDO systemctl restart "$SERVICE"
sleep 6

# 3) Проверка: дошёл ли worker до готовности (значит /dev/snd/seq доступен)
if $SUDO journalctl -u "$SERVICE" --no-pager 2>/dev/null | grep -q "Worker is ready"; then
    log "✅ Worker дошёл до 'Worker is ready' — /dev/snd/seq доступен"
else
    warn "worker не дошёл до готовности. Последние логи:"
    $SUDO journalctl -u "$SERVICE" -n 25 --no-pager
fi

# 4) Проверка веб-сервера на :3000
if $SUDO curl -fsS http://localhost:3000 >/dev/null 2>&1; then
    log "✅ OK — веб-сервер отвечает на http://localhost:3000"
    echo
    IP=$(hostname -I | awk '{print $1}')
    log "Открой в браузере:  http://${IP}:3000"
else
    warn "curl не ответил на :3000. Последние 40 строк логов:"
    $SUDO journalctl -u "$SERVICE" -n 40 --no-pager
fi
