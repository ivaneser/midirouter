#!/usr/bin/env bash
# =============================================================================
#  disable-autostart.sh  —  Disable midirouter + metronome on boot
# =============================================================================
set -euo pipefail

REQ_SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  REQ_SUDO="sudo"
  echo "[disable-autostart] Need root privileges — using sudo"
fi

log()  { echo "[disable-autostart] $*"; }

log "Stopping and disabling midirouter.service..."
$REQ_SUDO systemctl disable --now midirouter.service 2>/dev/null || log "  midirouter.service was not enabled, skipped"

log "Stopping and disabling metronome.service..."
$REQ_SUDO systemctl disable --now metronome.service 2>/dev/null || log "  metronome.service was not enabled, skipped"

log "Removing systemd unit files..."
$REQ_SUDO rm -f /etc/systemd/system/midirouter.service /etc/systemd/system/metronome.service

$REQ_SUDO systemctl daemon-reload

log "Done. Services will NOT start on next boot."
log ""
log "To re-enable later, run:"
log "  bash ./enable-autostart.sh"
