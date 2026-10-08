import { createToolPageScheduler } from './toolPageScheduler.js';

const SAFE_FORM_TOOLS = new Set(['timestamp-converter', 'json-formatter', 'base64-codec', 'url-encoder',
    'crontab-explainer', 'unit-converter', 'qr-generator', 'color-picker']);
const EDITABLE_TYPES = new Set(['text', 'search', 'number', 'range', 'color', 'url', 'email', 'tel', 'checkbox', 'radio']);
const RICH_SESSION_TOOLS = new Set(['screenshot-annotator', 'hash-tool', 'file-batch']);

function captureForms() {
    return [...document.querySelectorAll('input[id], textarea[id], select[id]')]
        .filter(node => node.tagName !== 'INPUT' || EDITABLE_TYPES.has(node.type))
        .map(node => ({ id: node.id, value: node.value, checked: node.checked,
            selectionStart: node.selectionStart, selectionEnd: node.selectionEnd,
            scrollTop: node.scrollTop, scrollLeft: node.scrollLeft }));
}

function restoreForms(forms) {
    if (!Array.isArray(forms)) return;
    for (const field of forms.slice(0, 128)) {
        if (!field || typeof field.id !== 'string' || typeof field.value !== 'string') continue;
        const node = document.getElementById(field.id);
        if (!node || !['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) continue;
        if (node.tagName === 'INPUT' && !EDITABLE_TYPES.has(node.type)) continue;
        node.value = field.value;
        if (typeof field.checked === 'boolean') node.checked = field.checked;
        node.dispatchEvent(new Event(node.tagName === 'SELECT' || ['checkbox', 'radio'].includes(node.type) ? 'change' : 'input', { bubbles: true }));
        if (Number.isInteger(field.selectionStart) && typeof node.setSelectionRange === 'function') {
            try { node.setSelectionRange(field.selectionStart, field.selectionEnd); } catch { /* non-text control */ }
        }
        node.scrollTop = Number(field.scrollTop) || 0; node.scrollLeft = Number(field.scrollLeft) || 0;
    }
}

export function installToolPageRuntime({ instanceId, toolId = null, embedded = false }) {
    window.__DTKIT_TOOL_PAGE_CONTEXT = Object.freeze({ instanceId, toolId, embedded });
    const nativeTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const backgroundTimers = new Set();
    window.__DTKIT_BACKGROUND_TIMERS__ = Object.freeze({
        setTimeout(callback, delay) {
            if (disposed) return null;
            const handle = nativeTimeout(() => { backgroundTimers.delete(handle); callback(); }, delay);
            backgroundTimers.add(handle); return handle;
        },
        clearTimeout(handle) { nativeClearTimeout(handle); backgroundTimers.delete(handle); }
    });
    const scheduler = createToolPageScheduler();
    const listeners = new Set();
    let suspended = embedded ? Boolean(window.frameElement?.hidden) : Boolean(document.hidden);
    let savedScrollTop = null;
    const scrollContainer = () => embedded ? document.scrollingElement : document.getElementById('quickContent') || document.scrollingElement;
    let disposed = false;
    let dirty = false;
    let activeTool = null;
    let pendingInvocations = 0;
    const invocations = new Set();
    let disposing = null;
    const parentWindow = embedded ? window.parent : window;
    const api = parentWindow.__TAURI__;

    if (api) {
        // The host creates only packaged, same-origin tool documents. User previews
        // have an opaque sandbox origin and never receive this native bridge.
        const events = api.event;
        // Native plugins use non-enumerable exports. Inherit them without copying
        // or writing __TAURI_INTERNALS__, which is read-only in Windows WebViews.
        window.__TAURI__ = Object.defineProperties(Object.create(api), {
            core: { value: { ...api.core, invoke: async (command, args = {}, options) => {
                pendingInvocations += 1;
                const request = Promise.resolve().then(() => api.core.invoke(command, { ...args, instanceId }, options));
                invocations.add(request);
                try { return await request; }
                finally { pendingInvocations -= 1; invocations.delete(request); }
            } } },
            event: { value: events ? { ...events, listen: async (name, callback, options) => {
                const record = { unlisten: null, latest: null, stopped: false, released: false };
                listeners.add(record);
                record.release = () => {
                    if (!record.unlisten || record.released) return;
                    record.released = true; record.unlisten();
                };
                const stop = () => { record.stopped = true; record.release(); listeners.delete(record); };
                record.stop = stop;
                let unlisten;
                try { unlisten = await events.listen(name, event => {
                    if (disposed || record.stopped) return;
                    if (event.payload?.instanceId && event.payload.instanceId !== instanceId) return;
                    if (suspended && name !== 'alarm-triggered') record.latest = event;
                    else callback(event);
                }, options); } catch (error) { stop(); throw error; }
                record.unlisten = unlisten;
                record.deliver = () => { if (!disposed && !record.stopped && record.latest) { const event = record.latest; record.latest = null; callback(event); } };
                if (disposed || record.stopped) stop();
                return stop;
            } } : events }
        });
    }
    if (embedded) {
        // Clipboard permission belongs to the visible native window, and fixtures
        // can provide a mock on that same host.
        try { Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => parentWindow.navigator.clipboard }); }
        catch { /* Browser-provided clipboard remains usable. */ }
        window.showToast = (...args) => parentWindow.showToast?.(...args);
        Object.defineProperty(window, '__DTKIT_SHARED_ALARM_AUDIO__', {
            configurable: true, get: () => parentWindow.__DTKIT_SHARED_ALARM_AUDIO__
        });
    }

    function setSuspended(value, force = false) {
        const next = Boolean(value);
        if (disposed || (!force && next === suspended)) return;
        // Hiding an iframe clears Chromium's document scroll offset. Capture it
        // before the host hides the frame, and restore only after it is visible.
        if (next && !suspended) savedScrollTop = scrollContainer()?.scrollTop || 0;
        if (!next && suspended && savedScrollTop !== null) {
            const container = scrollContainer();
            if (container) container.scrollTop = savedScrollTop;
        }
        suspended = next;
        scheduler.setSuspended(next);
        document.documentElement.classList.toggle('app-is-suspended', next);
        document.querySelectorAll('video, audio').forEach(media => { if (next) media.pause(); });
        window.dispatchEvent(new CustomEvent('dtkit:power-state', { detail: { suspended: next } }));
        if (!next) for (const record of listeners) record.deliver?.();
    }
    const markDirty = () => { dirty = true; };
    document.addEventListener('input', markDirty, true);
    document.addEventListener('change', markDirty, true);
    const receive = event => {
        if (!embedded || event.source !== parentWindow || event.data?.instanceId !== instanceId) return;
        if (event.data.type === 'dtkit-tool-page-lifecycle') setSuspended(event.data.suspended);
        if (event.data.type === 'dtkit-tool-page-event' && event.data.name === 'dtkit:alarm-sync-status') {
            window.dispatchEvent(new CustomEvent(event.data.name, { detail: event.data.detail }));
        }
    };
    window.addEventListener('message', receive);
    const runtime = {
        attachTool(tool) {
            if (disposed) { return Promise.resolve(tool.destroy?.()); }
            activeTool = tool; setSuspended(suspended, true);
        },
        async releaseTool() {
            const tool = activeTool; activeTool = null;
            await tool?.destroy?.();
            await Promise.allSettled([...invocations]);
        },
        setSuspended,
        snapshot() {
            return { schema: 1, toolId: activeTool?.id || toolId, instanceId,
                state: activeTool?.serialize?.() ?? null,
                forms: SAFE_FORM_TOOLS.has(activeTool?.id) ? captureForms() : null,
                scrollTop: suspended && savedScrollTop !== null ? savedScrollTop : scrollContainer()?.scrollTop || 0,
                canRelease: pendingInvocations === 0 && !document.querySelector?.('dialog[open]')
                    && !RICH_SESSION_TOOLS.has(activeTool?.id)
                    && (!dirty || Boolean(activeTool?.serialize) || SAFE_FORM_TOOLS.has(activeTool?.id)) };
        },
        async flush() {
            await activeTool?.flush?.();
            await Promise.allSettled([...invocations]);
            return runtime.snapshot();
        },
        async restore(snapshot) {
            if (!snapshot || snapshot.schema !== 1 || snapshot.toolId !== activeTool?.id || snapshot.instanceId !== instanceId) return;
            if (activeTool?.restore && snapshot.state !== null) await activeTool.restore(snapshot.state);
            else if (SAFE_FORM_TOOLS.has(activeTool?.id)) restoreForms(snapshot.forms);
            savedScrollTop = Math.max(0, Number(snapshot.scrollTop) || 0);
            const container = scrollContainer();
            if (container) container.scrollTop = savedScrollTop;
            setSuspended(suspended, true);
        },
        dispose() {
            if (disposing) return disposing;
            disposed = true;
            scheduler.dispose();
            for (const handle of backgroundTimers) nativeClearTimeout(handle);
            backgroundTimers.clear();
            for (const record of [...listeners]) record.stop();
            listeners.clear();
            document.removeEventListener('input', markDirty, true); document.removeEventListener('change', markDirty, true);
            window.removeEventListener('message', receive);
            disposing = (async () => {
                const tool = activeTool; activeTool = null;
                await tool?.destroy?.();
                await Promise.allSettled([...invocations]);
            })();
            return disposing;
        },
        get suspended() { return suspended; },
        get disposed() { return disposed; },
        get ready() { return Boolean(activeTool); }
    };
    window.__DTKIT_TOOL_PAGE__ = runtime;
    scheduler.setSuspended(suspended);
    if (!embedded) document.addEventListener('visibilitychange', () => setSuspended(document.hidden));
    window.addEventListener('pagehide', runtime.dispose, { once: true });
    return runtime;
}
