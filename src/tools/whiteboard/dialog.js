import { prefersReducedMotion } from '../../core/toolMotion.js';
import { renderFormulaMarkup } from './formula.js';

const TYPES = new Set(['text', 'note', 'formula']);
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const EASING = 'cubic-bezier(.22, 1, .36, 1)';

/** Own one view's content editor, including modal focus and interruptible motion. */
export function createObjectDialog({ root, signal, isEditable, ensureFormulaRuntime, onConfirm }) {
    const query = id => root.querySelector('#' + id);
    const dialog = query('whiteboardObjectDialog');
    const panel = dialog?.querySelector('.whiteboard-object-dialog__panel');
    const input = query('whiteboardObjectInput');
    const title = query('whiteboardDialogTitle');
    const symbols = query('whiteboardFormulaSymbols');
    const previewNode = query('whiteboardFormulaPreview');
    const confirmButton = query('whiteboardDialogConfirm');
    if (!dialog || !panel || !input || !title || !symbols || !previewNode || !confirmButton) {
        throw new Error('白板内容编辑器缺少必要节点');
    }

    const doc = root.ownerDocument;
    const win = doc.defaultView;
    const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const inertBefore = new Map();
    let opened = false;
    let disposed = signal?.aborted === true;
    let version = 0;
    let entry = null;
    let returnFocus = null;
    let confirming = false;
    let runtime = null;
    let loading = null;
    let panelMotion = null;
    let backdropMotion = null;
    let phase = null;

    const editable = () => !disposed && !signal?.aborted && isEditable();
    const focus = node => {
        if (!node?.isConnected || node.disabled || node.closest?.('[inert]') || !node.getClientRects?.().length) return false;
        node.focus?.({ preventScroll: true });
        return doc.activeElement === node;
    };
    const restoreInert = () => {
        for (const [node, previous] of inertBefore) node.inert = previous;
        inertBefore.clear();
    };
    const isolate = () => {
        for (const node of root.children) {
            if (node === dialog) continue;
            if (!inertBefore.has(node)) inertBefore.set(node, node.inert);
            node.inert = true;
        }
    };
    const cancelMotion = () => {
        panelMotion?.cancel();
        backdropMotion?.cancel();
        panelMotion = null;
        backdropMotion = null;
        phase = null;
    };
    const finishMotion = () => {
        cancelMotion();
        dialog.hidden = !opened;
        dialog.inert = !opened;
    };
    const transition = show => {
        const previousPhase = phase;
        const style = previousPhase ? win.getComputedStyle(panel) : null;
        const backdropStyle = previousPhase ? win.getComputedStyle(dialog) : null;
        const from = style ? { opacity: style.opacity, transform: style.transform }
            : show ? { opacity: 0, transform: 'translateY(12px) scale(.975)' }
                : { opacity: 1, transform: 'none' };
        const backdropFrom = backdropStyle?.opacity ?? (show ? 0 : 1);
        cancelMotion();
        if (disposed || signal?.aborted || prefersReducedMotion() || media?.matches || !panel.animate) {
            finishMotion();
            return;
        }
        phase = show ? 'opening' : 'closing';
        const motion = panel.animate([from, show ? { opacity: 1, transform: 'translateY(0) scale(1)' }
            : { opacity: 0, transform: 'translateY(8px) scale(.985)' }],
        { duration: show ? 250 : 160, easing: EASING, fill: 'both' });
        const backdrop = dialog.animate([{ opacity: backdropFrom }, { opacity: show ? 1 : 0 }],
            { duration: show ? 220 : 160, easing: EASING, fill: 'both' });
        panelMotion = motion;
        backdropMotion = backdrop;
        motion.finished.then(() => {
            if (panelMotion !== motion) return;
            finishMotion();
        }).catch(() => {});
        backdrop.finished.catch(() => {});
    };

    function close() {
        if (disposed || !opened) return;
        opened = false;
        version++;
        entry = null;
        confirming = false;
        confirmButton.disabled = false;
        input.setCustomValidity('');
        dialog.inert = true;
        restoreInert();
        const previous = returnFocus;
        returnFocus = null;
        if (!focus(previous)) focus(query('whiteboardCanvas'));
        transition(false);
    }

    async function preview() {
        if (!opened || entry?.type !== 'formula' || disposed) return;
        const request = version;
        const current = () => opened && !disposed && !signal?.aborted
            && request === version && entry?.type === 'formula';
        if (!runtime) {
            previewNode.textContent = '正在准备公式预览…';
            loading ||= Promise.resolve().then(() => ensureFormulaRuntime()).then(module => {
                const resolved = module?.default || module;
                if (typeof resolved?.render !== 'function') throw new Error('公式组件不可用');
                runtime = resolved;
                return resolved;
            }).catch(error => { loading = null; throw error; });
            try { await loading; }
            catch {
                if (current()) previewNode.textContent = '公式预览暂不可用，请稍后重试';
                return;
            }
        }
        if (!current()) return;
        try {
            renderFormulaMarkup(runtime, input.value || '\\square', previewNode, { displayMode: true });
        } catch {
            previewNode.textContent = '表达式暂时无法预览';
        }
    }

    async function open(type, point, element = null) {
        if (!editable() || !TYPES.has(type)) return false;
        const previousOpen = opened;
        if (!previousOpen) returnFocus = doc.activeElement;
        version++;
        opened = true;
        confirming = false;
        confirmButton.disabled = false;
        entry = { type, point: { x: Number(point?.x) || 0, y: Number(point?.y) || 0 }, element };
        dialog.dataset.type = type;
        dialog.dataset.x = String(entry.point.x);
        dialog.dataset.y = String(entry.point.y);
        input.value = element ? String(type === 'formula' ? element.latex || '' : element.text || '') : '';
        input.setCustomValidity('');
        symbols.hidden = type !== 'formula';
        previewNode.hidden = type !== 'formula';
        previewNode.replaceChildren();
        const label = type === 'formula' ? '数学表达式' : type === 'note' ? '便签' : '文字';
        title.textContent = (element ? '编辑' : '插入') + label;
        confirmButton.textContent = element ? '保存' : '插入';
        input.placeholder = type === 'formula'
            ? '输入 LaTeX，例如：\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'
            : type === 'note' ? '记下一个想法…' : '输入文字内容…';
        isolate();
        dialog.hidden = false;
        dialog.inert = false;
        if (!previousOpen || phase === 'closing') transition(true);
        focus(input);
        if (type === 'formula') await preview();
        return opened && !disposed;
    }

    async function confirm() {
        if (!opened || !editable() || confirming) return;
        const value = input.value.trim();
        if (!value) { focus(input); return; }
        const request = version;
        const payload = { ...entry, point: { ...entry.point }, value };
        confirming = true;
        confirmButton.disabled = true;
        try {
            const result = await onConfirm(payload);
            if (disposed || !opened || request !== version) return;
            if (result !== false) close();
            else focus(input);
        } catch (error) {
            if (disposed || !opened || request !== version) return;
            input.setCustomValidity(error?.message || '暂时无法保存内容，请重试');
            input.reportValidity();
            focus(input);
        } finally {
            if (!disposed && opened && request === version) {
                confirming = false;
                confirmButton.disabled = false;
            }
        }
    }

    function keydown(event) {
        if (!opened || disposed || event.isComposing) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            close();
        } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopImmediatePropagation();
            confirm();
        } else if (event.key === 'Tab') {
            const controls = [...panel.querySelectorAll(FOCUSABLE)]
                .filter(node => !node.disabled && !node.hidden && !node.closest('[inert]') && node.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            const current = doc.activeElement;
            if (!first || !panel.contains(current) || (event.shiftKey && current === first) || (!event.shiftKey && current === last)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                focus(event.shiftKey ? last || panel : first || panel);
            }
        }
    }

    const options = signal ? { signal } : undefined;
    if (!disposed) {
        query('whiteboardDialogClose')?.addEventListener('click', close, options);
        query('whiteboardDialogCancel')?.addEventListener('click', close, options);
        confirmButton.addEventListener('click', confirm, options);
        input.addEventListener('input', () => { input.setCustomValidity(''); preview(); }, options);
        symbols.addEventListener('click', event => {
            const button = event.target.closest('[data-formula]');
            if (!button || !symbols.contains(button) || !opened || entry?.type !== 'formula') return;
            input.setRangeText(button.dataset.formula, input.selectionStart, input.selectionEnd, 'end');
            focus(input);
            input.dispatchEvent(new win.Event('input', { bubbles: true }));
        }, options);
        doc.addEventListener('keydown', keydown, { ...options, capture: true });
        media?.addEventListener('change', reduce);
        signal?.addEventListener('abort', dispose, { once: true });
    }

    function reduce() { if (media.matches) finishMotion(); }
    function dispose() {
        disposed = true;
        opened = false;
        version++;
        entry = null;
        returnFocus = null;
        cancelMotion();
        restoreInert();
        dialog.hidden = true;
        dialog.inert = false;
        media?.removeEventListener('change', reduce);
    }

    return { open, close, preview, isOpen: () => opened && !disposed };
}
