const HTML_ESCAPE_PATTERN = /[&<>"']/g;
const HTML_ENTITIES = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
});

/** Escapes untrusted values for HTML text and quoted attribute contexts. */
export function escapeHtml(value) {
    return String(value ?? '').replace(HTML_ESCAPE_PATTERN, character => HTML_ENTITIES[character]);
}

export const escapeAttribute = escapeHtml;
