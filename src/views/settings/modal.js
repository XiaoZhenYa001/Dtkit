const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'a[href]',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

export function createModalController({ dialog, closeTriggers = [], initialFocus = null, onClose = null }) {
    if (!dialog) return null;

    const abortController = new AbortController();
    const { signal } = abortController;
    let returnFocus = null;

    const close = (reason = 'cancel') => {
        if (dialog.hidden) return;
        dialog.hidden = true;
        dialog.setAttribute('aria-hidden', 'true');
        onClose?.(reason);
        if (returnFocus?.isConnected) returnFocus.focus();
        returnFocus = null;
    };

    const open = trigger => {
        returnFocus = trigger || document.activeElement;
        dialog.hidden = false;
        dialog.classList.remove('is-initially-hidden');
        dialog.setAttribute('aria-hidden', 'false');
        const target = initialFocus?.() || dialog.querySelector(FOCUSABLE_SELECTOR);
        target?.focus({ preventScroll: true });
    };

    closeTriggers.filter(Boolean).forEach(button => {
        button.addEventListener('click', () => close('cancel'), { signal });
    });

    dialog.addEventListener('click', event => {
        if (event.target === dialog) close('backdrop');
    }, { signal });

    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close('escape');
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }, { signal });

    return Object.freeze({
        open,
        close,
        destroy() {
            abortController.abort();
            close('destroy');
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
        initialFocus: () => confirmButton,
        onClose(reason) {
            resolveConfirmation?.(reason === 'confirm');
            resolveConfirmation = null;
        }
    });
    confirmButton.addEventListener('click', () => confirmController.close('confirm'));
    return confirmController;
}

export function showConfirmDialog(title, message) {
    const controller = ensureConfirmController();
    if (!controller) return Promise.resolve(globalThis.confirm?.(message) ?? false);

    if (resolveConfirmation) controller.close('replaced');
    document.getElementById('desktopOrganizerDialogTitle').textContent = title;
    document.getElementById('desktopOrganizerDialogMessage').textContent = message;

    return new Promise(resolve => {
        resolveConfirmation = resolve;
        controller.open(document.activeElement);
    });
}
