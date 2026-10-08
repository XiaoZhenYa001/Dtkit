import { validateState, validateCourse, parseWeeks, formatWeeks, weekDays } from './model.js';

export const CSV_HEADER = ['课程名称', '星期', '开始节', '结束节', '周次', '教室', '教师', '颜色', '备注'];
// Spreadsheet formula prefixes are escaped when exporting and restored on import.
const csvEscape = value => `"${String(/^[\t\r\n ]*[=+@-]/.test(String(value)) ? `'${value}` : value).replaceAll('"', '""')}"`;
export function exportCsv(courses) {
    return '\uFEFF' + [CSV_HEADER, ...courses.map(course => [course.name, course.day, course.start, course.end, formatWeeks(course.weeks), course.room, course.teacher, course.color, course.notes])].map(row => row.map(csvEscape).join(',')).join('\r\n');
}
export function parseCsv(text) {
    const rows = []; let row = [], value = '', quoted = false, closed = false;
    text = text.replace(/^\uFEFF/, '');
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
            else if (char === '"') { quoted = false; closed = true; }
            else value += char;
        } else if (char === '"' && !value && !closed) quoted = true;
        else if (char === ',' || char === '\n' || char === '\r') {
            row.push(value); value = ''; closed = false;
            if (char !== ',') { if (row.some(cell => cell.trim())) rows.push(row); row = []; if (char === '\r' && text[index + 1] === '\n') index++; }
        } else { if (closed || char === '"') throw new Error('CSV 引号格式无效'); value += char; }
    }
    if (quoted) throw new Error('CSV 引号未闭合');
    row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
    return rows;
}
export function importCsv(text, semester) {
    const [header, ...rows] = parseCsv(text);
    if (!header || CSV_HEADER.some((name, index) => name !== header[index]?.trim()) || header.length !== CSV_HEADER.length) throw new Error(`CSV 表头应为：${CSV_HEADER.join(',')}。可先下载模板`);
    if (!rows.length || rows.length > 600) throw new Error('CSV 应包含 1–600 条课程安排');
    return rows.map((row, index) => {
        if (row.length !== CSV_HEADER.length) throw new Error(`CSV 第 ${index + 2} 行列数不正确`);
        row = row.map(value => /^'[\t\r\n ]*[=+@-]/.test(value) ? value.slice(1) : value);
        try { return validateCourse({ id: crypto.randomUUID(), name: row[0].trim(), day: Number(row[1]), start: Number(row[2]), end: Number(row[3]), weeks: parseWeeks(row[4], semester.totalWeeks), room: row[5], teacher: row[6], color: row[7] || 'blue', notes: row[8] }, semester); }
        catch (error) { throw new Error(`CSV 第 ${index + 2} 行：${error.message}`); }
    });
}
export function importJson(text) {
    let result;
    try { result = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('JSON 文件格式无效'); }
    return validateState(result);
}
const icsEscape = text => String(text).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\r', '');
function fold(line) {
    const encoder = new TextEncoder(); let output = '', part = '', bytes = 0;
    for (const char of line) {
        const length = encoder.encode(char).length;
        if (bytes + length > 74) { output += part + '\r\n '; part = ''; bytes = 1; }
        part += char; bytes += length;
    }
    return output + part;
}
export function exportIcs(state) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DtKit//Timetable//ZH', 'CALSCALE:GREGORIAN'];
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    for (const course of state.semester.courses) for (const week of course.weeks) {
        // Always include weekends even when hidden in the viewing preferences.
        const date = weekDays({ ...state, settings: { ...state.settings, showWeekend: true } }, week).find(day => day.day === course.day).date.replaceAll('-', '');
        const time = value => value.replace(':', '') + '00';
        lines.push('BEGIN:VEVENT', `UID:${icsEscape(course.id)}-${week}@dtkit`, `DTSTAMP:${stamp}`, `DTSTART:${date}T${time(state.semester.periods[course.start - 1].start)}`, `DTEND:${date}T${time(state.semester.periods[course.end - 1].end)}`, `SUMMARY:${icsEscape(course.name)}`, `LOCATION:${icsEscape(course.room)}`, `DESCRIPTION:${icsEscape([course.teacher && `教师：${course.teacher}`, course.notes].filter(Boolean).join('\n'))}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
}
export function download(content, filename, type = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
