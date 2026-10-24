const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

// The screenshot dimensions are physical pixels; the overlay DOM uses CSS
// pixels. Keeping the selected physical pixel as state makes keyboard steps
// exact even with fractional display scaling or a negative desktop origin.
export function clientToPixel(point, rect, width, height) {
    return {
        x: clamp(Math.floor((point.x - rect.left) * width / Math.max(1, rect.width)), 0, width - 1),
        y: clamp(Math.floor((point.y - rect.top) * height / Math.max(1, rect.height)), 0, height - 1)
    };
}

export function pixelToClient(point, rect, width, height) {
    return {
        x: rect.left + (point.x + .5) * rect.width / width,
        y: rect.top + (point.y + .5) * rect.height / height
    };
}

export function stepPixel(point, key, amount, width, height) {
    return {
        x: clamp(point.x + (key === 'ArrowRight' ? amount : key === 'ArrowLeft' ? -amount : 0), 0, width - 1),
        y: clamp(point.y + (key === 'ArrowDown' ? amount : key === 'ArrowUp' ? -amount : 0), 0, height - 1)
    };
}

export function magnifierPosition(point, width, height, panelWidth, panelHeight) {
    const gap = 22;
    return {
        x: clamp(point.x + gap + panelWidth > width - 8 ? point.x - gap - panelWidth : point.x + gap,
            8, Math.max(8, width - panelWidth - 8)),
        y: clamp(point.y + gap + panelHeight > height - 8 ? point.y - gap - panelHeight : point.y + gap,
            8, Math.max(8, height - panelHeight - 8))
    };
}
