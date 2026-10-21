#!/usr/bin/env bash
# Run as root; grants only the exact command used by the web shutdown button.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "[shutdown-setup] Run this script as root." >&2
    exit 1
fi

SERVICE_USER="${1:-}"
if [[ ! "$SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ ]] || ! getent passwd "$SERVICE_USER" >/dev/null; then
    echo "[shutdown-setup] Expected an existing service username." >&2
    exit 1
fi

if ! command -v visudo >/dev/null || ! command -v sudo >/dev/null; then
    echo "[shutdown-setup] Install the sudo package (sudo and visudo) first." >&2
    exit 1
fi
if [ ! -x /sbin/shutdown ]; then
    echo "[shutdown-setup] /sbin/shutdown is missing; cannot configure web power-off." >&2
    exit 1
fi

RULE_FILE=$(mktemp)
trap 'rm -f -- "$RULE_FILE"' EXIT
printf '%s ALL=(root) NOPASSWD: /sbin/shutdown -h now\n' "$SERVICE_USER" > "$RULE_FILE"
visudo -cf "$RULE_FILE"
install -d -o root -g root -m 0755 /etc/sudoers.d
install -o root -g root -m 0440 "$RULE_FILE" /etc/sudoers.d/midirouter-shutdown
echo "[shutdown-setup] Web power-off permission installed for ${SERVICE_USER}."
