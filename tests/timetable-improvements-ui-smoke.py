"""Exercise local backgrounds, rest rows, custom colours and room-specific schedules."""
import importlib.util
import json
import struct
import sys
import zlib
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location('multi', Path(__file__).with_name('multi-page-ui-smoke.py'))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
OUT = Path(__file__).parent / 'artifacts' / 'timetable-improvements'
OUT.mkdir(parents=True, exist_ok=True)


def png(width, height):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    # Distinct edges make accidental cropping visible in screenshots.
    row = b'\x00' + b'\xc3\x79\x7c' * (width // 3) + b'\x8e\xbd\xa5' * (width - 2 * (width // 3)) + b'\x74\x9c\xc4' * (width // 3)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b'')


def settings(page, frame):
    page.locator('[data-tool-page-toggle]').click()
    page.locator('[data-tool-action="settings"]').click()
    frame.locator('[data-tab="features"]').click()


def saved(page):
    return page.evaluate("JSON.parse(localStorage.getItem('dtkit_timetable_v1'))")


def run(base, baseline=False):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1536, 'height': 800}, timezone_id='Asia/Shanghai', accept_downloads=True)
        context.add_init_script(multi.MOCK)
        def csp(route):
            response = route.fetch()
            headers = dict(response.headers)
            if 'text/html' in headers.get('content-type', ''):
                headers['content-security-policy'] = multi.CSP
            route.fulfill(response=response, headers=headers)
        context.route(base + '/**', csp)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        try:
            page.goto(base, wait_until='networkidle')
            page.locator('[data-tool-id="timetable"] .tool-card__title').click()
            frame = multi.active_tool_frame(page, '.tt-shell')
            settings(page, frame)
            frame.locator('#ttBackgroundFile').set_input_files({'name': '竖版背景.png', 'mimeType': 'image/png', 'buffer': png(400, 1600)})
            expect(frame.locator('#ttBackgroundInfo')).to_contain_text('图片已压缩')
            frame.get_by_role('button', name='保存设置', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()
            if baseline:
                size = frame.locator('#ttBoard').evaluate("n=>getComputedStyle(n,'::before').backgroundSize")
                board = frame.locator('#ttBoard').bounding_box()
                scale = max(board['width'] / 400, board['height'] / 1600)
                fraction = board['height'] / (1600 * scale)
                settings(page, frame)
                empty = frame.locator('#ttBackgroundFile').evaluate('n=>n.files.length===0')
                print(f'REPRO: background-size={size}; portrait visible height={fraction:.1%}; reopened file input empty={empty}')
                assert size == 'cover' and fraction < .5 and empty
                return
            expect(frame.locator('#ttBoard')).to_have_attribute('data-background-fit', 'contain')
            assert frame.locator('#ttBoard').evaluate("n=>getComputedStyle(n,'::before').backgroundSize") == 'contain'
            settings(page, frame)
            expect(frame.locator('#ttBackgroundName')).to_have_text('竖版背景.png')
            expect(frame.locator('#ttBackgroundPreview')).to_be_visible()
            assert frame.locator('#ttBackgroundPreview').evaluate('n=>n.complete && n.naturalHeight===1280')
            expect(frame.locator('#ttBackgroundFile')).to_be_hidden()
            page.screenshot(path=str(OUT / 'background-settings.png'))
            frame.locator('[data-tt-action="close"]').first.click()
            for name, width, height in [('宽幅背景.png', 2000, 300), ('方形背景.png', 800, 800)]:
                settings(page, frame)
                with page.expect_file_chooser() as chooser:
                    frame.locator('[data-tt-action="choose-background"]').click()
                chooser.value.set_files({'name': name, 'mimeType': 'image/png', 'buffer': png(width, height)})
                expect(frame.locator('#ttBackgroundName')).to_have_text(name)
                frame.locator('#ttBackgroundDim').evaluate("n=>{n.value='40';n.dispatchEvent(new Event('input',{bubbles:true}))}")
                frame.get_by_role('button', name='保存设置', exact=True).click()
                expect(frame.locator('#ttDialog')).not_to_be_visible()
                assert saved(page)['settings']['background']['imageName'] == name
            page.reload(wait_until='networkidle')
            frame = multi.active_tool_frame(page, '.tt-shell')
            settings(page, frame)
            expect(frame.locator('#ttBackgroundName')).to_have_text('方形背景.png')
            frame.locator('#ttBackgroundFit').select_option('cover')
            frame.get_by_role('button', name='保存设置', exact=True).click()
            expect(frame.locator('#ttBoard')).to_have_attribute('data-background-fit', 'cover')
            settings(page, frame)
            frame.locator('#ttBackgroundFit').select_option('contain')
            frame.get_by_role('button', name='保存设置', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()

            # Rest rows align across all weekdays without changing period numbers.
            expect(frame.locator('.tt-rest-label')).to_have_text(['午休', '晚休'])
            for day in range(1, 8):
                column = frame.locator('.tt-day-column').nth(day - 1)
                for period, label in [(4, '午休'), (8, '晚休')]:
                    above = column.locator(f'.tt-cell[data-period="{period}"]').bounding_box()
                    below = column.locator(f'.tt-cell[data-period="{period + 1}"]').bounding_box()
                    rest = column.locator(f'.tt-rest[data-rest-after="{period}"]').bounding_box()
                    assert rest is not None, column.evaluate("n=>[...n.children].map(c=>({cls:c.className,rest:c.dataset.restAfter,display:getComputedStyle(c).display,rect:c.getBoundingClientRect().toJSON()}))")
                    assert abs(above['y'] + above['height'] - rest['y']) <= 1
                    assert abs(rest['y'] + rest['height'] - below['y']) <= 1
            frame.locator('[data-tt-action="add"]').first.click()
            frame.locator('#ttCourseName').fill('程序设计')
            frame.locator('#ttCourseRoom').fill('理论教室 A-201')
            frame.locator('#ttCourseDay').select_option('1')
            frame.locator('#ttCourseWeeks').fill('1-4')
            frame.locator('#ttCourseCustomColor').fill('#123456')
            expect(frame.locator('[name="ttCourseColor"][value="custom"]')).to_be_checked()
            frame.locator('[data-tt-action="add-arrangement"]').click()
            extra = frame.locator('.tt-extra-arrangement').last
            extra.locator('[data-schedule="room"]').fill('实验机房 B-305')
            extra.locator('[data-schedule="day"]').select_option('3')
            extra.locator('[data-schedule="start"]').select_option('5')
            extra.locator('[data-schedule="end"]').select_option('6')
            extra.locator('[data-schedule="weeks"]').fill('1-4')
            page.screenshot(path=str(OUT / 'course-arrangements.png'))
            frame.get_by_role('button', name='保存课程', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()
            records = saved(page)['semester']['courses']
            assert len(records) == 2 and records[0]['color'] == records[1]['color'] == '#123456'
            assert {r['room'] for r in records} == {'理论教室 A-201', '实验机房 B-305'}
            expect(frame.locator('.tt-course')).to_have_count(2)
            assert frame.locator('.tt-course').first.evaluate('n=>getComputedStyle(n).backgroundColor') == 'rgb(18, 52, 86)'
            frame.locator('.tt-course').first.click()
            expect(frame.locator('#ttCourseCustomColor')).to_have_value('#123456')
            frame.locator('[data-tt-action="close"]').first.click()

            # An invalid second arrangement must not partially save the first.
            frame.locator('[data-tt-action="add"]').first.click()
            frame.locator('#ttCourseName').fill('冲突检测')
            frame.locator('#ttCourseDay').select_option('2')
            frame.locator('[data-tt-action="add-arrangement"]').click()
            frame.locator('.tt-extra-arrangement [data-schedule="day"]').select_option('1')
            frame.get_by_role('button', name='保存课程', exact=True).click()
            expect(frame.locator('#ttPanelNotice')).to_contain_text('冲突')
            assert len(saved(page)['semester']['courses']) == 2
            frame.locator('[data-tt-action="remove-arrangement"]').click()
            expect(frame.locator('.tt-extra-arrangement')).to_have_count(0)
            frame.locator('[data-tt-action="close"]').first.click()
            # A long arrangement never covers the lunch/evening labels.
            frame.locator('[data-tt-action="add"]').first.click()
            frame.locator('#ttCourseName').fill('跨时段实训')
            frame.locator('#ttCourseDay').select_option('4')
            frame.locator('#ttCourseStart').select_option('3')
            frame.locator('#ttCourseEnd').select_option('10')
            frame.locator('#ttCourseWeeks').fill('1-4')
            frame.get_by_role('button', name='保存课程', exact=True).click()
            expect(frame.locator('#ttDialog')).not_to_be_visible()
            pieces = frame.locator('.tt-course').filter(has_text='跨时段实训')
            expect(pieces).to_have_count(3)
            column = frame.locator('.tt-day-column').nth(3)
            for rest in column.locator('.tt-rest').all():
                rbox = rest.bounding_box()
                for piece in pieces.all():
                    pbox = piece.bounding_box()
                    assert pbox['y'] + pbox['height'] <= rbox['y'] or pbox['y'] >= rbox['y'] + rbox['height']
            settings(page, frame)
            frame.locator('[data-tab="basic"]').click()
            frame.locator('#ttShowOther').check()
            frame.get_by_role('button', name='保存设置', exact=True).click()
            frame.locator('#ttWeek').select_option('5')
            expect(frame.locator('.tt-course.is-other-week')).to_have_count(5)
            for card in frame.locator('.tt-course.is-other-week').all():
                assert card.evaluate('n=>getComputedStyle(n).backgroundColor') == 'rgb(255, 255, 255)'
                assert card.evaluate('n=>getComputedStyle(n).color') == 'rgb(107, 114, 128)'
            page.screenshot(path=str(OUT / 'other-week.png'))
            # Export exercises custom palettes, rest offsets, and image fitting.
            settings(page, frame)
            frame.locator('[data-tab="transfer"]').click()
            with page.expect_download() as download:
                frame.locator('[data-tt-action="export-png"]').click()
            download.value.save_as(str(OUT / 'week.png'))
            assert (OUT / 'week.png').read_bytes().startswith(b'\x89PNG')
            frame.locator('[data-tt-action="close"]').first.click()
            frame.locator('#ttWeek').select_option('1')
            # The current-week export must also accept the custom colour.
            settings(page, frame)
            frame.locator('[data-tab="transfer"]').click()
            with page.expect_download() as download:
                frame.locator('[data-tt-action="export-png"]').click()
            download.value.save_as(str(OUT / 'current-week.png'))
            frame.locator('[data-tt-action="close"]').first.click()
            page.screenshot(path=str(OUT / 'timetable.png'))
            for width, height in [(1536, 800), (1000, 700), (390, 700)]:
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                expect(frame.locator('.tt-rest-label')).to_have_count(2)
            assert not errors, errors
        except Exception:
            page.screenshot(path=str(OUT / 'failure.png'))
            raise
        finally:
            context.close()
            browser.close()


if __name__ == '__main__':
    with multi.production_url() as base:
        run(base, '--baseline' in sys.argv)
    print('PASS: timetable background and course improvements' if '--baseline' not in sys.argv else 'Background problems reproduced')
