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
| `send_cc` | Raw Control Change outside the control map (part volume 7, pan 10) |
| `send_sysex` | Raw System Exclusive (data bytes; F0/F7 added), e.g. Blofeld effect types |
| `list_presets` / `select_preset` | Preset catalog (`device_maps/presets/`), Bank Select + Program Change, name via SysEx readback |
| `set_device_channel` | Same per-device channel as the UI selector |
| `play_notes` | Timed notes; captured by an armed DAW recording |
| `daw_*` | State, tempo, record mode, transport, pads, sessions (list/save/load/delete) |
| `daw_reset`, `daw_set_layout`, `daw_set_clip`, `daw_clear_clip`, `daw_stop_clip`, `daw_track` | Build a session without recording: reset, size the grid, write clips from note lists, mute/solo/arm |
| `daw_set_loop_bars`, `daw_set_clock`, `daw_set_metronome`, `daw_set_quantize` | Master loop length, clock source (internal/external) and clock output, metronome, quantize grid |
| `set_device_part` | Add, move or remove a part of a multitimbral instrument |

Typical flow to build and play a session: `daw_reset` → `daw_set_layout` → `select_preset` / `set_parameters` per device
→ `daw_set_clip` per track and slot (give `device` so the clip uses its channel) → `daw_set_tempo` → `daw_transport play`
→ `daw_trigger_pad` for each clip → `daw_sessions save`.
| `panic` | All notes off |

Multitimbral instruments appear once per added part in `list_devices`; address a part as `device: "Blofeld part 3"` (it uses that part's channel).

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
