export const MAX_NOTE_LENGTH = 20000;

export function escapeNoteHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function inline(text) {
    // Only these small, literal Markdown tokens produce markup. Everything else,
    // including raw HTML, URLs, images and attributes, remains escaped text.
    const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*)/g;
    let html = '';
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
        html += escapeNoteHtml(text.slice(cursor, match.index));
        const token = match[0];
        const tag = token.startsWith('`') ? 'code' : token.startsWith('**') ? 'strong' : token.startsWith('~~') ? 'del' : 'em';
        const trim = ['strong', 'del'].includes(tag) ? 2 : 1;
        html += `<${tag}>${escapeNoteHtml(token.slice(trim, -trim))}</${tag}>`;
        cursor = match.index + token.length;
    }
    return html + escapeNoteHtml(text.slice(cursor));
}

export function noteStats(content) {
    const text = String(content ?? '');
    let fenced = false;
    let tasks = 0;
    let completed = 0;
    for (const line of text.split('\n')) {
        if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
        if (fenced) continue;
        const task = line.match(/^\s*[-*+] \[([ xX])\]\s/);
        if (task) { tasks += 1; if (task[1] !== ' ') completed += 1; }
    }
    return { characters: [...text].length, tasks, completed };
}

export function renderNoteMarkdown(content) {
    const lines = String(content ?? '').split('\n');
    const result = [];
    let fenced = false;
    let code = [];
    let list = null;
    const closeList = () => { if (list) { result.push(`</${list}>`); list = null; } };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^\s*```/.test(line)) {
            closeList();
            if (fenced) { result.push(`<pre><code>${escapeNoteHtml(code.join('\n'))}</code></pre>`); code = []; }
            fenced = !fenced;
            continue;
        }
        if (fenced) { code.push(line); continue; }
        const task = line.match(/^\s*[-*+] \[([ xX])\]\s(.*)$/);
        const bullet = line.match(/^\s*[-*+] (.*)$/);
        const numbered = line.match(/^\s*\d+\. (.*)$/);
        if (task || bullet || numbered) {
            const nextList = numbered ? 'ol' : 'ul';
            if (list !== nextList) { closeList(); result.push(`<${nextList}>`); list = nextList; }
            if (task) {
                const checked = task[1] !== ' ';
                result.push(`<li class="note-task${checked ? ' is-complete' : ''}"><label><input type="checkbox" data-task-line="${index}" aria-label="标记任务：${escapeNoteHtml(task[2])}"${checked ? ' checked' : ''}><span>${inline(task[2])}</span></label></li>`);
            } else result.push(`<li>${inline((numbered || bullet)[1])}</li>`);
            continue;
        }
        closeList();
        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) result.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
        else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) result.push('<hr>');
        else if (/^>\s?/.test(line)) result.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
        else if (!line.trim()) result.push('<div class="note-paragraph-space" aria-hidden="true"></div>');
        else result.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    if (fenced) result.push(`<pre><code>${escapeNoteHtml(code.join('\n'))}</code></pre>`);
    return result.join('');
}

export function toggleNoteTask(content, lineIndex, checked) {
    const lines = content.split('\n');
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) return content;
    let fenced = false;
    for (let index = 0; index <= lineIndex; index += 1) {
        if (/^\s*```/.test(lines[index])) fenced = !fenced;
    }
    if (fenced || !/^\s*[-*+] \[[ xX]\]\s/.test(lines[lineIndex])) return content;
    lines[lineIndex] = lines[lineIndex].replace(/^(\s*[-*+] \[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
    return lines.join('\n');
}

export function formatNoteSelection(content, start, end, action) {
    start = Math.max(0, Math.min(content.length, start));
    end = Math.max(start, Math.min(content.length, end));
    const wraps = { bold: '**', italic: '*', code: '`', strike: '~~' };
    let from = start;
    let to = end;
    let replacement;
    let selectionStart;
    let selectionEnd;
    if (wraps[action]) {
        const marker = wraps[action];
        const selected = content.slice(start, end);
        if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
            replacement = selected.slice(marker.length, -marker.length);
            selectionStart = start; selectionEnd = start + replacement.length;
        } else if (content.slice(start - marker.length, start) === marker && content.slice(end, end + marker.length) === marker) {
            from -= marker.length; to += marker.length; replacement = selected;
            selectionStart = from; selectionEnd = from + selected.length;
        } else {
            const value = selected || ({ bold: '粗体文字', italic: '斜体文字', code: '代码', strike: '文字' })[action];
            replacement = marker + value + marker;
            selectionStart = start + marker.length; selectionEnd = selectionStart + value.length;
        }
    } else {
        from = start === 0 ? 0 : content.lastIndexOf('\n', start - 1) + 1;
        to = content.indexOf('\n', end > start && content[end - 1] === '\n' ? end - 1 : end);
        if (to === -1) to = content.length;
        const lines = content.slice(from, to).split('\n');
        const prefixes = { heading: '# ', list: '- ', checklist: '- [ ] ', quote: '> ', indent: '  ' };
        const patterns = { heading: /^#{1,4} /, list: /^[-*+] (?!\[[ xX]\] )/, checklist: /^[-*+] \[[ xX]\] /, quote: /^> /, indent: /^ {2}/ };
        if (action === 'outdent') replacement = lines.map(line => line.replace(/^(?: {1,2}|\t)/, '')).join('\n');
        else if (prefixes[action]) {
            const remove = lines.every(line => patterns[action].test(line));
            replacement = lines.map(line => remove ? line.replace(patterns[action], '') : prefixes[action] + line).join('\n');
        } else return null;
        selectionStart = from; selectionEnd = from + replacement.length;
    }
    const value = content.slice(0, from) + replacement + content.slice(to);
    if (value.length > MAX_NOTE_LENGTH) return null;
    return { from, to, replacement, value, selectionStart, selectionEnd };
}

export function continueNoteList(content, caret) {
    const from = caret === 0 ? 0 : content.lastIndexOf('\n', caret - 1) + 1;
    let fenced = false;
    for (const line of content.slice(0, from).split('\n')) if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return null;
    const line = content.slice(from, caret);
    const match = line.match(/^(\s*)(?:(- \[[ xX]\] )|([-*+] )|(\d+)\. )(.*)$/);
    if (!match) return null;
    const nextBreak = content.indexOf('\n', caret);
    const remaining = content.slice(caret, nextBreak === -1 ? content.length : nextBreak);
    if (!match[5].trim() && !remaining.trim()) return { from, to: caret, replacement: '', selectionStart: from, selectionEnd: from };
    const prefix = match[2] ? '- [ ] ' : match[3] || `${Number(match[4]) + 1}. `;
    const replacement = `\n${match[1]}${prefix}`;
    if (content.length + replacement.length > MAX_NOTE_LENGTH) return null;
    return { from: caret, to: caret, replacement, selectionStart: caret + replacement.length, selectionEnd: caret + replacement.length };
}

export function findNoteMatches(content, query) {
    if (!query) return [];
    // Regex match indices refer to the original UTF-16 string. Lowercasing the
    // full document first can change its length (for example Turkish İ).
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...content.matchAll(new RegExp(literal, 'giu'))].map(match => ({ start: match.index, end: match.index + match[0].length }));
}
