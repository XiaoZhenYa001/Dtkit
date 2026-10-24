import { escapeHtml as e } from '../../core/html.js';
import { DAYS, formatWeeks } from './model.js';
import { courseTime } from './view.js';

export function attachCourseDetails(root, getState, signal) {
    const detail = root.querySelector('#ttCourseDetail');
    let anchor = null, showTimer = null, hideTimer = null, animation = null, transition = 0;
    const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    function hide(immediate = false) {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        anchor?.removeAttribute('aria-describedby'); anchor = null;
        const token = ++transition;
        animation?.cancel(); animation = null;
        if (immediate === true || reducedMotion() || detail.hidden || !detail.animate) { detail.hidden = true; return; }
        animation = detail.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-3px) scale(.985)' }], { duration: 100, easing: 'ease-out', fill: 'forwards' });
        animation.finished.then(() => { if (token === transition) { detail.hidden = true; animation.cancel(); animation = null; } }, () => {});
    }
    function show(card) {
        clearTimeout(showTimer); clearTimeout(hideTimer);
        if (!card.isConnected || root.querySelector('dialog[open]')) return;
        const state = getState(), course = state?.semester.courses.find(item => item.id === card.dataset.id);
        if (!course) return;
        const previous = !detail.hidden ? detail.getBoundingClientRect() : null;
        ++transition; animation?.cancel(); animation = null;
        anchor?.removeAttribute('aria-describedby'); anchor = card;
        const status = card.dataset.status;
        detail.innerHTML = `<strong>${e(course.name)}</strong>${status ? `<span class="tt-detail-status">${e(status)}</span>` : ''}<p>${DAYS[course.day - 1]} · ${courseTime(course, state.semester)} · ${course.start}–${course.end} 节</p><p>第 ${formatWeeks(course.weeks)} 周</p><p>${e(course.room || '未设置教室')}${course.teacher ? ` · ${e(course.teacher)}` : ''}</p>${course.notes ? `<p class="tt-detail-notes">${e(course.notes)}</p>` : ''}`;
        detail.hidden = false; card.setAttribute('aria-describedby', detail.id);
        const box = card.getBoundingClientRect(), width = detail.offsetWidth, height = detail.offsetHeight;
        detail.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, box.left))}px`;
        const y = box.bottom + 8 + height <= innerHeight ? box.bottom + 8 : box.top - height - 8;
        detail.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, y))}px`;
        if (!reducedMotion() && detail.animate) {
            const next = detail.getBoundingClientRect();
            const x = previous ? previous.left - next.left : 0, y = previous ? previous.top - next.top : -4;
            animation = detail.animate([{ opacity: previous ? .72 : 0, transform: `translate(${x}px, ${y}px) scale(.985)` }, { opacity: 1, transform: 'translate(0, 0) scale(1)' }], { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
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
    window.addEventListener('resize', () => hide(true), { signal });
    window.addEventListener('scroll', () => hide(true), { signal, capture: true });
    signal.addEventListener('abort', () => hide(true), { once: true });
    return hide;
}
