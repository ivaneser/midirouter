---
name: restart-server
description: Restart the midirouter Node server and its Python metronome. Use after pulling new code, editing server files, or when the server is unresponsive.
license: MIT
metadata:
  service: midirouter.service
  working_dir: /home/pi/myprojects/midirouter
---

# restart-server

Restart the midirouter router service (Node `server.js`) and its child Python metronome (`metronome.py`).

## When to use

- After `git pull` or any edit to `server.js`, `metronome.py`, or related modules.
- When the server is unresponsive or ports appear stuck.
- Whenever a fresh process state is needed without touching systemd unit files.

## How it works

`midirouter.service` (in `/etc/systemd/system/midirouter.service`) runs:

```
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=pi
WorkingDirectory=/home/pi/myprojects/midirouter
```

The Node process (`server.js`) spawns `metronome.py` as a child. systemd's `Restart=always` automatically respawns `node server.js` when it exits, and the fresh Node process restarts the metronome too. **You only need to kill the processes — systemd does the rest.**

## Steps

1. Kill the Node router process (`server.js`) and the Python metronome (`metronome.py`):

   ```bash
   # Stop the running server + metronome (both run as user pi)
   pkill -f "server.js"        # kills node server.js  (systemd respawns it via Restart=always)
   pkill -9 -f "metronome.py"  # ensures orphaned metronome child is gone
   sleep 1
   ```

   > Note: `pkill -f "server.js"` can also match the pkill/bash command line and send SIGTERM to your shell. That is harmless — it only terminates the wrapper; the `node server.js` process is already killed and will be respawned by systemd. If you prefer to avoid matching your own shell, use the explicit port-based kill from step 2 instead.

2. (Optional / safer alternative) Kill by listening port so nothing else is affected. The HTTP/WS server listens on **port 3000** (`PORT` env override supported). Find and kill the node process holding it:

   ```bash
   # Kill whatever node owns port 3000 (lsof), or fall back to pidof
   lsof -ti :3000 | xargs -r kill -TERM
   sleep 1
   pkill -9 -f "metronome.py"
   ```

3. Wait ~4–6 seconds for systemd to respawn, then verify:

   ```bash
   ps -o pid,ppid,user,args -C node -C python3 | grep -E "server.js|metronome.py" | grep -v grep
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
   ```

   Expected: a new `node server.js` PID (different from before) with a child `metronome.py`, and the HTTP endpoint returning `200`.

## Troubleshooting

- **Service not respawning:** check systemd journal (`sudo journalctl -u midirouter.service -n 30 --no-pager`).
- **Port still in use after kill:** the respawn may beat your `sleep`; wait a moment and retry, or `pkill -9 -f "server.js"` again.
- **metronome not restarting:** it is a child of node — killing node respawns it automatically. If an orphan persists, `pkill -9 -f "metronome.py"` clears it; the next node start will relaunch it.
- **Permissions / audio issues:** the service runs with `SupplementaryGroups=audio` and `CAP_SYS_RAWIO`; do not run `node server.js` manually as root — use the steps above so systemd provides the correct capabilities.
