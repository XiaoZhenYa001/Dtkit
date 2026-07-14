const RENDER_MESSAGE = 'dtkit-preview-render';
let activeScriptUrl = null;
let activeStyleUrl = null;
let activeStyleLink = null;
let renderVersion = 0;

function revokeActiveScript() {
    if (!activeScriptUrl) return;
    URL.revokeObjectURL(activeScriptUrl);
    activeScriptUrl = null;
}

function revokeActiveStyle() {
    activeStyleLink?.remove();
    activeStyleLink = null;
    if (!activeStyleUrl) return;
    URL.revokeObjectURL(activeStyleUrl);
    activeStyleUrl = null;
}

function extractExecutableCode(root) {
    const scripts = [...root.querySelectorAll('script')];
    const inlineCode = [];

    scripts.forEach(script => {
        if (script.src) {
            console.warn('[HTMLPreview] 已阻止预览 HTML 中的外部脚本:', script.src);
        } else {
            inlineCode.push(script.textContent || '');
        }
        script.remove();
    });

    return inlineCode;
}

function extractRawStyleMarkup(html) {
    const styleCode = [];
    let inlineStyleIndex = 0;

    const withoutStyleBlocks = html.replace(
        /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
        (_match, css) => {
            styleCode.push(css || '');
            return '';
        }
    );

    const sanitizedHtml = withoutStyleBlocks.replace(
        /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
        (_match, doubleQuoted, singleQuoted, unquoted) => {
            const declaration = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
            const marker = inlineStyleIndex++;
            styleCode.push(`[data-dtkit-inline-style="${marker}"] { ${declaration} }`);
            return ` data-dtkit-inline-style="${marker}"`;
        }
    );

    return { sanitizedHtml, styleCode };
}

function extractEmbeddedStyles(root) {
    const styleCode = [];

    root.querySelectorAll('style').forEach(style => {
        styleCode.push(style.textContent || '');
        style.remove();
    });

    root.querySelectorAll('link[rel~="stylesheet"]').forEach(link => {
        console.warn('[HTMLPreview] 已阻止预览 HTML 中的外部样式表:', link.href);
        link.remove();
    });

    root.querySelectorAll('[style]').forEach((element, index) => {
        const declaration = element.getAttribute('style') || '';
        element.removeAttribute('style');
        element.dataset.dtkitInlineStyle = String(index);
        styleCode.push(`[data-dtkit-inline-style="${index}"] { ${declaration} }`);
    });

    return styleCode;
}

function executeUserCode(executableCode, version) {
    if (!executableCode || version !== renderVersion) return;

    const source = `${executableCode}\n//# sourceURL=dtkit-html-preview-user-code.js`;
    activeScriptUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const script = document.createElement('script');
    script.src = activeScriptUrl;
    script.addEventListener('error', () => {
        console.error('[HTMLPreview] 用户 JavaScript 执行失败');
    }, { once: true });
    document.body.appendChild(script);
}

function renderPreview({ html = '', css = '', js = '' } = {}) {
    const version = ++renderVersion;
    revokeActiveScript();
    revokeActiveStyle();

    const extractedMarkup = extractRawStyleMarkup(String(html));
    const parsedDocument = new DOMParser().parseFromString(
        extractedMarkup.sanitizedHtml,
        'text/html'
    );
    const embeddedCode = extractExecutableCode(parsedDocument);
    const embeddedStyles = [
        ...extractedMarkup.styleCode,
        ...extractEmbeddedStyles(parsedDocument)
    ];

    const sanitizedNodes = [...parsedDocument.body.childNodes]
        .map(node => document.importNode(node, true));
    document.body.replaceChildren(...sanitizedNodes);

    const executableCode = [...embeddedCode, String(js)].filter(Boolean).join('\n');
    const styleSource = [
        '* { box-sizing: border-box; }',
        ...embeddedStyles,
        String(css)
    ].filter(Boolean).join('\n');

    activeStyleUrl = URL.createObjectURL(new Blob([styleSource], { type: 'text/css' }));
    activeStyleLink = document.createElement('link');
    activeStyleLink.rel = 'stylesheet';
    activeStyleLink.href = activeStyleUrl;
    activeStyleLink.addEventListener('load', () => {
        executeUserCode(executableCode, version);
    }, { once: true });
    activeStyleLink.addEventListener('error', () => {
        console.error('[HTMLPreview] 用户 CSS 加载失败');
    }, { once: true });
    document.head.appendChild(activeStyleLink);
}

window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== RENDER_MESSAGE) return;
    renderPreview(event.data.payload);
});

window.addEventListener('beforeunload', () => {
    revokeActiveScript();
    revokeActiveStyle();
});
