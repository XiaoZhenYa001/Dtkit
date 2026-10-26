// Original vector fallbacks; software keeps its own recognizable artwork.
// The SVGs remain sharp at every display scale and share one optical grid.
let serial = 0;
export function launcherFallbackIcon(file) {
    const id = `space-art-${++serial}`;
    const svg = content => `<svg class="launcher-glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${content}</svg>`;
    if (file.is_folder) return svg(`
        <defs><linearGradient id="${id}" x2="0" y2="1"><stop stop-color="#83dcff"/><stop offset="1" stop-color="#34a4ec"/></linearGradient></defs>
        <path d="M5 17a5 5 0 0 1 5-5h13l6 6h25a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5Z" fill="#2999db"/>
        <path d="M5 23a5 5 0 0 1 5-5h44a5 5 0 0 1 5 5v5H5Z" fill="#c9f0ff"/>
        <rect x="4" y="23" width="56" height="33" rx="5" fill="url(#${id})"/>
        <path d="M10 24h44" stroke="#fff" stroke-opacity=".65" stroke-linecap="round"/>
        <path d="M10 54h44" stroke="#1d80be" stroke-opacity=".4" stroke-linecap="round"/>`);
    if (file.category === 'document') return svg(`
        <defs><linearGradient id="${id}" x2="0" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#dce5ef"/></linearGradient></defs>
        <path d="M16 5h22l12 12v39a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z" fill="url(#${id})"/>
        <path d="M38 5v9a3 3 0 0 0 3 3h9" fill="#b4c4d5"/>
        <path d="M21 27h20M21 33h20M21 39h13" fill="none" stroke="#8fa3ba" stroke-width="2.4" stroke-linecap="round"/>`);
    if (file.category === 'image') return svg(`
        <rect x="7" y="7" width="50" height="50" rx="11" fill="#edf8ff"/>
        <rect x="12" y="12" width="40" height="40" rx="7" fill="#92d3ed"/>
        <circle cx="41" cy="23" r="5" fill="#fff3b5"/>
        <path d="m12 43 12-14 13 14 6-7 9 11v1a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4Z" fill="#52b39c"/>
        <path d="m12 47 12-8 15 13H16a4 4 0 0 1-4-4Z" fill="#2e8d91"/>`);
    const paths = {
        program: '<rect x="18" y="18" width="11" height="11" rx="3"/><rect x="35" y="18" width="11" height="11" rx="3"/><rect x="18" y="35" width="11" height="11" rx="3"/><rect x="35" y="35" width="11" height="11" rx="3"/>',
        audio: '<path d="M28 43V20l18-4v23M28 25l18-4" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><ellipse cx="22" cy="44" rx="8" ry="6"/><ellipse cx="40" cy="40" rx="8" ry="6"/>',
        video: '<rect x="13" y="18" width="28" height="28" rx="7"/><path d="m42 26 10-6v24l-10-6Z"/>',
        archive: '<rect x="16" y="15" width="32" height="36" rx="6"/><path d="M32 15v22m-4 0h8v7h-8Z" fill="none" stroke="#a66b27" stroke-width="3" stroke-dasharray="3 2"/>',
        other: '<path d="m26 36 12-12m-16 6-3 3a9 9 0 0 0 13 13l6-6m4-10 3-3a9 9 0 0 0-13-13l-6 6" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
    };
    return svg(paths[file.category] || paths.other);
}
