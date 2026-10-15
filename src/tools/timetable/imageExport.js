import { DAYS, weekDays } from './model.js';
import { download } from './transfer.js';
import { coursePalette, backgroundRect } from './appearance.js';
import { periodLayout, courseSegments } from './layout.js';
export async function exportPng(state, week) {
    await document.fonts.ready;
    const days = weekDays(state, week), count = state.semester.periods.length;
    const width = 1440, margin = 32, ruler = 80, top = 140, rowHeight = 90, colWidth = (width - margin * 2 - ruler) / days.length;
    const rows = periodLayout(count), restHeight = 26;
    let cursor = top;
    const rowTops = rows.map(row => { const y = cursor; cursor += row.period ? rowHeight : restHeight; return y; });
    const periodY = period => rowTops[rows.findIndex(row => row.period === period)];
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = cursor + 54;
    const ctx = canvas.getContext('2d');
    const bg = state.settings.background;
    ctx.fillStyle = ({ paper: '#f7f9f6', mint: '#e4f0e8', sky: '#e9f0f8', lavender: '#efeaf5' })[bg.preset] || '#f7f9f6'; ctx.fillRect(0, 0, width, canvas.height);
    if (bg.preset === 'image') {
        const image = new Image(); image.src = bg.image; await image.decode();
        const rect = backgroundRect(width, canvas.height, image.width, image.height, bg.fit);
        ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
        ctx.fillStyle = `rgba(248,250,248,${bg.dim / 100})`; ctx.fillRect(0, 0, width, canvas.height);
    }
    ctx.fillStyle = '#253b38'; ctx.font = 'bold 30px "Microsoft YaHei", sans-serif'; ctx.fillText(state.semester.name, margin, 49);
    ctx.font = '18px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#74847f'; ctx.fillText(`第 ${week} 周 · ${days[0].date} — ${days.at(-1).date}`, margin, 80);
    for (let index = 0; index < days.length; index++) {
        ctx.fillStyle = '#347368'; ctx.font = 'bold 20px "Microsoft YaHei", sans-serif'; ctx.fillText(`${DAYS[days[index].day - 1]}  ${days[index].date.slice(5)}`, margin + ruler + index * colWidth + 12, 121);
    }
    ctx.strokeStyle = '#dae3da'; ctx.lineWidth = 1;
    for (const y of [...rowTops, cursor]) { ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(width - margin, y); ctx.stroke(); }
    for (let index = 0; index <= days.length; index++) { ctx.beginPath(); ctx.moveTo(margin + ruler + index * colWidth, top); ctx.lineTo(margin + ruler + index * colWidth, cursor); ctx.stroke(); }
    rows.forEach((row, index) => {
        if (row.period) return;
        ctx.fillStyle = '#edf1ee'; ctx.fillRect(margin, rowTops[index], width - margin * 2, restHeight);
        ctx.fillStyle = '#718079'; ctx.font = '14px "Microsoft YaHei", sans-serif'; ctx.fillText(row.label, margin + 8, rowTops[index] + 18);
    });
    state.semester.periods.forEach((period, index) => {
        const y = periodY(index + 1);
        ctx.fillStyle = '#657669'; ctx.font = 'bold 21px sans-serif'; ctx.fillText(String(index + 1), margin + 4, y + 27);
        ctx.font = '14px sans-serif'; ctx.fillText(period.start, margin + 4, y + 49); ctx.fillText(period.end, margin + 4, y + 68);
    });
    days.forEach((day, dayIndex) => {
        const courses = state.semester.courses.filter(course => course.day === day.day && (state.settings.showOtherWeeks || course.weeks.includes(week))).sort((a, b) => a.start - b.start);
        const ends = [], places = courses.map(course => { let lane = ends.findIndex(end => end < course.start); if (lane < 0) lane = ends.length; ends[lane] = course.end; return { course, lane }; });
        const laneWidth = colWidth / Math.max(1, ends.length);
        for (const { course, lane } of places) {
          for (const segment of courseSegments(course)) {
            const x = margin + ruler + dayIndex * colWidth + lane * laneWidth + 5, y = periodY(segment.start) + 5;
            const w = laneWidth - 10, h = (segment.end - segment.start + 1) * rowHeight - 10, active = course.weeks.includes(week);
            const [paper, ink, lineColor] = coursePalette(course.color, active);
            ctx.fillStyle = paper; ctx.beginPath(); ctx.roundRect(x, y, w, h, 9); ctx.fill();
            ctx.save(); ctx.strokeStyle = lineColor; ctx.setLineDash(active ? [] : [5, 4]); ctx.stroke(); ctx.restore();
            ctx.save(); ctx.beginPath(); ctx.rect(x + 8, y + 5, w - 16, h - 10); ctx.clip();
            ctx.fillStyle = ink; ctx.font = 'bold 19px "Microsoft YaHei", sans-serif';
            let line = '', textY = y + 26;
            for (const char of course.name) {
                if (ctx.measureText(line + char).width > w - 20 && line) { ctx.fillText(line, x + 10, textY); textY += 24; line = ''; if (textY > y + Math.min(h - 20, 85)) break; }
                line += char;
            }
            ctx.fillText(line, x + 10, textY);
            ctx.font = '15px "Microsoft YaHei", sans-serif'; if (course.room && h > 105) ctx.fillText(course.room, x + 10, textY + 26, w - 20);
            ctx.font = '13px "Microsoft YaHei", sans-serif'; ctx.fillText(`${segment.start}–${segment.end} 节${active ? '' : ' · 非本周'}`, x + 10, y + h - 13, w - 20);
            ctx.restore();
          }
        }
    });
    ctx.fillStyle = '#74847f'; ctx.font = '14px "Microsoft YaHei", sans-serif'; ctx.fillText('DtKit · 我的课表', margin, canvas.height - 18);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('课表图片生成失败');
    download(blob, `课表-第${week}周.png`);
}
