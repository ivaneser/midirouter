# Controller profiles

Add a `.json` file to `controller_profiles/` to control clips from another MIDI device. Profiles are loaded at startup and when the WebSocket command `{"type":"reload-config"}` is sent. The worker logs the actual port names as `Input opened` and `Output opened`; use those names to choose matchers.

`controller_profiles/examples/nanopad2.json` is a starting point: check its note numbers and channel against the controller's current scene, then copy it into `controller_profiles/` to enable it. Files in `examples/` are not loaded.

`input` selects the port that sends pad and transport messages. `feedback.output` selects the port that accepts LED messages. A matcher is either `{ "exact": "full port name" }` or `{ "containsAll": ["word", "another word"] }`; matching ignores case. `excludeOutputs` keeps controller outputs out of synth playback routing. Set `midiClockOutput` to a matcher if the controller must receive generated MIDI Start/Stop/Clock messages; these messages are sent there even when the output is excluded from synth routing. Each profile must have a unique `id` and should match one controller input port.

Any MIDI input that sends Timing Clock (`0xF8`) can act as the external master. Start (`0xFA`), Continue (`0xFB`), and Stop (`0xFC`) are followed when sent; clock-only sources start on the first tick. All synth outputs receive the external clock and transport. Clock generation inside the router is paused until the input clock stops for 750 ms. To use a Launchkey as the master, enable its MIDI Clock Output setting; the router cannot make the controller itself originate clock just by receiving MIDI from it.

Example for a controller with two Note pads and a CC Play button:

```json
{
  "id": "my-controller",
  "input": { "containsAll": ["My Controller", "Control"] },
  "passthrough": "cc",
  "excludeOutputs": [{ "containsAll": ["My Controller"] }],
  "midiClockOutput": { "containsAll": ["My Controller", "Control"] },
  "pads": [
    { "message": "note", "channel": 1, "numbers": [36, 37], "trackStart": 0, "slot": 0 }
  ],
  "transport": [
    { "message": "cc", "channel": 1, "number": 80, "action": "play" }
  ],
  "feedback": {
    "output": { "containsAll": ["My Controller", "Control"] },
    "init": [[176, 1, 127]],
    "states": {
      "playing": [144, "$number", 37],
      "recording": [144, "$number", 5],
      "off": [128, "$number", 0]
    }
  }
}
```

`pads` groups map `numbers` consecutively to tracks starting at `trackStart`, all in the given `slot` (zero based). The engine accepts Note On/Off (including Note On with velocity zero), CC, Program Change, and SysEx input. Note and CC use positive values for press and zero for release; Program Change fires once per message. `transport` supports `play`, `stop`, `record` (cycle None → Replace → Overdub), and `loop`. Set `"message": "cc"` or `"message": "program"` for pads that use those messages. A profile can omit `feedback` when the controller has no remotely controlled LEDs.

Clip pads toggle on each press; their release messages are ignored. Press the same pad again to stop recording or playback.

For a SysEx input pad group, use `"message": "sysex"`, `"prefix": [240, ...]`, `"numberByte": n`, and `"valueByte": n`. The number byte selects a pad from `numbers`; a positive value byte means pressed. Both byte offsets are zero based and must follow the prefix. Feedback state arrays may contain literal MIDI bytes and `$number`, `$index`, `$track`, or `$slot`. `$number` is the pad's input number unless `ledNumbers` supplies alternate LED numbers. `indexStart` can set the first `$index` for a group. This supports Note, CC, and SysEx feedback formats without code changes. For Launchkey MK3 pads, channel 1 sets a stationary color and channel 2 sets a clock-synced flashing color.

`passthrough` controls unmatched input messages: `none` consumes them, `cc` routes unmatched CCs to synths, and `all` routes everything. Matched pads and transport controls are always consumed. Inputs with no matching profile remain on the ordinary MIDI route. The existing auto-learn fallback still applies to unmatched ports containing “pad” in their name; a JSON profile gives precise per-device mappings and avoids collisions when controllers reuse note numbers.

Use `npm test` to check profile parsing and matching. Test the LED byte sequences against the device manual before adding a new profile; different controllers use different MIDI ports and LED protocols.
