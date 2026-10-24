// Arranges a device's controls by how the sound is made (sound source -> filters -> amp ->
// envelopes -> modulation) from the `ui` block of its device map. Pure data in, data out.

const norm = text => String(text ?? '').toLowerCase();
const startsWithAny = (name, prefixes) => prefixes.some(prefix => norm(name).startsWith(norm(prefix)));

/**
 * @returns {Array<{title, hint, modules: Array<{title, groups: Array<{label, controls}>}>}>}
 * Modules without controls are dropped; controls a module's groups do not name go in a final
 * unlabelled group, so nothing in the map is ever hidden.
 */
export function buildStages(controls, ui) {
    return (ui?.stages || []).map(stage => ({
        title: stage.title,
        hint: stage.hint,
        modules: (stage.modules || []).map(module => {
            let pool;
            if (module.pick) {
                pool = module.pick.map(item => {
                    const found = controls.find(c => c.section === item.section && norm(c.name).startsWith(norm(item.name)));
                    return found && { ...found, name: item.label ?? found.name };
                }).filter(Boolean);
            } else {
                const categories = module.categories || (module.category ? [module.category] : null);
                pool = controls.filter(c => c.section === module.section
                    && (!categories || categories.includes(c.category))
                    && (!module.match || startsWithAny(c.name, module.match))
                    && !(module.exclude && startsWithAny(c.name, module.exclude)));
            }
            const taken = new Set();
            const groups = (module.groups || []).map(group => {
                const own = pool.filter(c => !taken.has(c) && startsWithAny(c.name, group.match));
                own.forEach(c => taken.add(c));
                return { label: group.label, controls: own };
            });
            const rest = pool.filter(c => !taken.has(c));
            if (rest.length) groups.push({ label: groups.length ? 'More' : null, controls: rest });
            return { title: module.title, groups: groups.filter(g => g.controls.length) };
        }).filter(module => module.groups.length),
    })).filter(stage => stage.modules.length);
}
