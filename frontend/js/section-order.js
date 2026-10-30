// Lets the page sections be reordered by dragging their grip; the order is kept by the router.
const SECTIONS = {
    'daw-details': 'session', 'piano-roll-section': 'piano-roll', 'midi-keyboard-section': 'keyboard',
    'clock-details': 'clock', 'devices-details': 'devices', 'audio-details': 'audio', 'config-details': 'config',
    'help-details': 'help', 'debug-panel': 'logs',
};

export function sectionKey(el) {
    for (const [cls, key] of Object.entries(SECTIONS)) {
        if (el.id === cls || el.classList.contains(cls)) return key;
    }
    return null;
}

/** Order `keys` (the page's own order) by a saved order. A section the saved order does not know yet, such as a
 *  newly added one, goes right after the section that precedes it in the page, so it appears where it was
 *  placed rather than at the end; without such a neighbour it goes last. Saved keys that are gone are dropped. */
export function applyOrder(keys, saved) {
    const result = (saved || []).filter(key => keys.includes(key));
    const known = new Set(result);
    keys.forEach((key, index) => {
        if (known.has(key)) return;
        let at = result.length;
        for (let i = index - 1; i >= 0; i--) {
            const found = result.indexOf(keys[i]);
            if (found >= 0) { at = found + 1; break; }
        }
        result.splice(at, 0, key);
    });
    return result;
}

export class SectionOrder {
    constructor(container, onChange) {
        this.container = container;
        this.onChange = onChange;
        this.sections = [...container.children].filter(el => sectionKey(el));
        for (const el of this.sections) this._addGrip(el);
    }

    keys() { return [...this.container.children].map(sectionKey).filter(Boolean); }

    apply(saved) {
        const byKey = new Map(this.sections.map(el => [sectionKey(el), el]));
        const anchor = this.sections.length ? this.sections[this.sections.length - 1].nextSibling : null;
        for (const key of applyOrder([...byKey.keys()], saved)) this.container.insertBefore(byKey.get(key), anchor);
    }

    _addGrip(el) {
        const summary = el.querySelector(':scope > summary');
        if (!summary) return;
        const grip = document.createElement('span');
        grip.className = 'section-grip';
        grip.textContent = '⠿';
        grip.title = 'Drag to move this section';
        grip.setAttribute('role', 'button');
        grip.setAttribute('aria-label', 'Drag to move this section');
        summary.insertBefore(grip, summary.firstChild);
        // Opening/closing must not trigger from the grip.
        grip.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); });
        grip.addEventListener('pointerdown', event => this._start(event, el, grip));
    }

    _start(event, el, grip) {
        if (event.button !== 0) return;
        event.preventDefault();
        grip.setPointerCapture(event.pointerId);
        el.classList.add('section-dragging');
        const move = e => {
            for (const other of this.sections) {
                if (other === el) continue;
                const box = other.getBoundingClientRect();
                if (e.clientY < box.top || e.clientY > box.bottom) continue;
                const after = e.clientY > box.top + box.height / 2;
                const ref = after ? other.nextSibling : other;
                if (ref !== el && el.nextSibling !== ref) this.container.insertBefore(el, ref);
                break;
            }
        };
        const end = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', end);
            grip.removeEventListener('pointercancel', end);
            el.classList.remove('section-dragging');
            this.onChange(this.keys());
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    }
}
