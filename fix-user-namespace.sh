#!/usr/bin/env bash
# =============================================================================
# fix-user-namespace.sh — fix EPERM on open("/dev/snd/seq") in midirouter.service
# -----------------------------------------------------------------------------
# Cause: systemd sets PrivateUsers=yes by default, so the service starts in a
# nested user namespace. Inside a not-initial userns, CAP_SYS_RAWIO does NOT grant
# access to devices such as /dev/snd/seq -> snd_seq_open returns EPERM.
# Because of this the worker crashes, the HTTP/WS server does not start, and :3000 is unavailable.
#
# Fix: PrivateUsers=no  ->  the service runs in the init userns, devices are accessible.
#
#     sudo bash fix-user-namespace.sh
# The script is idempotent, it can be re-run safely.
# =============================================================================

set -uo pipefail

SERVICE="midirouter.service"
DROPIN="/etc/systemd/system/${SERVICE}.d/10-fix-user-ns.conf"
SUDO=""   # the script requires root (checked below), so sudo is not needed inside

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
log() { echo -e "${GRN}[midirouter]${NC} $*"; }
warn() { echo -e "${YEL}[warning]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*"; }

if [ "$(id -u)" -ne 0 ]; then
    err "Requires sudo:  sudo bash fix-user-namespace.sh"
    exit 1
fi

# 1) Write the drop-in (overwritten every time -> idempotent)
log "Writing override: ${DROPIN} (PrivateUsers=no)"
mkdir -p "$(dirname "$DROPIN")"
cat > "$DROPIN" <<'EOF'
[Service]
# Run in the init user namespace. In a nested userns CAP_SYS_RAWIO does not grant
# access to /dev/snd/* -> snd_seq_open -> EPERM, the worker crashes, :3000 does not come up.
PrivateUsers=no
EOF

# 2) Reload systemd + restart the service
$SUDO systemctl daemon-reload
log "Restarting ${SERVICE}"
$SUDO systemctl restart "$SERVICE"
sleep 6

# 3) Check whether the worker reached readiness (meaning /dev/snd/seq is accessible)
if $SUDO journalctl -u "$SERVICE" --no-pager 2>/dev/null | grep -q "Worker is ready"; then
    log "✅ Worker reached 'Worker is ready' — /dev/snd/seq is accessible"
else
    warn "worker did not reach readiness. Latest logs:"
    $SUDO journalctl -u "$SERVICE" -n 25 --no-pager
fi

# 4) Check the web server on :3000
if $SUDO curl -fsS http://localhost:3000 >/dev/null 2>&1; then
    log "✅ OK — the web server responds at http://localhost:3000"
    echo
    IP=$(hostname -I | awk '{print $1}')
    log "Open in a browser:  http://${IP}:3000"
else
    warn "curl got no response on :3000. Last 40 lines of the logs:"
    $SUDO journalctl -u "$SERVICE" -n 40 --no-pager
fi
