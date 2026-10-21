// A native range input supplies keyboard and screen-reader behavior; pointer
// dragging turns the dial without jumping to a value on the initial touch.
export function attachMidiKnob(input, dial, readout, onChange) {
    const min = Number(input.min);
    const max = Number(input.max);
    const refresh = () => {
        const value = Number(input.value);
        const fraction = min < 0 && max > 0
            ? (value < 0 ? 0.5 + value / (-2 * min) : 0.5 + value / (2 * max))
            : max > min ? (value - min) / (max - min) : 0;
        dial.style.setProperty('--knob-fill', `${fraction * 270}deg`);
        dial.style.setProperty('--knob-angle', `${-135 + fraction * 270}deg`);
        readout.textContent = String(value);
        input.setAttribute('aria-valuetext', String(value));
    };
    input.addEventListener('input', () => { refresh(); onChange(Number(input.value)); });
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
