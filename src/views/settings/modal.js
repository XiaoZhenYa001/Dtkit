import { prefersReducedSettingsMotion, settingsMotionTiming } from './motion.js';

const FOCUSABLE_SELECTOR = [
    'button:not(:disabled)',
    'input:not(:disabled):not([type="hidden"])',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    'a[href]:not([tabindex="-1"])',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

export function createModalController({ dialog, closeTriggers = [], initialFocus = null, onClose = null }) {
    if (!dialog) return null;

    const abortController = new AbortController();
    const { signal } = abortController;
    let returnFocus = null;
    let opened = false;
    let destroyed = false;
    let generation = 0;
    let animations = [];
    let modality = 'pointer';
    let background = [];
    const panel = dialog.querySelector('.modal-dialog') || dialog;
    const originalPointerEvents = dialog.style.pointerEvents;
    const originalInert = dialog.inert;
    dialog.classList.add('settings-modal-motion');
    dialog.dataset.modalState = 'closed';

    const visible = element => element?.isConnected && [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)
        && !element.closest('[hidden], [inert], [aria-hidden="true"]')
        && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility);
    const focusable = () => [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(element => visible(element) && element.tabIndex >= 0 && !element.matches(':disabled'));
    const focusFirst = () => {
        const preferred = initialFocus?.();
        const target = visible(preferred) && !preferred.matches(':disabled') ? preferred : focusable()[0] || panel;
        if (!target.hasAttribute('tabindex') && target === panel) target.tabIndex = -1;
        target.focus({ preventScroll: true });
    };
    const cancelAnimations = () => { animations.forEach(animation => animation.cancel()); animations = []; };
    const releaseBackground = () => {
        for (const [element, inert] of background) element.inert = inert;
        background = [];
    };
    const lockBackground = () => {
        releaseBackground();
        for (let branch = dialog; branch.parentElement; branch = branch.parentElement) {
            for (const sibling of branch.parentElement.children) {
                if (sibling !== branch && sibling instanceof HTMLElement) {
                    background.push([sibling, sibling.inert]); sibling.inert = true;
                }
            }
            if (branch.parentElement === document.body) break;
        }
    };
    const finishClose = version => {
        if (version !== generation || opened) return;
        dialog.hidden = true; dialog.dataset.modalState = 'closed';
        dialog.style.pointerEvents = originalPointerEvents;
        cancelAnimations();
    };
    const animate = (opening, wasVisible) => {
        const version = ++generation;
        const overlayOpacity = wasVisible ? getComputedStyle(dialog).opacity : '0';
        const panelOpacity = wasVisible ? getComputedStyle(panel).opacity : '0';
        const panelTransform = wasVisible ? getComputedStyle(panel).transform : 'translateY(6px) scale(.97)';
        cancelAnimations();
        const reduced = prefersReducedSettingsMotion();
        const instant = modality === 'keyboard' || destroyed || typeof dialog.animate !== 'function';
        if (instant) { if (!opening) finishClose(version); return; }
        const timing = reduced ? { duration: 100, easing: 'ease' }
            : settingsMotionTiming(dialog, opening ? '--transition-normal' : '--transition-fast');
        animations.push(dialog.animate([{ opacity: overlayOpacity }, { opacity: opening ? 1 : 0 }], { ...timing, fill: 'both' }));
        if (panel !== dialog) animations.push(panel.animate([
            { opacity: panelOpacity, transform: reduced ? 'none' : panelTransform },
            { opacity: opening ? 1 : 0, transform: reduced || opening ? 'none' : 'translateY(6px) scale(.97)' }
        ], { ...timing, fill: 'both' }));
        Promise.all(animations.map(animation => animation.finished)).then(() => {
            if (generation !== version) return;
            if (opening) cancelAnimations();
            else finishClose(version);
        }, () => {});
    };
    const close = (reason = 'cancel') => {
        if (!opened) return;
        opened = false;
        releaseBackground();
        if (visible(returnFocus) && !returnFocus.matches(':disabled')) returnFocus.focus({ preventScroll: true });
        else {
            const heading = returnFocus?.closest('.settings-section')?.querySelector('.settings-section-title');
            if (visible(heading)) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
        }
        if (dialog.contains(document.activeElement)) document.activeElement.blur();
        returnFocus = null;
        dialog.inert = true;
        dialog.setAttribute('aria-hidden', 'true');
        dialog.style.pointerEvents = 'none';
        dialog.dataset.modalState = 'closing';
        animate(false, true);
        // Confirmation is resolved immediately, independently from the decorative exit.
        onClose?.(reason);
    };
    const open = trigger => {
        if (destroyed) return;
        if (opened) { focusFirst(); return; }
        const wasVisible = !dialog.hidden;
        returnFocus = trigger || document.activeElement;
        dialog.hidden = false;
        dialog.classList.remove('is-initially-hidden');
        dialog.inert = false;
        dialog.style.pointerEvents = originalPointerEvents;
        dialog.setAttribute('aria-hidden', 'false');
        dialog.dataset.modalState = 'open';
        opened = true;
        lockBackground();
        animate(true, wasVisible);
        focusFirst();
    };

    document.addEventListener('pointerdown', () => { modality = 'pointer'; }, { signal, capture: true, passive: true });
    document.addEventListener('keydown', () => { modality = 'keyboard'; }, { signal, capture: true });
    document.addEventListener('focusin', event => {
        if (opened && !dialog.contains(event.target)) focusFirst();
    }, { signal });

    closeTriggers.filter(Boolean).forEach(button => {
        button.addEventListener('click', () => close('cancel'), { signal });
    });

    dialog.addEventListener('click', event => {
        if (opened && event.target === dialog) close('backdrop');
    }, { signal });

    dialog.addEventListener('keydown', event => {
        if (!opened) return;
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            close('escape');
            return;
        }
        if (event.key !== 'Tab') return;

        const elements = focusable();
        if (elements.length === 0) { event.preventDefault(); focusFirst(); return; }
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    }, { signal });

    return Object.freeze({
        open,
        close,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            close('destroy');
            abortController.abort();
            generation++; cancelAnimations(); releaseBackground();
            dialog.hidden = true; dialog.inert = originalInert;
            dialog.setAttribute('aria-hidden', 'true');
            dialog.dataset.modalState = 'closed'; dialog.style.pointerEvents = originalPointerEvents;
            dialog.classList.remove('settings-modal-motion');
        }
    });
}

