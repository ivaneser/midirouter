# Connected devices and instrument controls

## Port identity and display names

The worker opens each ALSA/RtMidi port and sends its full name/ID to the server.
Port indices and ALSA addresses can change after reconnection. Hot-plug handling
reopens moved ports; clock-master rebinding compares stable names without the
trailing ALSA address.

The frontend keeps input and output inventories for routing and clock selection.
`connected-devices.js` removes repeated inventory IDs and pairs matching input/output
names (ignoring case and repeated whitespace) into a single device card. The pair
uses its **output ID** for parameter messages. It does not merge two distinct IDs
within the same direction. Same-name instances are paired one-to-one.

Cards shorten repeated ALSA prefixes, for example:

| Raw port name | Display name |
|---|---|
| `NTS-1 digital kit:NTS-1 digital kit _ SOUND 20:0` | `NTS-1 digital kit · SOUND` |
| `Launchkey Mini MK3:Launchkey Mini MK3 DAW 24:1` | `Launchkey Mini MK3 · DAW` |

When cleaned names collide, an address or ID distinguishes them. Separate DAW and
performance ports remain separate cards. Raw names/IDs remain unchanged for routing;
full names and input/output direction are available in the card title.

## Enabled parameter panels

Open **Devices & sync**, then tap the instrument's name.

| Detected instrument | Catalog model | JSON file | Parameters |
|---|---|---|---|
| Craft Synth | `craft-synth` | `modal_craft_synth_v2.json` | 18 |
| NTS-1 digital kit | `korg-nts-1` | `korg_nts1.json` | 29 |
| Arturia MicroFreak | `arturia-microfreak` | `arturia_microfreak.json` | 21 |

Detection is case-insensitive. MicroFreak also accepts spaced/hyphenated names;
MiniFreak is a different instrument and is not matched. Unsupported and input-only
ports show an explanation instead of active parameter controls. Other JSON files
in `device_maps/` are not automatically enabled in this frontend catalog.

Continuous parameters are knobs with numeric readouts and CC labels. Drag vertically,
hold Shift for fine adjustment, or focus a knob and use the native range keyboard
controls (arrows, Home and End). Touch gestures capture the pointer and cancel
cleanly; the rest of the page remains scrollable outside knobs. Selectors and
switches represent discrete parameters. Opening a panel sends no MIDI. UI values
are initialized locally and are not read back from the instrument.

`synth-layout.js` orders groups through sound/oscillators, filter/amplifier,
envelopes (including cycling envelope), effects, modulation, then performance.
Unknown categories are retained after known groups. Parameters keep their JSON
order within each group.

## Control-map schema

```json
{
  "manufacturer": "Example",
  "model": "Example Synth",
  "controls": [
    {"cc": 74, "name": "Cutoff", "type": "slider", "min": 0, "max": 127, "category": "filter"},
    {"cc": 10, "name": "Pan", "type": "slider", "min": -64, "max": 63, "center": 0, "category": "amp"},
    {"cc": 64, "name": "Hold", "type": "toggle", "category": "keyboard"}
  ]
}
```

- `slider`: rendered as a rotary knob. `default` overrides `center`; a signed
  range spanning zero otherwise starts at zero, and a unipolar range starts at its minimum.
- `dropdown`: renders `options`; the selected index plus `min` is sent as the CC value.
  Use this only when the instrument's documented CC encoding matches those indices.
- `toggle`: sends 127 when enabled and 0 when disabled.
- `category`: selects a labeled group. Missing categories appear as Parameters.
- `unit`, `primary` and other map metadata do not imply unit conversion or MIDI readback.

Signed ranges are display values. For the -64..63 map, CC encoding adds 64:
left = 0, displayed neutral zero = 64, right = 127. The bipolar pointer is exactly
centered at zero despite the asymmetric endpoints. Numeric MIDI bytes are clamped
to 0..127. The existing panel sender uses MIDI channel 1; configure the receiving
instrument accordingly. NRPN and SysEx parameters are not supported by this CC panel.

To enable another instrument, add/verify a map, register its file and detection
in `synth-catalog.js`, and test classification, map loading and output-target CCs.
There is no automatic remote schema download in this path. Controller pad/LED
profiles are separate; see [CONTROLLERS.md](CONTROLLERS.md).

## MicroFreak mapping

The 21 controls follow Arturia's [MicroFreak manual, Appendix D](https://downloads.arturia.net/products/microfreak/manual/microfreak_Manual_5_0_1_EN.pdf#page=146).
They cover oscillator type/wave/timbre/shape, filter, envelope, cycling envelope,
LFO, glide, Spice, arp/sequence rates and keyboard hold. Spice is continuous;
LFO CC 93 and 94 are free and synced rates. Oscillator Type uses a raw 0..127 knob,
so the panel does not guess firmware-dependent named engine selections.

Regression tests cover model detection, group order, no MIDI during rendering,
output selection, bipolar encoding and MicroFreak cutoff/hold messages.
