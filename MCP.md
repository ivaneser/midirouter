# MCP endpoint

midirouter serves one MCP endpoint, `POST /mcp` (Streamable HTTP, JSON responses), on the same
port as the UI (3000). An LLM client connects only here.

```bash
claude mcp add --transport http midirouter http://<pi>:3000/mcp
```

Optional hardening: `MIDIROUTER_MCP_TOKEN=secret` requires `Authorization: Bearer secret`.
Requests with a foreign `Origin` header are rejected.

## Tools owned by midirouter

| Tool | Purpose |
|---|---|
| `list_devices` | Connected outputs: model, channel, current preset, control count |
| `get_device_params` | Control map with CC, range/options, description, value zones, current value |
| `get_device_state` | Values last sent to the device plus its preset (MIDI has no readback) |
| `set_parameter` / `set_parameters` | Set parameters by name or CC; open UI knobs follow |
| `list_presets` / `select_preset` | Preset catalog (`device_maps/presets/`), Bank Select + Program Change, name via SysEx readback |
| `set_device_channel` | Same per-device channel as the UI selector |
| `play_notes` | Timed notes; captured by an armed DAW recording |
| `daw_*` | State, tempo, record mode, transport, pads, sessions |
| `panic` | All notes off |

Values use the UI semantics: sliders take displayed values (signed ranges allowed), dropdowns an
option label or index, toggles true/false. Everything is clamped to the map range.

## Tools forwarded from mcpi

Audio capture and sound analysis (`record_audio`, `analyze_audio`, `profile_patch`,
`render_patch_sample`, ...) run in the Python project `mcpi`, which midirouter calls as an upstream
MCP server (`MCPI_URL`, default `http://127.0.0.1:8000/mcp`, `MCPI_TOKEN` optional,
`MCPI_URL=` to disable). The list is fixed in `mcp-upstream.js`. If mcpi is not running those
tools are simply absent. mcpi sends its MIDI through midirouter (`MCPI_MIDI_VIA=midirouter`, the
default there), so only the router touches the ports.

## Data

* `device_maps/*.json`: controls, now with optional `description` and `zones` (LLM-facing only).
* `device_maps/presets/<map>.json`: `{ "presets": { "<1-based number>": { "name", "tags"? } } }`.
