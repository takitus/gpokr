/* One feature, two hosts. The ui2 host renders slot components with its own
 * React; the Chrome shim has no React and mounts plain DOM. A feature writes a
 * vanilla mount(el, props) -> { update(props), destroy() } once, and
 * asComponent turns it into whatever the host in front of it wants.
 *
 * Under ui2 the component is a thin React wrapper that hands its div to the
 * mount. Under the shim, ctx.react is null and the shim reads __mount off the
 * function it was given. */

export function asComponent(ctx, mount, className) {
    const R = ctx.react;
    function Slot(props) {
        const el = R.useRef(null);
        const inst = R.useRef(null);
        R.useEffect(() => {
            inst.current = mount(el.current, props) || null;
            return () => { if (inst.current && inst.current.destroy) inst.current.destroy(); };
        }, []);
        R.useEffect(() => {
            if (inst.current && inst.current.update) inst.current.update(props);
        });
        return R.createElement("div", { ref: el, className: className || "gpt-slot" });
    }
    Slot.__mount = mount;
    return Slot;
}

/* For the shim, where ctx.react is null: a stand-in that only carries the mount. */
export function asMount(mount) {
    const Slot = () => null;
    Slot.__mount = mount;
    return Slot;
}

export function slot(ctx, mount, className) {
    return ctx.react ? asComponent(ctx, mount, className) : asMount(mount);
}

/* Registers a feature only while its switch is on, and tears it down when the
 * player turns it off. start(ctx) returns a cleanup, like activate. */
export function toggled(ctx, key, start) {
    let stop = null;
    const apply = (on) => {
        if (on && !stop) {
            try { stop = start(ctx) || (() => {}); }
            catch (e) { ctx.log && ctx.log(`${key} did not start`, e); stop = null; }
        } else if (!on && stop) {
            try { stop(); } catch (e) { ctx.log && ctx.log(`${key} did not stop cleanly`, e); }
            stop = null;
        }
    };
    apply(ctx.settings.get(key) !== false);
    const off = ctx.settings.onChange(key, (v) => apply(v !== false));
    return () => { if (off) off(); apply(false); };
}
