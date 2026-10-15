import { escapeHtml as e } from '../../core/html.js';
import { DAYS, formatWeeks } from './model.js';
import { courseTime } from './view.js';

export function attachCourseDetails(root, getState, signal) {
    const detail = root.querySelector('#ttCourseDetail');
    let anchor = null, showTimer = null, hideTimer = null;
    function hide() {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        anchor?.removeAttribute('aria-describedby'); anchor = null; detail.hidden = true;
    }
    function show(card) {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        if (!card.isConnected || root.querySelector('dialog[open]')) return;
        const state = getState(), course = state?.semester.courses.find(item => item.id === card.dataset.id);
        if (!course) return;
        anchor?.removeAttribute('aria-describedby'); anchor = card;
        const status = card.dataset.status;
        detail.innerHTML = `<strong>${e(course.name)}</strong>${status ? `<span class="tt-detail-status">${e(status)}</span>` : ''}<p>${DAYS[course.day - 1]} · ${courseTime(course, state.semester)} · ${course.start}–${course.end} 节</p><p>第 ${formatWeeks(course.weeks)} 周</p><p>${e(course.room || '未设置教室')}${course.teacher ? ` · ${e(course.teacher)}` : ''}</p>${course.notes ? `<p class="tt-detail-notes">${e(course.notes)}</p>` : ''}`;
        detail.hidden = false; card.setAttribute('aria-describedby', detail.id);
        const box = card.getBoundingClientRect(), width = detail.offsetWidth, height = detail.offsetHeight;
        detail.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, box.left))}px`;
        const y = box.bottom + 8 + height <= innerHeight ? box.bottom + 8 : box.top - height - 8;
        detail.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, y))}px`;
    }
    root.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch') return;
        const card = event.target.closest('.tt-course');
        if (card && !card.contains(event.relatedTarget)) { clearTimeout(hideTimer); clearTimeout(showTimer); showTimer = setTimeout(() => show(card), 140); }
        if (detail.contains(event.target)) clearTimeout(hideTimer);
    }, { signal });
    root.addEventListener('pointerout', event => {
        if (!event.target.closest('.tt-course, .tt-course-detail')) return;
        if (event.relatedTarget?.closest('.tt-course, .tt-course-detail')) return;
        clearTimeout(showTimer); clearTimeout(hideTimer); hideTimer = setTimeout(hide, 120);
    }, { signal });
    root.addEventListener('focusin', event => { const card = event.target.closest('.tt-course'); if (card) show(card); }, { signal });
    root.addEventListener('focusout', event => { if (event.target.closest('.tt-course')) hide(); }, { signal });
    root.addEventListener('click', hide, { signal });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !detail.hidden) { event.preventDefault(); hide(); } }, { signal });
    if (window.parent !== window) window.parent.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !detail.hidden && !window.__DTKIT_TOOL_PAGE__?.suspended) { event.preventDefault(); hide(); }
    }, { signal });
    window.addEventListener('resize', hide, { signal });
    window.addEventListener('scroll', hide, { signal, capture: true });
    signal.addEventListener('abort', hide, { once: true });
    return hide;
}
