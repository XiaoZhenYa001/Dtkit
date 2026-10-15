export const SHELF_STORAGE_KEY = 'dtkit_desktop_shelves_v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
const safe = value => typeof value === 'string' && value.length <= 240 && !['__proto__', 'constructor', 'prototype'].includes(value);

export function normalizeShelves(value, groupKeys = []) {
    const used = new Set(), ids = new Set();
    const shelves = [];
    for (const item of (Array.isArray(value) ? value : []).slice(0, 100)) {
        if (!item || typeof item !== 'object') continue;
        const keys = (Array.isArray(item.keys) ? item.keys : []).filter(key => safe(key) && groupKeys.includes(key) && !used.has(key));
        const unique = [...new Set(keys)];
        if (!unique.length) continue;
        unique.forEach(key => used.add(key));
        let id = safe(item.id) && !ids.has(item.id) ? item.id : `shelf-${shelves.length}`;
        while (ids.has(id)) id += '-';
        ids.add(id);
        shelves.push({ id, keys: unique, display: safe(item.display) ? item.display : '',
            form: item.form === 'card' && unique.length === 1 ? 'card' : 'capsule',
            x: clamp(number(item.x, .5), 0, 1), y: clamp(number(item.y, .88), 0, 1),
            dock: ['top', 'bottom', 'left', 'right'].includes(item.dock) ? item.dock : 'free',
            orientation: ['horizontal', 'vertical'].includes(item.orientation) ? item.orientation : 'auto',
            active: unique.includes(item.active) ? item.active : unique[0],
            pinned: item.pinned === true,
            width: clamp(number(item.width, 420), 260, 960), height: clamp(number(item.height, 340), 180, 900)
        });
    }
    const missing = [...new Set(groupKeys.filter(key => safe(key) && !used.has(key)))];
    if (missing.length && shelves.length) shelves[0].keys.push(...missing);
    else if (missing.length) shelves.push({ id: 'shelf-main', keys: missing, display: '', x: .5, y: .88,
        dock: 'free', orientation: 'auto', form: 'capsule', active: missing[0], pinned: false, width: 420, height: 340 });
    return shelves;
}

export function transferShelfGroup(shelves, key, targetId, beforeKey = null, detached = null) {
    const source = shelves.find(shelf => shelf.keys.includes(key));
    const target = shelves.find(shelf => shelf.id === targetId);
    if (!source || (!target && !detached)) return shelves;
    if (target === source && beforeKey === key) return shelves;
    const next = shelves.map(shelf => ({ ...shelf, keys: shelf.keys.filter(item => item !== key) }));
    const destination = target ? next.find(shelf => shelf.id === target.id) : {
        ...source, ...detached, id: detached.id, keys: [], active: key, pinned: false, dock: 'free'
    };
    const index = beforeKey ? destination.keys.indexOf(beforeKey) : -1;
    destination.keys.splice(index < 0 ? destination.keys.length : index, 0, key);
    destination.active = key;
    if (!target) next.push(destination);
    for (const shelf of next) if (!shelf.keys.includes(shelf.active)) shelf.active = shelf.keys[0] || '';
    return next.filter(shelf => shelf.keys.length);
}

export function shelfOrientation(shelf, dock = shelf.dock) {
    return shelf.orientation === 'auto' ? (['left', 'right'].includes(dock) ? 'vertical' : 'horizontal') : shelf.orientation;
}

export function clampShelfPoint(point, size, area, padding = 16) {
    return { x: clamp(point.x, area.x + padding, Math.max(area.x + padding, area.x + area.width - size.width - padding)),
        y: clamp(point.y, area.y + padding, Math.max(area.y + padding, area.y + area.height - size.height - padding)) };
}

export function shelfDockPreview(point, size, area, threshold = 34) {
    const distances = { left: Math.abs(point.x - area.x), right: Math.abs(area.x + area.width - point.x - size.width),
        top: Math.abs(point.y - area.y), bottom: Math.abs(area.y + area.height - point.y - size.height) };
    const dock = Object.keys(distances).sort((a, b) => distances[a] - distances[b])[0];
    return distances[dock] <= threshold ? dock : 'free';
}

export function shelfPanelRect(rail, size, area, orientation = 'horizontal', dock = 'free') {
    const gap = 10, pad = 16;
    const available = { top: rail.y - area.y - pad - gap, bottom: area.y + area.height - pad - rail.y - rail.height - gap,
        left: rail.x - area.x - pad - gap, right: area.x + area.width - pad - rail.x - rail.width - gap };
    const preferred = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' }[dock];
    const directions = orientation === 'vertical' ? ['right', 'left', 'top', 'bottom'] : ['bottom', 'top', 'right', 'left'];
    if (preferred) directions.unshift(preferred);
    const minimum = direction => ['left', 'right'].includes(direction) ? 250 : 150;
    const desired = direction => ['left', 'right'].includes(direction) ? Math.min(size.width, area.width - pad * 2) : Math.min(size.height, area.height - pad * 2);
    const direction = directions.find(item => available[item] >= desired(item)) || directions.find(item => available[item] >= minimum(item)) || directions.sort((a, b) => available[b] - available[a])[0];
    const side = ['left', 'right'].includes(direction);
    const width = Math.max(80, Math.min(size.width, area.width - pad * 2, side ? available[direction] : Infinity));
    const height = Math.max(80, Math.min(size.height, area.height - pad * 2, side ? Infinity : available[direction]));
    const x = direction === 'right' ? rail.x + rail.width + gap : direction === 'left' ? rail.x - width - gap : rail.x + (rail.width - width) / 2;
    const y = direction === 'bottom' ? rail.y + rail.height + gap : direction === 'top' ? rail.y - height - gap : rail.y + (rail.height - height) / 2;
    return { ...clampShelfPoint({ x, y }, { width, height }, area, pad), width, height, direction };
}
