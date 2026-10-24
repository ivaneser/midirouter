// Lets the page sections be reordered by dragging their grip; the order is kept by the router.
const SECTIONS = {
    'daw-details': 'session', 'piano-roll-section': 'piano-roll', 'midi-keyboard-section': 'keyboard',
    'clock-details': 'clock', 'devices-details': 'devices', 'config-details': 'config',
    'help-details': 'help', 'debug-panel': 'logs',
};

export function sectionKey(el) {
    for (const [cls, key] of Object.entries(SECTIONS)) {
        if (el.id === cls || el.classList.contains(cls)) return key;
    }
    return null;
}

/** Order `keys` by a saved order; unknown/new keys keep their place after the known ones. */
export function applyOrder(keys, saved) {
    const known = (saved || []).filter(key => keys.includes(key));
    return [...known, ...keys.filter(key => !known.includes(key))];
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
