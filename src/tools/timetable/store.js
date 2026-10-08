import { createState, validateState } from './model.js';
export const STORAGE_KEY = 'dtkit_timetable_v1';
export const CHANGED_EVENT = 'dtkit:timetable-changed';
export function readState(storage = globalThis.localStorage) {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createState();
    try { return validateState(JSON.parse(raw)); }
    catch (error) { throw new Error(`课表数据读取失败，原数据已保留：${error.message}`); }
}
export async function updateState(mutate, expectedRevision, { storage = globalThis.localStorage, locks = globalThis.window?.navigator?.locks } = {}) {
    const commit = () => {
        const state = readState(storage);
        if (expectedRevision !== undefined && state.revision !== expectedRevision) throw new Error('课表已在另一个窗口更新。请关闭面板后重新打开，再保存修改');
        mutate(state);
        state.revision++;
        validateState(state);
        const json = JSON.stringify(state);
        if (json.length > 2000000) throw new Error('课表备份过大，请减少背景图片或导出后移除旧学期');
        try { storage.setItem(STORAGE_KEY, json); }
        catch { throw new Error('课表保存失败，存储空间不足。原课表仍保留，请导出备份'); }
        globalThis.window?.dispatchEvent(new CustomEvent(CHANGED_EVENT));
        return state;
    };
    return locks?.request ? locks.request(STORAGE_KEY, commit) : commit();
}
