/** Render valid and unfinished expressions without KaTeX's CSP-blocked error style attribute. */
export function renderFormulaMarkup(runtime, expression, target, options = {}) {
    const latex = String(expression);
    try {
        runtime.render(latex, target, {
            ...options, throwOnError: true, strict: 'ignore', trust: false,
            maxExpand: 1000, maxSize: 20
        });
        return true;
    } catch (error) {
        const fallback = target.ownerDocument.createElement('span');
        fallback.className = 'katex-error';
        fallback.textContent = latex;
        fallback.title = error?.message || '表达式尚未完成';
        fallback.style.color = '#cc0000';
        target.replaceChildren(fallback);
        return false;
    }
}
