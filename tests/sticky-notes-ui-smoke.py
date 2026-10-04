"""Browser behavior with a deterministic IPC mock; native windows are tested separately."""

import functools
import http.server
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
NOTE_ID = "11111111-1111-4111-8111-111111111111"
SECOND_ID = "22222222-2222-4222-8222-222222222222"
SCREENSHOTS = Path(tempfile.gettempdir())
MOCK = r"""
window.__noteCalls = [];
window.__noteItems = [];
window.__noteListeners = {};
window.__noteFailure = {};
window.__holdNoteSaves = false;
window.__pendingNoteSaves = [];
window.__nextNoteNumber = 1;
window.__notesEmit = (id) => {
    for (const callback of window.__noteListeners['sticky-notes-changed'] || []) {
        callback({payload:{id}});
    }
};
window.__notesSet = (items) => {
    window.__noteItems = structuredClone(items);
    window.__notesEmit(items[0]?.id || '');
};
window.__notesUpdate = (id, changes) => {
    window.__noteItems = window.__noteItems.map(note => note.id === id ? {...note,...changes} : note);
    window.__notesEmit(id);
};
window.__note = (overrides = {}) => ({
    id:'11111111-1111-4111-8111-111111111111', title:'购物清单', content:'牛奶\n苹果',
    color:'yellow', pinned:true, createdAt:Date.now(), updatedAt:Date.now(),
    revision:1, trashedAt:null, opened:false, ...overrides
});
window.__commitNoteSave = (draft) => {
    if (window.__noteFailure.save_sticky_note) throw window.__noteFailure.save_sticky_note;
    const current = window.__noteItems.find(note => note.id === draft.id);
    if (!current) throw '便签不存在';
    if (current.revision !== draft.revision) throw '便签已在其他位置修改，请重新加载';
    const saved = {...current,...draft,revision:current.revision + 1,updatedAt:Date.now()};
    window.__notesUpdate(draft.id,saved);
    return structuredClone(saved);
};
window.__releaseNoteSave = () => {
    const pending = window.__pendingNoteSaves.shift();
    if (!pending) throw new Error('No pending save');
    try { pending.resolve(window.__commitNoteSave(pending.draft)); }
    catch (error) { pending.reject(error); }
};
window.__requestNoteClose = () => {
    for (const callback of window.__noteListeners['sticky-note-close-request'] || []) {
        callback({payload:null});
    }
};
window.__TAURI__ = {
    core:{invoke:async (command,args = {}) => {
        window.__noteCalls.push({command,args:structuredClone(args)});
        if (window.__noteFailure[command]) throw window.__noteFailure[command];
        if (command === 'list_sticky_notes') return structuredClone(window.__noteItems);
        if (command === 'get_sticky_note') {
            const note = window.__noteItems.find(item => item.id === args.id);
            if (!note) throw '便签不存在';
            return structuredClone(note);
        }
        if (command === 'create_sticky_note') {
            const serial = String(window.__nextNoteNumber++).padStart(12,'0');
            const note = window.__note({id:`aaaaaaaa-aaaa-4aaa-8aaa-${serial}`,title:'',content:''});
            window.__noteItems.unshift(note);
            window.__notesEmit(note.id);
            return structuredClone(note);
        }
        if (command === 'open_sticky_note') {
            window.__notesUpdate(args.id,{opened:true});
            return null;
        }
        if (command === 'close_sticky_note') {
            window.__notesUpdate(args.id,{opened:false});
            return null;
        }
        if (command === 'save_sticky_note') {
            const draft = structuredClone(args.draft);
            if (window.__holdNoteSaves) return new Promise((resolve,reject) => {
                window.__pendingNoteSaves.push({draft,resolve,reject});
            });
            return window.__commitNoteSave(draft);
        }
        if (command === 'trash_sticky_note') {
            const note = window.__noteItems.find(item => item.id === args.id);
            if (note?.opened) throw '请先关闭便签窗口';
            window.__notesUpdate(args.id,{trashedAt:Date.now()});
            return null;
        }
        if (command === 'restore_sticky_note') {
            window.__notesUpdate(args.id,{trashedAt:null});
            return null;
        }
        if (command === 'delete_sticky_note') {
            const note = window.__noteItems.find(item => item.id === args.id);
            if (!note?.trashedAt) throw '请先移入回收站';
            window.__noteItems = window.__noteItems.filter(item => item.id !== args.id);
            window.__notesEmit(args.id);
            return null;
        }
        if (['get_tool_module_settings','get_shortcut_bindings','take_missed_alarm_triggers'].includes(command)) return [];
        if (command === 'get_resource_policy') return {minimizeMode:'efficient'};
        return null;
    }},
    event:{listen:async (name,callback) => {
        (window.__noteListeners[name] ||= new Set()).add(callback);
        return () => window.__noteListeners[name].delete(callback);
    }},
    window:{getCurrentWindow:() => ({startDragging:async () => {}})}
};
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def call_count(page, command):
    return page.evaluate("command => window.__noteCalls.filter(call => call.command === command).length", command)


def wait_for_calls(page, command, count):
    page.wait_for_function(
        "({command,count}) => window.__noteCalls.filter(call => call.command === command).length === count",
        arg={"command": command, "count": count},
    )


def note_card(page, note_id):
    return page.locator(f'.notes-card[data-note-id="{note_id}"]')


def open_editor(browser, base_url, errors, *, width=340, height=390):
    page = browser.new_page(viewport={"width": width, "height": height})
    page.add_init_script(MOCK + "\nwindow.__noteItems = [window.__note({opened:true})];")
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{base_url}/sticky-note.html?id={NOTE_ID}", wait_until="networkidle")
    expect(page.locator("#noteTitle")).to_have_value("购物清单")
    expect(page.locator("#noteContent")).to_have_value("牛奶\n苹果")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")
    return page


def test_main_panel(browser, base_url, errors):
    page = browser.new_page(viewport={"width": 1180, "height": 920})
    page.add_init_script(MOCK)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until="networkidle")
    page.locator('[data-tool-id="sticky-notes"] .tool-card__title').click()
    expect(page.locator(".notes-shell")).to_be_visible()
    expect(page.locator(".notes-card")).to_have_count(0)
    expect(page.locator("#notesCreate")).to_be_enabled()

    # Creation is persisted before opening its editor, and an open note cannot be archived.
    page.locator("#notesCreate").click()
    expect(page.locator(".notes-card")).to_have_count(1)
    wait_for_calls(page, "open_sticky_note", 1)
    commands = page.evaluate("window.__noteCalls.map(call => call.command)")
    assert commands.index("create_sticky_note") < commands.index("open_sticky_note")
    expect(page.locator('[data-note-action="trash"]')).to_be_disabled()
    assert page.evaluate("window.__noteItems[0].title === '' && window.__noteItems[0].content === ''")

    page.evaluate(r"""window.__notesSet([
        window.__note({title:'工作 <img src=x onerror=alert(1)>',content:'明天的设计评审'}),
        window.__note({id:'22222222-2222-4222-8222-222222222222',title:'周末',content:'购物牛奶',color:'green'})
    ])""")
    expect(page.locator(".notes-card")).to_have_count(2)
    expect(note_card(page, NOTE_ID)).to_contain_text("工作 <img src=x onerror=alert(1)>")
    assert page.locator(".notes-card img").count() == 0
    assert page.locator(".notes-card input, .notes-card textarea, .notes-card [contenteditable=true]").count() == 0
    page.locator("#notesSearch").fill("设计评审")
    expect(page.locator(".notes-card")).to_have_count(1)
    expect(note_card(page, NOTE_ID)).to_be_visible()
    page.locator("#notesSearch").fill("周末")
    expect(note_card(page, SECOND_ID)).to_be_visible()
    page.locator("#notesSearch").fill("不存在的文字")
    expect(page.locator(".notes-card")).to_have_count(0)
    page.locator("#notesSearch").fill("")
    expect(page.locator(".notes-card")).to_have_count(2)

    # Open errors are visible and do not lose the persisted note.
    page.evaluate("window.__noteFailure.open_sticky_note = '创建便签窗口失败'")
    note_card(page, NOTE_ID).locator('.notes-card__content[data-note-action="open"]').click()
    expect(page.locator("#notesNotice")).to_contain_text("创建便签窗口失败")
    expect(note_card(page, NOTE_ID)).to_be_visible()
    page.evaluate("delete window.__noteFailure.open_sticky_note")

    note_card(page, NOTE_ID).locator('[data-note-action="trash"]').click()
    expect(page.locator(".notes-card")).to_have_count(1)
    page.locator("#notesTrashTab").click()
    expect(note_card(page, NOTE_ID)).to_be_visible()
    note_card(page, NOTE_ID).locator('[data-note-action="restore"]').click()
    expect(page.locator(".notes-card")).to_have_count(0)
    page.locator("#notesActiveTab").click()
    expect(page.locator(".notes-card")).to_have_count(2)
    note_card(page, NOTE_ID).locator('[data-note-action="trash"]').click()
    page.locator("#notesTrashTab").click()
    expect(note_card(page, NOTE_ID)).to_be_visible()
    page.once("dialog", lambda dialog: dialog.dismiss())
    note_card(page, NOTE_ID).locator('[data-note-action="delete"]').click()
    expect(note_card(page, NOTE_ID)).to_be_visible()
    assert call_count(page, "delete_sticky_note") == 0
    page.once("dialog", lambda dialog: dialog.accept())
    note_card(page, NOTE_ID).locator('[data-note-action="delete"]').click()
    expect(page.locator(".notes-card")).to_have_count(0)
    wait_for_calls(page, "delete_sticky_note", 1)
    page.locator("#notesActiveTab").click()

    # Tool navigation releases event subscriptions; reopening refreshes persisted records.
    page.locator('[data-view="toolLibrary"]').click()
    page.wait_for_function("(window.__noteListeners['sticky-notes-changed']?.size || 0) === 0")
    page.locator('[data-tool-id="sticky-notes"] .tool-card__title').click()
    expect(page.locator(".notes-card")).to_have_count(1)
    assert page.evaluate("window.__noteListeners['sticky-notes-changed'].size") == 1
    page.screenshot(path=str(SCREENSHOTS / "dtkit-sticky-notes-page.png"), full_page=True)
    page.set_viewport_size({"width": 700, "height": 850})
    assert page.locator(".notes-shell").evaluate("element => element.scrollWidth <= element.clientWidth + 1")
    page.screenshot(path=str(SCREENSHOTS / "dtkit-sticky-notes-narrow.png"), full_page=True)

    preview = browser.new_page(viewport={"width": 1000, "height": 800})
    preview.goto(base_url, wait_until="networkidle")
    preview.locator('[data-tool-id="sticky-notes"] .tool-card__title').click()
    expect(preview.locator("#notesCreate")).to_be_disabled()
    expect(preview.locator("#notesNotice")).to_contain_text("桌面版")
    preview.close()
    page.close()


def test_editor(browser, base_url, errors):
    page = open_editor(browser, base_url, errors)
    page.locator("#noteTitle").fill("工作 <img src=x onerror=alert(1)>")
    page.locator("#noteContent").fill("第一行\n第二行 <script>alert(1)</script>")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")
    page.wait_for_function("window.__noteItems[0].content.includes('第二行')")
    assert page.locator("img").count() == 0
    page.locator('[data-note-color="blue"]').click()
    page.locator("#notePin").click()
    expect(page.locator("#notePin")).to_have_attribute("aria-pressed", "false")
    page.wait_for_function("window.__noteItems[0].color === 'blue' && !window.__noteItems[0].pinned")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")

    # Delayed acknowledgments must not overwrite edits made while a save was in flight.
    page.evaluate("window.__holdNoteSaves = true")
    page.locator("#noteTitle").fill("首次保存中")
    page.wait_for_function("window.__pendingNoteSaves.length === 1")
    first_revision = page.evaluate("window.__pendingNoteSaves[0].draft.revision")
    page.locator("#noteContent").fill("保存过程中继续输入，不能丢失")
    page.evaluate("window.__releaseNoteSave()")
    page.wait_for_function("window.__pendingNoteSaves.length === 1")
    assert page.evaluate("window.__pendingNoteSaves[0].draft.revision") == first_revision + 1
    assert page.evaluate("window.__pendingNoteSaves[0].draft.content") == "保存过程中继续输入，不能丢失"
    page.evaluate("window.__releaseNoteSave()")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")
    expect(page.locator("#noteContent")).to_have_value("保存过程中继续输入，不能丢失")
    assert page.evaluate("window.__noteItems[0].content") == "保存过程中继续输入，不能丢失"
    page.evaluate("window.__holdNoteSaves = false")
    page.screenshot(path=str(SCREENSHOTS / "dtkit-sticky-note-editor.png"), full_page=True)
    page.set_viewport_size({"width": 260, "height": 240})
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")
    assert page.locator("#noteContent").bounding_box()["height"] > 30
    page.close()


def test_close_safety(browser, base_url, errors):
    page = open_editor(browser, base_url, errors)
    page.evaluate("window.__holdNoteSaves = true")
    page.locator("#noteContent").fill("关闭之前必须确认这段内容已保存")
    page.locator("#noteClose").click()
    page.wait_for_function("window.__pendingNoteSaves.length === 1")
    assert call_count(page, "close_sticky_note") == 0
    page.evaluate("window.__releaseNoteSave()")
    wait_for_calls(page, "close_sticky_note", 1)
    assert page.evaluate("window.__noteItems[0].content") == "关闭之前必须确认这段内容已保存"
    page.close()

    # Native close requests use the same save barrier; failure keeps the draft editable.
    page = open_editor(browser, base_url, errors)
    page.evaluate("window.__noteFailure.save_sticky_note = '磁盘暂时不可写'")
    page.locator("#noteContent").fill("保存失败时保留的草稿")
    page.evaluate("window.__requestNoteClose()")
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "error")
    expect(page.locator("#noteRetry")).to_be_visible()
    expect(page.locator("#noteContent")).to_have_value("保存失败时保留的草稿")
    expect(page.locator("#noteContent")).to_be_editable()
    assert call_count(page, "close_sticky_note") == 0
    page.evaluate("delete window.__noteFailure.save_sticky_note")
    page.locator("#noteRetry").click()
    expect(page.locator("#noteSaveStatus")).to_have_attribute("data-state", "saved")
    assert page.evaluate("window.__noteItems[0].content") == "保存失败时保留的草稿"
    page.locator("#noteClose").click()
    wait_for_calls(page, "close_sticky_note", 1)
    page.close()


handler = functools.partial(QuietHandler, directory=str(ROOT / "dist"))
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page_errors = []
            url = f"http://127.0.0.1:{server.server_port}"
            test_main_panel(browser, url, page_errors)
            test_editor(browser, url, page_errors)
            test_close_safety(browser, url, page_errors)
            assert page_errors == [], page_errors
            print("PASS: note creation/open/search, trash/restore/delete confirmation, escaped text, listener cleanup, browser fallback, autosave/pin/color, save race, close barrier, error recovery, narrow layout")
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
