import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStartupCsv } from '../src/tools/system-assistant/export.js';

const HEADERS = ['名称', '状态', '范围', '来源', '命令', '程序路径', '来源位置', '关闭时间', '备注'];
const entry = (overrides = {}) => ({
    id: 'cloud', name: '云同步', command: '"C:\\Apps\\Cloud.exe" --background',
    targetPath: 'C:\\Apps\\Cloud.exe', sourceKind: 'registry', sourceLabel: '当前用户 · 注册表 Run',
    sourceDetail: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    scope: 'user', enabled: true, managed: false, disabledReason: '', backupDisabledAt: null,
    ...overrides
});

// Decode CSV records independently of the writer, including quoted newlines.
// This intentionally checks delimiters and quote balancing rather than splitting
// on line breaks, which would hide corruption of multiline command/notes cells.
function records(csv) {
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false;
    for (let index = 1; index < csv.length; index++) {
        const character = csv[index];
        if (quoted) {
            if (character === '"' && csv[index + 1] === '"') { cell += '"'; index++; }
            else if (character === '"') { quoted = false; closed = true; }
            else cell += character;
        } else if (character === '"' && !cell && !closed) quoted = true;
        else if (character === ',') { row.push(cell); cell = ''; closed = false; }
        else if (character === '\r' && csv[index + 1] === '\n') {
            row.push(cell); rows.push(row); row = []; cell = ''; closed = false; index++;
        } else {
            assert.fail(`Unexpected CSV character outside quotes: ${JSON.stringify(character)}`);
        }
    }
    assert.equal(quoted, false, 'Every quoted field must close');
    assert.deepEqual(row, [], 'Every record must end with CRLF');
    assert.equal(cell, '');
    for (const fields of rows) assert.equal(fields.length, HEADERS.length);
    return rows;
}

test('empty exports contain one complete Chinese UTF-8 BOM header record', () => {
    const csv = buildStartupCsv([]);
    assert.equal(csv, '\uFEFF"名称","状态","范围","来源","命令","程序路径","来源位置","关闭时间","备注"\r\n');
    assert.deepEqual([...new TextEncoder().encode(csv).slice(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.deepEqual(records(csv), [HEADERS]);
});

test('exports preserve supplied order and map registry, folder, managed and external states', () => {
    const items = [
        entry(),
        entry({ name: '所有用户助手', scope: 'system', enabled: false, managed: true,
            sourceKind: 'startupFolder', sourceLabel: '', sourcePath: 'C:\\Startup Backup\\助手.lnk',
            backupDisabledAt: Date.UTC(2026, 9, 22, 4, 5, 6, 789), disabledReason: '可恢复关闭记录' }),
        entry({ name: 'Windows 已关闭', enabled: false, managed: false, sourceLabel: '',
            disabledReason: '已由 Windows 关闭，仅查看' })
    ];
    const before = structuredClone(items);
    const rows = records(buildStartupCsv(items));
    assert.deepEqual(rows[1], ['云同步', '已启用', '当前用户', '当前用户 · 注册表 Run',
        '"C:\\Apps\\Cloud.exe" --background', 'C:\\Apps\\Cloud.exe',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '', '']);
    assert.deepEqual(rows[2].slice(0, 4), ['所有用户助手', '我关闭的', '所有用户', '启动文件夹']);
    assert.deepEqual(rows[2].slice(6), ['C:\\Startup Backup\\助手.lnk', '2026-10-22T04:05:06.789Z', '可恢复关闭记录']);
    assert.deepEqual(rows[3].slice(0, 4), ['Windows 已关闭', '已关闭', '当前用户', '注册表']);
    assert.equal(rows[3][8], '已由 Windows 关闭，仅查看');
    assert.deepEqual(items, before, 'Exporting must not mutate the current inventory');
});

test('Unicode, quotes, commas and multiline data remain in their original CSV cells', () => {
    const name = '工具 "甲,乙" 🧰𠮷';
    const command = '"C:\\应用,便携\\run.exe" --label="你好"\r\nnext\nlast\rend';
    const note = '第一行\r\n第二行, "引用"\n=literal inside the same cell';
    const rows = records(buildStartupCsv([entry({ name, command, disabledReason: note })]));
    assert.equal(rows.length, 2, 'Multiline content must not create extra records');
    assert.equal(rows[1][0], name);
    assert.equal(rows[1][4], command);
    assert.equal(rows[1][8], note);
});

test('formula prefixes are neutralized after leading ASCII, Unicode whitespace and controls', () => {
    const dangerous = ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(1)', ' \t=HYPERLINK("x")',
        '\r\n+1', '\u00A0\u3000-1', '\uFEFF@SUM(2)', '\u0000\u000B=1'];
    for (const value of dangerous) {
        const row = records(buildStartupCsv([entry({ name: value, sourceLabel: value, command: value,
            targetPath: value, sourcePath: value, disabledReason: value })]))[1];
        for (const column of [0, 3, 4, 5, 6, 8]) assert.equal(row[column], `'${value}`);
    }
});

test('CSV delimiters cannot break out of a cell and benign text keeps its exact whitespace', () => {
    const values = [' normal text ', '\tordinary text', "'=1+1", 'C:\\Apps\\Cloud.exe --a=1',
        '",=HYPERLINK("https://example.invalid"),"', '第一行\n@second-line'];
    const rows = records(buildStartupCsv(values.map(name => entry({ name }))));
    assert.deepEqual(rows.slice(1).map(row => row[0]), values);
    assert.equal(rows.length, values.length + 1);
});

test('close timestamps use unambiguous ISO UTC and invalid optional times stay empty', () => {
    const values = [0, null, undefined, '', '2026-10-22', NaN, Infinity, 9e15];
    const rows = records(buildStartupCsv(values.map(backupDisabledAt => entry({ backupDisabledAt }))));
    assert.equal(rows[1][7], '1970-01-01T00:00:00.000Z');
    assert.deepEqual(rows.slice(2).map(row => row[7]), Array(7).fill(''));
});

test('invalid inventory shapes fail before an incomplete export can be saved', () => {
    for (const value of [null, undefined, {}, 'items']) assert.throws(() => buildStartupCsv(value), TypeError);
    for (const item of [null, undefined, [], 1]) assert.throws(() => buildStartupCsv([item]), TypeError);
});
