const RESTS = [{ after: 4, label: '午休' }, { after: 8, label: '晚休' }];
export function periodLayout(count) {
    const rows = [];
    for (let period = 1; period <= count; period++) {
        rows.push({ period });
        const rest = RESTS.find(item => item.after === period);
        if (rest && period < count) rows.push(rest);
    }
    return rows;
}
export function courseSegments(course) {
    const segments = [];
    let start = course.start;
    for (const { after } of RESTS) if (start <= after && course.end > after) { segments.push({ start, end: after }); start = after + 1; }
    segments.push({ start, end: course.end });
    return segments;
}
