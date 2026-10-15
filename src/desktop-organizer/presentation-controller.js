// A single live view remains interactive. A frozen outgoing composition can fade
// while the latest preference renders, including when an earlier fade is interrupted.
export function createPresentationTransition({ stage, getView, reducedMotion }) {
    const win = stage.ownerDocument.defaultView;
    let ghost = null, incoming = null, outgoing = null, generation = 0;
    function cancel() {
        generation++;
        incoming?.cancel(); outgoing?.cancel();
        incoming = outgoing = null;
        ghost?.remove(); ghost = null;
    }
    function snapshot() {
        const clone = stage.cloneNode(false);
        const originals = [stage], copies = [clone];
        // Do not clone hidden search results or the inactive presentation. They may
        // hold thousands of cached file nodes unrelated to the outgoing picture.
        for (const original of [getView(), ghost].filter(Boolean)) {
            const copy = original.cloneNode(true);
            clone.append(copy);
            originals.push(original, ...original.querySelectorAll('*'));
            copies.push(copy, ...copy.querySelectorAll('*'));
        }
        originals.forEach((original, index) => {
            const copy = copies[index];
            if (!copy) return;
            copy.removeAttribute('id'); copy.removeAttribute('autofocus');
            copy.removeAttribute('aria-live'); copy.removeAttribute('data-presentation-ghost');
            if (original.getAnimations().length || original === ghost) {
                const style = win.getComputedStyle(original);
                for (const property of ['transform', 'opacity', 'clipPath', 'left', 'top', 'width', 'height', 'borderRadius', 'backgroundColor', 'color', 'borderColor', 'boxShadow']) {
                    copy.style[property] = style[property];
                }
            }
        });
        clone.querySelectorAll('[hidden]').forEach(node => node.remove());
        function pruneFadedFrames(node, opacity = 1) {
            const combined = opacity * (node.style.opacity ? Number(node.style.opacity) : 1);
            if (node.classList.contains('presentation-ghost') && combined < .025) { node.remove(); return; }
            [...node.children].forEach(child => pruneFadedFrames(child, combined));
        }
        pruneFadedFrames(clone);
        const style = win.getComputedStyle(stage);
        for (const property of ['--bg', '--surface', '--surface-soft', '--surface-hover', '--text', '--muted', '--faint', '--accent', '--accent-soft', '--border', '--shadow']) {
            clone.style.setProperty(property, style.getPropertyValue(property));
        }
        clone.style.background = style.background;
        clone.classList.add('presentation-ghost');
        clone.setAttribute('data-presentation-ghost', '');
        clone.setAttribute('aria-hidden', 'true');
        clone.inert = true;
        const scrollPositions = originals.map((original, index) => ({
            node: copies[index], top: original.scrollTop, left: original.scrollLeft
        })).filter(item => item.top || item.left);
        return { frame: clone, scrollPositions };
    }
    function run(render) {
        if (reducedMotion() || !stage.animate || !getView()) {
            cancel(); render(); return;
        }
        const { frame, scrollPositions } = snapshot();
        cancel();
        const token = generation;
        render();
        const view = getView();
        if (!view) return;
        ghost = frame;
        stage.append(frame);
        // Detached elements cannot retain scroll offsets until they have layout.
        for (const item of scrollPositions) {
            if (!item.node.isConnected) continue;
            item.node.scrollTop = item.top;
            item.node.scrollLeft = item.left;
        }
        // Applying animation immediately avoids one frame of the final layout.
        incoming = view.animate([
            { opacity: 0, transform: 'translateY(7px)' },
            { opacity: .74, transform: 'translateY(1px)', offset: .58 },
            { opacity: 1, transform: 'translateY(0)' }
        ], { duration: 320, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'both' });
        outgoing = frame.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 180, easing: 'cubic-bezier(.2,.65,.3,1)', fill: 'both'
        });
        outgoing.finished.catch(() => {}).then(() => {
            if (generation !== token) return;
            frame.remove(); ghost = null; outgoing = null;
        });
        incoming.finished.catch(() => {}).then(() => {
            if (generation !== token) return;
            incoming?.cancel(); incoming = null;
        });
    }
    return { run, cancel };
}

// Window drags, file drags and dialogs hold the same native hotzone open.
export function createInteractionGate({ invoke, window }) {
    const reasons = new Set();
    let sent = false, scheduled = false, chain = Promise.resolve();
    function schedule() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            const interacting = reasons.size > 0;
            window.__userInteracting = interacting;
            if (sent === interacting) return;
            sent = interacting;
            chain = chain.catch(() => {}).then(() => invoke('set_user_interacting', { interacting })).catch(() => {});
        });
    }
    function set(reason, active) {
        if (active) reasons.add(reason); else reasons.delete(reason);
        schedule();
    }
    function clear() { reasons.clear(); schedule(); }
    return { set, clear };
}
