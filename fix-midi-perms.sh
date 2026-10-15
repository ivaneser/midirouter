#!/usr/bin/env bash
# =============================================================================
# fix-midi-perms.sh — fix ALSA access (/dev/snd) for midirouter.service
# -----------------------------------------------------------------------------
# Problem: the worker crashes with "open /dev/snd/seq failed: Operation not permitted",
# so the HTTP/WS server does not start. The script applies the unit and automatically
# picks a working mode: first non-root with CAP_SYS_RAWIO, and if still
# EPERM — it switches to running as root (reliable for a dedicated device).
#
#     sudo bash fix-midi-perms.sh
# The script is idempotent, it can be re-run safely.
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
    err "Requires sudo:  sudo bash fix-midi-perms.sh"
    exit 1
fi
SUDO=""

write_unit() {
    # $1 = User= value ("" -> user ${USER_NAME}, "root" -> root)
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

log "Applying the unit for user '${USER_NAME}', repo: ${REPO_DIR}"

# 1) Try non-root with CAP_SYS_RAWIO
write_unit "${USER_NAME}"
sleep 6
if $SUDO systemctl is-active --quiet midirouter && grep -q "Worker is ready" <($SUDO journalctl -u midirouter.service --since "+7s ago" --no-pager 2>/dev/null); then
    log "non-root with CAP_SYS_RAWIO works"
else
    warn "non-root did not start — switching to running as root (reliable for /dev/snd)"
    write_unit "root"
fi

# 2) Check the result
if grep -q "Worker is ready" <($SUDO journalctl -u midirouter.service --since "+8s ago" --no-pager 2>/dev/null); then
    log "✅ Worker reached 'Worker is ready'"
else
    warn "worker did not reach readiness — see the logs:"
fi

echo
if $SUDO systemctl is-active --quiet midirouter && curl -fsS http://localhost:3000 >/dev/null 2>&1; then
    log "✅ OK — the web server responds at http://localhost:3000"
else
    warn "curl got no response. Last 40 lines of the logs:"
    $SUDO journalctl -u midirouter.service -n 40 --no-pager
fi
