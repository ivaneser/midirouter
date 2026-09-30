#!/usr/bin/env bash
# =============================================================================
#  enable-autostart.sh  —  Enable midirouter on boot
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
REQ_SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  REQ_SUDO="sudo"
  echo "[enable-autostart] Need root privileges — using sudo"
fi

log()  { echo "[enable-autostart] $*"; }

log "Installing systemd services..."
$REQ_SUDO cp -f "${REPO_DIR}/midirouter.service" /etc/systemd/system/midirouter.service
$REQ_SUDO systemctl disable --now metronome.service 2>/dev/null || true
$REQ_SUDO rm -f /etc/systemd/system/metronome.service

# Optionally patch user / working directory to match where this repo lives
REPO_USER="${SUDO_USER:-${USER}}"
$REQ_SUDO sed -i "s|^User=.*|User=${REPO_USER}|" /etc/systemd/system/midirouter.service
$REQ_SUDO sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${REPO_DIR}|" /etc/systemd/system/midirouter.service

$REQ_SUDO systemctl daemon-reload

log "Enabling midirouter.service..."
$REQ_SUDO systemctl enable --now midirouter.service

log "Done. The router service is enabled and started; its worker manages the audio metronome."
log ""
log "Check status:"
log "  sudo systemctl status midirouter.service"