let confirmController = null;
let resolveConfirmation = null;

function ensureConfirmController() {
    if (confirmController) return confirmController;

    const dialog = document.getElementById('desktopOrganizerConfirmDialog');
    const confirmButton = document.getElementById('confirmDesktopOrganizer');
    if (!dialog || !confirmButton) return null;

    confirmController = createModalController({
        dialog,
        closeTriggers: [
            document.getElementById('cancelDesktopOrganizer'),
            document.getElementById('closeDesktopOrganizerDialog')
        ],
        initialFocus: () => confirmButton.classList.contains('modal-btn--danger')
            ? document.getElementById('cancelDesktopOrganizer') : confirmButton,
        onClose(reason) {
            resolveConfirmation?.(reason === 'confirm');
            resolveConfirmation = null;
        }
    });
    confirmButton.addEventListener('click', () => confirmController.close('confirm'));
    return confirmController;
}

export function showConfirmDialog(title, message, options = {}) {
    const controller = ensureConfirmController();
    if (!controller) return Promise.resolve(globalThis.confirm?.(message) ?? false);

    if (resolveConfirmation) controller.close('replaced');
    document.getElementById('desktopOrganizerDialogTitle').textContent = title;
    document.getElementById('desktopOrganizerDialogMessage').textContent = message;
    const confirmButton = document.getElementById('confirmDesktopOrganizer');
    confirmButton.classList.toggle('modal-btn--danger', options.danger === true);
    confirmButton.classList.toggle('modal-btn--primary', options.danger !== true);
    confirmButton.replaceChildren();
    const icon = document.createElement('i');
    icon.className = options.danger ? 'ri-delete-bin-6-line' : 'ri-check-line';
    confirmButton.append(icon, document.createTextNode(` ${options.confirmLabel || '确定'}`));

    return new Promise(resolve => {
        resolveConfirmation = resolve;
        controller.open(document.activeElement);
    });
}
