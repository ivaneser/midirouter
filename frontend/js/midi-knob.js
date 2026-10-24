// A native range input supplies keyboard and screen-reader behavior; pointer
// dragging turns the dial without jumping to a value on the initial touch.
// `center` marks a bipolar control (detune, semitone): the arc grows from the middle and the
// readout counts away from it. Double-click returns to `reset` (the centre or the default).
export function attachMidiKnob(input, dial, readout, onChange, { center, reset } = {}) {
    const min = Number(input.min);
    const max = Number(input.max);
    const bipolar = Number.isFinite(center) && center > min && center < max;
    const fractionOf = value => max > min ? (value - min) / (max - min) : 0;
    const refresh = () => {
        const value = Number(input.value);
        const fraction = min < 0 && max > 0 && !bipolar
            ? (value < 0 ? 0.5 + value / (-2 * min) : 0.5 + value / (2 * max))
            : fractionOf(value);
        const from = bipolar ? Math.min(fraction, fractionOf(center)) : 0;
        const to = bipolar ? Math.max(fraction, fractionOf(center)) : fraction;
        dial.style.setProperty('--knob-start', `${from * 270}deg`);
        dial.style.setProperty('--knob-fill', `${to * 270}deg`);
        dial.style.setProperty('--knob-angle', `${-135 + fraction * 270}deg`);
        const text = bipolar ? (value === center ? '0' : `${value > center ? '+' : '−'}${Math.abs(value - center)}`) : String(value);
        readout.textContent = text;
        input.setAttribute('aria-valuetext', text);
    };
    const back = Number.isFinite(reset) ? reset : (bipolar ? center : undefined);
    if (back !== undefined) {
        input.addEventListener('dblclick', () => {
            if (Number(input.value) === back) return;
            input.value = String(back);
            refresh();
            onChange(back);
        });
    }
    input.addEventListener('input', () => { refresh(); onChange(Number(input.value)); });
    input.addEventListener('knob-sync', refresh);   // value set from outside: redraw, send nothing
    let drag = null;
    input.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        input.focus({ preventScroll: true });
        input.setPointerCapture(event.pointerId);
        drag = { id: event.pointerId, y: event.clientY, value: Number(input.value) };
    });
    input.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        const sensitivity = (max - min) / (event.shiftKey ? 1200 : 160);
        const raw = Math.max(min, Math.min(max, drag.value + (drag.y - event.clientY) * sensitivity));
        const value = Math.round(raw);
        // Incremental movement lets Shift change precision without value jumps.
        drag.y = event.clientY;
        drag.value = raw;
        if (value === Number(input.value)) return;
        input.value = String(value);
        refresh();
        onChange(value);
    });
    const endDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        if (input.hasPointerCapture(event.pointerId)) input.releasePointerCapture(event.pointerId);
    };
    input.addEventListener('pointerup', endDrag);
    input.addEventListener('pointercancel', endDrag);
    input.addEventListener('lostpointercapture', () => { drag = null; });
    refresh();
}
