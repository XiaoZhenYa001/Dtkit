const languages = ['html', 'css', 'js'];
const devices = { tablet: [768, 1024], mobile: [390, 844] };
const clampSplit = value => Math.max(25, Math.min(70, Number(value) || 45));

// Presentation only: code execution and the tool lifecycle remain in index.js.
export function createWorkspace({ signal, onEdit }) {
    const root = document.querySelector('.html-preview-view');
    const main = root.querySelector('.html-preview-main');
    const divider = root.querySelector('#previewDivider');
    const stage = root.querySelector('.html-preview-frame-wrapper');
    const viewport = root.querySelector('#previewViewport');
    const frame = root.querySelector('#previewFrame');
    const lineCounts = new Map();
    const scrolls = new Map(languages.map(type => [type, { scrollTop: 0, scrollLeft: 0 }]));
    let activeTab = 'html', mode = 'responsive', split = 45;

    const editor = type => root.querySelector(`#${type}Editor`);
    function updatePosition() {
        const field = editor(activeTab), before = field.value.slice(0, field.selectionStart);
        const row = before.split('\n').length, column = before.length - before.lastIndexOf('\n');
        root.querySelector('#editorPosition').textContent = `行 ${row}，列 ${column}`;
        root.querySelector('#editorLineCount').textContent = `${lineCounts.get(activeTab) || 1} 行`;
    }
    function updateGutter(type) {
        const field = editor(type), gutter = field.previousElementSibling.firstElementChild;
        const lineHeight = parseFloat(getComputedStyle(field).lineHeight);
        const first = Math.floor(field.scrollTop / lineHeight);
        const count = Math.min(lineCounts.get(type) || 1, first + Math.ceil(field.clientHeight / lineHeight) + 1);
        gutter.textContent = Array.from({ length: Math.max(0, count - first) }, (_, i) => first + i + 1).join('\n');
        gutter.style.transform = `translateY(${-field.scrollTop % lineHeight}px)`;
    }
    function updateEditors() {
        for (const type of languages) {
            const field = editor(type);
            lineCounts.set(type, field.value.split('\n').length);
            root.querySelector(`#${type}Tab`).classList.toggle('has-code', field.value.trim().length > 0);
            if (type === activeTab) updateGutter(type);
        }
        updatePosition();
    }
    function setTab(type, focus = false) {
        if (!languages.includes(type)) return;
        scrolls.set(activeTab, { scrollTop: editor(activeTab).scrollTop, scrollLeft: editor(activeTab).scrollLeft });
        activeTab = type;
        for (const key of languages) {
            const selected = key === type, tab = root.querySelector(`#${key}Tab`);
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            editor(key).classList.toggle('active', selected);
            root.querySelector(`#${key}EditorPane`).hidden = !selected;
        }
        Object.assign(editor(type), scrolls.get(type));
        updateGutter(type); updatePosition();
        if (focus) editor(type).focus({ preventScroll: true });
    }
    root.querySelectorAll('[role="tab"]').forEach(tab => {
        tab.addEventListener('click', () => setTab(tab.dataset.tab, true), { signal });
        tab.addEventListener('keydown', event => {
            const index = languages.indexOf(tab.dataset.tab);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2
                : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : -1;
            if (next < 0) return;
            event.preventDefault(); setTab(languages[next]); root.querySelector(`#${languages[next]}Tab`).focus();
        }, { signal });
    });
    for (const type of languages) {
        const field = editor(type);
        field.addEventListener('input', () => { updateEditors(); onEdit(); }, { signal });
        field.addEventListener('scroll', () => {
            // display:none panes have no scroll box; keep their last visible pose.
            if (type !== activeTab) return;
            scrolls.set(type, { scrollTop: field.scrollTop, scrollLeft: field.scrollLeft });
            updateGutter(type);
        }, { signal, passive: true });
        for (const name of ['click', 'keyup', 'select']) field.addEventListener(name, updatePosition, { signal });
        field.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Escape' && !root.querySelector('.fullscreen')) {
                event.preventDefault(); root.querySelector(`#${activeTab}Tab`).focus();
            }
            if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            event.preventDefault();
            // insertText preserves the textarea's native undo history in WebView2.
            if (!document.execCommand('insertText', false, '    ')) {
                field.setRangeText('    ', field.selectionStart, field.selectionEnd, 'end');
                field.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, { signal });
    }

    function setSplit(value) {
        split = clampSplit(value);
        main.style.setProperty('--editor-share', `${split}%`);
        divider.setAttribute('aria-valuenow', String(Math.round(split)));
    }
    divider.addEventListener('keydown', event => {
        const next = event.key === 'Home' ? 25 : event.key === 'End' ? 70
            : event.key === 'ArrowLeft' ? split - 2 : event.key === 'ArrowRight' ? split + 2 : null;
        if (next === null) return;
        event.preventDefault(); setSplit(next);
    }, { signal });
    divider.addEventListener('dblclick', () => setSplit(45), { signal });
    divider.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); divider.setPointerCapture(event.pointerId); main.classList.add('is-resizing');
    }, { signal });
    divider.addEventListener('pointermove', event => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        const bounds = main.getBoundingClientRect();
        setSplit((event.clientX - bounds.left) / bounds.width * 100);
    }, { signal });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(name, event => {
        if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        main.classList.remove('is-resizing');
    }, { signal });

    function fitViewport() {
        const style = getComputedStyle(stage);
        const width = Math.max(1, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
        const height = Math.max(1, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
        const [logicalWidth, logicalHeight] = devices[mode] || [Math.round(width), Math.round(height)];
        const scale = Math.min(1, width / logicalWidth, height / logicalHeight);
        viewport.style.width = `${logicalWidth * scale}px`; viewport.style.height = `${logicalHeight * scale}px`;
        frame.style.width = `${logicalWidth}px`; frame.style.height = `${logicalHeight}px`;
        frame.style.transform = `scale(${scale})`;
        root.querySelector('#viewportSize').textContent = `${logicalWidth} × ${logicalHeight}`;
        root.querySelector('#viewportScale').textContent = scale < .995 ? ` · ${Math.round(scale * 100)}%` : '';
        updateGutter(activeTab);
    }
    function setViewport(value) {
        mode = Object.hasOwn(devices, value) ? value : 'responsive';
        stage.dataset.viewport = mode;
        root.querySelectorAll('[data-viewport]').forEach(button => {
            if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.viewport === mode));
        });
        fitViewport();
    }
    root.querySelectorAll('button[data-viewport]').forEach(button => button.addEventListener('click', () => setViewport(button.dataset.viewport), { signal }));
    const observer = new ResizeObserver(fitViewport);
    observer.observe(stage); observer.observe(root.querySelector('.html-preview-editors'));
    signal.addEventListener('abort', () => { observer.disconnect(); main.classList.remove('is-resizing'); }, { once: true });
    updateEditors(); setSplit(45); setViewport('responsive');
    return { setTab, updateEditors, fitViewport,
        scrollPosition: type => type === activeTab
            ? { scrollTop: editor(type).scrollTop, scrollLeft: editor(type).scrollLeft } : scrolls.get(type),
        restoreScroll(type, saved) {
            const position = { scrollTop: Math.max(0, Number(saved.scrollTop) || 0), scrollLeft: Math.max(0, Number(saved.scrollLeft) || 0) };
            scrolls.set(type, position);
            if (type === activeTab) Object.assign(editor(type), position);
        },
        snapshot: () => ({ viewport: mode, splitRatio: split }),
        restore: snapshot => { setSplit(snapshot.splitRatio); setViewport(snapshot.viewport); }
    };
}
