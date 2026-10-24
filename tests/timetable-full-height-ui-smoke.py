"""Verify that the main weekly timetable always expands every period.

Uses generated schedules and a fresh profile under the production CSP.
"""
import importlib.util
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('redesign', Path(__file__).with_name('timetable-redesign-ui-smoke.py'))
redesign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redesign)
OUT = Path(__file__).resolve().parents[1] / '.tmp' / 'timetable-full-height'
OUT.mkdir(parents=True, exist_ok=True)


def schedule(period_count, density):
    data = redesign.fixture()
    data['settings']['density'] = density
    if period_count == 24:
        def time(minute):
            return f'{minute // 60:02}:{minute % 60:02}'
        data['semester']['periods'] = [dict(start=time(360 + index * 30), end=time(385 + index * 30)) for index in range(24)]
    data['semester']['courses'].append(dict(id='last-period', name='最后一节完整显示', day=1,
        start=period_count - 1, end=period_count, color='blue', room='A-202', teacher='', notes='', weeks=list(range(1, 21))))
    return data


GEOMETRY = """() => {
 const scroll=document.querySelector('#ttBoard .tt-board-scroll'),grid=document.querySelector('#ttGrid');
 const last=grid.querySelector('.tt-period:last-child'),board=document.querySelector('#ttBoard');
 let outer=document.querySelector('.tt-shell').parentElement;
 while(outer&&outer!==document.documentElement&&!/(auto|scroll)/.test(getComputedStyle(outer).overflowY))outer=outer.parentElement;
 const viewportBottom=outer&&outer!==document.documentElement?outer.getBoundingClientRect().top+outer.clientHeight:innerHeight;
 return {height:scroll.clientHeight,contentHeight:scroll.scrollHeight,width:scroll.clientWidth,contentWidth:scroll.scrollWidth,
   periodCount:grid.querySelectorAll('.tt-period').length,rowHeight:parseFloat(getComputedStyle(grid).getPropertyValue('--tt-row-height')),
   boardBottom:board.getBoundingClientRect().bottom,footerBottom:document.querySelector('.tt-footer').getBoundingClientRect().bottom,
   lastBottom:last.getBoundingClientRect().bottom,viewportBottom,outerHeight:outer?.clientHeight,outerContentHeight:outer?.scrollHeight};
}"""


def check(browser, base, width, height, periods=12, density='compact', embedded=False):
    context = redesign.context_for(browser, base, {'width': width, 'height': height})
    fixture = schedule(periods, density)
    context.add_init_script(f"localStorage.setItem('{redesign.KEY}', {json.dumps(json.dumps(fixture, ensure_ascii=False))});")
    page = context.new_page()
    errors = []
    redesign.monitor(page, errors)
    try:
        if embedded:
            page.goto(base, wait_until='networkidle')
            page.locator('[data-tool-id="timetable"] .tool-card__title').click()
            frame = redesign.multi.active_tool_frame(page, '#ttGrid')
        else:
            page.goto(base + '/quick.html?kind=tool&toolId=timetable', wait_until='networkidle')
            frame = page
        expect(frame.locator('#ttGrid .tt-period')).to_have_count(periods)
        frame.wait_for_function("()=>document.querySelector('#ttGrid').style.getPropertyValue('--tt-fit-row-height') || document.querySelector('.tt-shell').clientWidth<960 || document.querySelector('#ttGrid').dataset.density==='comfortable' || document.querySelectorAll('#ttGrid .tt-period').length>14")
        frame.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        geometry = frame.evaluate(GEOMETRY)
        assert geometry['contentHeight'] <= geometry['height'] + 1, geometry
        assert abs(geometry['lastBottom'] - geometry['boardBottom']) <= 2, geometry
        assert frame.locator('#ttBoard .tt-board-scroll').evaluate('node=>{node.scrollTop=500;return node.scrollTop}') == 0
        if width >= 1366 and periods == 12 and density == 'compact':
            assert geometry['boardBottom'] <= geometry['viewportBottom'] + 1, geometry
        if periods > 14:
            assert geometry['rowHeight'] == 54, geometry
        if density == 'comfortable':
            assert geometry['rowHeight'] == 76, geometry
        if periods > 14 or density == 'comfortable':
            assert geometry['outerContentHeight'] > geometry['outerHeight'], geometry
            frame.locator('#ttGrid .tt-period').last.scroll_into_view_if_needed()
            frame.evaluate("()=>{dispatchEvent(new Event('resize'));dispatchEvent(new Event('focus'))}")
            frame.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            assert frame.evaluate(GEOMETRY)['rowHeight'] == geometry['rowHeight']
        if width == 390:
            assert geometry['contentWidth'] > geometry['width'], geometry
            assert frame.locator('#ttBoard .tt-board-scroll').evaluate('node=>{node.scrollLeft=150;return node.scrollLeft}') > 0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        frame.locator('[data-tt-action="view-agenda"]').click()
        frame.locator('[data-tt-action="view-week"]').click()
        frame.wait_for_function("()=>document.querySelector('#ttViews').getAnimations({subtree:true}).length===0")
        assert frame.locator('#ttViews [data-tt-snapshot]').count() == 0
        assert frame.evaluate(GEOMETRY)['contentHeight'] <= frame.evaluate(GEOMETRY)['height'] + 1
        assert not errors, errors
        label = f'{width}x{height}-{periods}-{density}' + ('-embedded' if embedded else '')
        page.screenshot(path=str(OUT / f'{label}.png'), full_page=True)
        print(f'PASS {label}: {geometry}', flush=True)
    finally:
        context.close()


def run(base):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            check(browser, base, 1366, 768)
            check(browser, base, 1920, 1080)
            check(browser, base, 1366, 768, 24)
            check(browser, base, 1366, 768, 12, 'comfortable')
            check(browser, base, 390, 844)
            check(browser, base, 1366, 768, embedded=True)
            redesign.widget_checks(browser, base)
        finally:
            browser.close()


if __name__ == '__main__':
    with redesign.multi.production_url() as base_url:
        run(base_url)
