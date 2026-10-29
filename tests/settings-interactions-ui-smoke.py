"""Settings interaction regression with local IPC fixtures and no native app.

Build first with npm run build. --baseline only captures the existing workspace.
"""

import ast
import importlib.util
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

spec = importlib.util.spec_from_file_location("multi_page", Path(__file__).with_name("multi-page-ui-smoke.py"))
multi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(multi)
ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / ".tmp" / "settings-interactions-ui"
fixture_tree = ast.parse(Path(__file__).with_name("settings-ui-smoke.py").read_text(encoding="utf-8"))
SETTINGS_MOCK = next(node.value for node in ast.walk(fixture_tree)
                     if isinstance(node, ast.Constant) and isinstance(node.value, str)
                     and "window.__cleanupStatus =" in node.value)
INTERACTION_MOCK = r"""(() => {
  localStorage.removeItem('dtkit_tool_workspace_v1');
  localStorage.setItem('dtkit_minimize_mode','efficient');
  const original = window.__TAURI__.core.invoke;
  const holds = new Map();
  window.__settingsCalls = [];
  window.__settingsHold = command => holds.set(command, []);
  window.__settingsPending = command => holds.get(command)?.length || 0;
  window.__settingsRelease = (command, response = {}) => {
    const pending = holds.get(command)?.shift();
    if (!pending) throw new Error('No held settings request: ' + command);
    if (!holds.get(command).length && !response.keepHold) holds.delete(command);
    response.error ? pending.reject(new Error(response.error)) : pending.resolve(response);
  };
  window.__TAURI__.core.invoke = async (command, args = {}) => {
    window.__settingsCalls.push({command, args: structuredClone(args)});
    if (holds.has(command)) {
      const response = await new Promise((resolve, reject) => holds.get(command).push({resolve,reject}));
      if ('result' in response) return response.result;
    }
    if (command === 'get_tool_module_settings') return window.__settingsDisabled || [];
    if (command === 'get_storage_layout') return {root:'D:\\DtKit',downloads:'D:\\DtKit\\Downloads',writable:true,warning:null};
    if (command === 'set_tool_module_enabled') {
      const disabled = new Set(window.__settingsDisabled || []);
      args.enabled ? disabled.delete(args.toolId) : disabled.add(args.toolId);
      return window.__settingsDisabled = [...disabled];
    }
    if (command === 'get_password_settings') return {clipboardClearSeconds:window.__settingsPasswordSeconds ?? 30};
    if (command === 'set_password_settings') {
      window.__settingsPasswordSeconds = args.settings.clipboardClearSeconds;
      return args.settings;
    }
    return structuredClone(await original(command, args));
  };
  const fetch = window.fetch.bind(window);
  window.fetch = (input, options) => String(input).includes('api.github.com/repos/XiaoZhenYa001/Dtkit/releases/latest')
    ? Promise.resolve(new Response(JSON.stringify({tag_name:'v0.2.12',name:'Current release'}),{status:200,headers:{'Content-Type':'application/json'}}))
    : fetch(input, options);
})();
"""


def new_page(context, base_url, errors, holds=()):
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base_url, wait_until="networkidle")
    for command in holds:
        page.evaluate("command => window.__settingsHold(command)", command)
    page.locator('[data-view="settings"]').click()
    expect(page.locator("#settingsView.view--active")).to_be_visible()
    expect(page.locator(".settings-side-nav__item")).to_have_count(6)
    return page


def pending(page, command):
    page.wait_for_function("command => window.__settingsPending(command) > 0", arg=command)


def release(page, command, **response):
    page.evaluate("({command,response}) => window.__settingsRelease(command,response)", {"command": command, "response": response})


def navigate(page, target, keyboard=False):
    link = page.locator(f'.settings-side-nav__item[href="#{target}"]')
    if keyboard:
        link.focus()
        link.press("Enter")
    else:
        link.click()
    expect(link).to_have_attribute("aria-current", "true")


def assert_no_overflow(page):
    metrics = page.evaluate("""() => ({width:document.documentElement.clientWidth,
      document:document.documentElement.scrollWidth,body:document.body.scrollWidth})""")
    assert max(metrics["document"], metrics["body"]) <= metrics["width"] + 1, metrics


def surface_color(locator):
    return locator.evaluate("""node=>{
      for(let current=node;current;current=current.parentElement){
        const color=getComputedStyle(current).backgroundColor;
        if(color!=='transparent'&&color!=='rgba(0, 0, 0, 0)')return color;
      }
      return 'transparent';
    }""")


def assert_readable(locator):
    foreground=locator.evaluate("node=>getComputedStyle(node).color")
    background=surface_color(locator)
    def luminance(color):
        assert color.startswith("rgb"),color
        components=[float(value)/255 for value in re.findall(r"[\d.]+",color)[:3]]
        linear=[value/12.92 if value<=.04045 else ((value+.055)/1.055)**2.4 for value in components]
        return .2126*linear[0]+.7152*linear[1]+.0722*linear[2]
    values=sorted([luminance(foreground),luminance(background)])
    assert (values[1]+.05)/(values[0]+.05)>=4.5,(foreground,background)


def capture_baseline(context, base_url, errors):
    page = new_page(context, base_url, errors)
    page.screenshot(path=str(ARTIFACTS / "baseline-storage.png"))
    navigate(page, "generalSection")
    page.wait_for_timeout(500)
    page.screenshot(path=str(ARTIFACTS / "baseline-general.png"))
    page.close()


def test_navigation(context, base_url, errors):
    page = new_page(context, base_url, errors)
    for target in ("generalSection", "shortcutsSection", "desktopSection", "storageSection"):
        navigate(page, target)
    page.wait_for_function("""() => {
      const section=document.querySelector('#storageSection .settings-section-header').getBoundingClientRect();
      const viewport=document.querySelector('.content-area').getBoundingClientRect();
      return section.top >= viewport.top-1 && section.bottom <= viewport.bottom+1;
    }""")
    navigate(page, "generalSection", keyboard=True)
    assert page.locator("#generalSection").evaluate("node => node.contains(document.activeElement)")
    page.locator(".content-area").evaluate("node => { node.scrollTop=0; }")
    expect(page.locator('.settings-side-nav__item[href="#storageSection"]')).to_have_attribute("aria-current", "true")
    page.emulate_media(reduced_motion="no-preference")
    navigate(page,"generalSection")
    # A completion event from an interrupted, older scroll must not clear the
    # newest navigation target. User input must still interrupt immediately.
    page.locator(".content-area").dispatch_event("scrollend")
    page.wait_for_timeout(40)
    expect(page.locator('.settings-side-nav__item[href="#generalSection"]')).to_have_attribute("aria-current","true")
    page.locator(".content-area").hover()
    page.mouse.wheel(0,-10000)
    expect(page.locator('.settings-side-nav__item[href="#storageSection"]')).to_have_attribute("aria-current","true")
    page.close()


def test_password_feedback(context, base_url, errors):
    page = new_page(context, base_url, errors, ("get_password_settings",))
    pending(page, "get_password_settings")
    release(page, "get_password_settings", error="Temporary settings read failure")
    navigate(page, "generalSection", keyboard=True)
    expect(page.locator("#settingsPasswordRetry")).to_be_visible()
    page.locator("#settingsPasswordRetry").click()
    expect(page.locator("#settingsPasswordClipboardTime")).to_be_enabled()
    expect(page.locator("#settingsPasswordRetry")).to_be_hidden()
    page.evaluate("window.__settingsHold('set_password_settings')")
    page.locator("#settingsPasswordClipboardTime").select_option("60")
    pending(page, "set_password_settings")
    expect(page.locator("#settingsPasswordClipboardTime")).to_be_disabled()
    expect(page.locator("#settingsPasswordClipboardStatus")).to_contain_text("正在保存")
    release(page, "set_password_settings", error="Save rejected for regression test")
    expect(page.locator("#settingsPasswordClipboardTime")).to_be_enabled()
    expect(page.locator("#settingsPasswordClipboardTime")).to_have_value("30")
    expect(page.locator("#settingsPasswordClipboardStatus")).to_contain_text("保存失败")
    page.locator("#settingsPasswordClipboardTime").select_option("15")
    expect(page.locator("#settingsPasswordClipboardStatus")).to_have_attribute("data-tone", "success")
    page.close()


def test_storage_migration(context, base_url, errors):
    page=new_page(context,base_url,errors,("get_storage_layout",))
    pending(page,"get_storage_layout")
    # The shell and editable draft must be available before the IPC read ends.
    expect(page.locator("#downloadPathInput")).to_be_enabled()
    draft=r"D:\Draft\Keep my chosen folder"
    page.locator("#downloadPathInput").fill(draft)
    release(page,"get_storage_layout")
    expect(page.locator("#storageRootStatus")).not_to_contain_text("正在读取")
    expect(page.locator("#downloadPathInput")).to_have_value(draft)
    page.evaluate("window.__settingsHold('migrate_storage_root')")
    page.locator("#downloadPathInput").press("Enter")
    pending(page,"migrate_storage_root")
    page.locator("#downloadPathInput").evaluate("""node => {
      for(let i=0;i<3;i++)node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    }""")
    assert page.evaluate("window.__settingsCalls.filter(call=>call.command==='migrate_storage_root').length") == 1
    expect(page.locator("#changeDownloadPathBtn")).to_be_disabled()
    release(page,"migrate_storage_root",error="Fixture rejection <img src=x onerror=alert(1)>")
    expect(page.locator("#changeDownloadPathBtn")).to_be_enabled()
    expect(page.locator("#downloadPathInput")).to_have_value(draft)
    expect(page.locator("#storageRootStatus")).to_contain_text("失败")
    expect(page.locator("#storageRootStatus img")).to_have_count(0)
    page.locator("#changeDownloadPathBtn").click()
    expect(page.locator("#storageRootStatus")).to_contain_text("目录可用")
    assert page.evaluate("window.__settingsCalls.filter(call=>call.command==='migrate_storage_root').at(-1).args.targetRoot") == draft
    page.close()


def test_modal_motion(context,base_url,errors):
    page=new_page(context,base_url,errors)
    page.emulate_media(reduced_motion="no-preference")
    navigate(page,"desktopSection",keyboard=True)
    toggle=page.locator("#desktopOrganizerToggle")
    toggle.check()
    dialog=page.locator("#desktopOrganizerConfirmDialog")
    expect(dialog).to_have_attribute("aria-hidden","false")
    frames=dialog.evaluate("node=>node.getAnimations({subtree:true}).flatMap(animation=>animation.effect.getKeyframes())")
    assert any("transform" in frame for frame in frames),frames
    # Tab must never escape into the settings beneath the dialog.
    for _ in range(6):
        page.keyboard.press("Tab")
        assert dialog.evaluate("node=>node.contains(document.activeElement)")
    page.locator("#cancelDesktopOrganizer").click()
    expect(dialog).to_have_attribute("aria-hidden","true")
    expect(toggle).not_to_be_checked()
    # A quick reopen while the first visual exit is pending must stay open.
    toggle.check()
    expect(dialog).to_have_attribute("aria-hidden","false")
    page.wait_for_timeout(240)
    expect(dialog).to_be_visible()
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    expect(toggle).not_to_be_checked()
    expect(toggle).to_be_focused()
    page.emulate_media(reduced_motion="reduce")
    toggle.check()
    frames=dialog.evaluate("node=>node.getAnimations({subtree:true}).flatMap(animation=>animation.effect.getKeyframes())")
    assert all(frame.get("transform","none") == "none" for frame in frames),frames
    page.locator("#cancelDesktopOrganizer").click()
    expect(dialog).to_be_hidden()
    page.close()


def test_disclosure_motion(context,base_url,errors):
    page=new_page(context,base_url,errors)
    page.emulate_media(reduced_motion="no-preference")
    navigate(page,"toolModulesSection",keyboard=True)
    button=page.locator("#toolModulesCollapse")
    if button.get_attribute("aria-expanded") == "true":
        button.focus();button.press("Enter")
        expect(page.locator("#toolModulesContent")).to_be_hidden()
    button.click()
    shell=page.locator(".settings-disclosure-shell")
    frames=shell.evaluate("node=>node.getAnimations().flatMap(animation=>animation.effect.getKeyframes())")
    assert any("height" in frame for frame in frames),frames
    button.click();button.click()
    expect(button).to_have_attribute("aria-expanded","true")
    page.wait_for_timeout(280)
    expect(page.locator("#toolModulesContent")).to_be_visible()
    page.locator("#toolModuleSearch").focus()
    button.evaluate("node=>node.click()")
    expect(button).to_be_focused()
    expect(page.locator("#toolModulesContent")).to_be_hidden()
    page.close()


def test_minimize_save(context,base_url,errors):
    page=new_page(context,base_url,errors)
    navigate(page,"generalSection",keyboard=True)
    page.evaluate("window.__settingsHold('set_minimize_mode')")
    page.locator('input[name="minimizeMode"][value="deep"]').check()
    pending(page,"set_minimize_mode")
    expect(page.locator("#minimizeModeStatus")).to_contain_text("保存")
    assert page.evaluate("localStorage.getItem('dtkit_minimize_mode')") == "efficient"
    release(page,"set_minimize_mode",error="Fixture native save failure")
    expect(page.locator('input[name="minimizeMode"][value="efficient"]')).to_be_checked()
    expect(page.locator("#minimizeModeStatus")).to_contain_text("失败")
    assert page.evaluate("localStorage.getItem('dtkit_minimize_mode')") == "efficient"
    page.locator('input[name="minimizeMode"][value="standard"]').check()
    expect(page.locator("#minimizeModeStatus")).to_contain_text("已保存")
    assert page.evaluate("localStorage.getItem('dtkit_minimize_mode')") == "standard"
    page.close()


def test_cleanup_drafts(context,base_url,errors):
    page=new_page(context,base_url,errors)
    cache=page.locator("#cleanupCacheRetention")
    logs=page.locator("#cleanupLogRetention")
    expect(cache).to_be_enabled()
    page.evaluate("window.__settingsHold('set_cleanup_retention_days')")
    cache.fill("14");cache.press("Tab")
    pending(page,"set_cleanup_retention_days")
    logs.fill("30");logs.press("Tab")
    release(page,"set_cleanup_retention_days",keepHold=True)
    pending(page,"set_cleanup_retention_days")
    expect(cache).to_have_value("14");expect(logs).to_have_value("30")
    release(page,"set_cleanup_retention_days")
    expect(page.locator("#cleanupPolicyHint")).to_contain_text("30")
    requests=page.evaluate("window.__settingsCalls.filter(call=>call.command==='set_cleanup_retention_days').map(call=>call.args)")
    assert requests[-1] == {"cacheDays":14,"logDays":30},requests
    page.evaluate("window.__settingsHold('set_cleanup_retention_days')")
    cache.fill("21");cache.press("Tab")
    pending(page,"set_cleanup_retention_days")
    release(page,"set_cleanup_retention_days",error="Fixture retention save failure")
    expect(page.locator("#cleanupStatus")).to_contain_text("失败")
    expect(cache).to_have_value("21")
    page.locator("#refreshCleanupUsage").click()
    expect(page.locator("#cleanupStatus")).to_contain_text("失败")
    expect(cache).to_have_value("21")
    page.close()


def test_module_feedback(context,base_url,errors):
    page=new_page(context,base_url,errors)
    navigate(page,"toolModulesSection",keyboard=True)
    disclosure=page.locator("#toolModulesCollapse")
    if disclosure.get_attribute("aria-expanded") == "false":disclosure.click()
    search=page.locator("#toolModuleSearch")
    search.fill("URL 编码")
    target=page.locator('#toolModuleList input[data-tool-id="url-encoder"]')
    expect(target).to_be_checked()
    page.evaluate("window.__settingsHold('set_tool_module_enabled')")
    target.uncheck();pending(page,"set_tool_module_enabled")
    search.fill("");search.fill("URL 编码")
    expect(target).to_be_disabled()
    assert page.evaluate("window.__settingsCalls.filter(call=>call.command==='set_tool_module_enabled').length") == 1
    release(page,"set_tool_module_enabled")
    expect(target).to_be_enabled();expect(target).not_to_be_checked()
    expect(search).to_be_focused()
    expect(page.locator("#toolModuleStatus")).to_contain_text("停用")
    target.check()
    expect(page.locator("#toolModuleStatus")).to_contain_text("启用")
    expect(target).to_be_checked()
    expect(target).to_be_focused()
    disclosure.click()
    expect(disclosure).to_have_attribute("aria-expanded","false")
    expect(page.locator("#toolModulesContent")).to_be_hidden()
    page.close()


def test_layout(context, base_url, errors):
    page = new_page(context, base_url, errors)
    for width, height in ((1366, 900), (900, 800), (760, 800), (390, 844)):
        page.set_viewport_size({"width":width,"height":height})
        colors={}
        for scheme in ("light", "dark"):
            page.emulate_media(color_scheme=scheme)
            page.locator(".content-area").evaluate("node=>node.scrollTo({top:0,behavior:'instant'})")
            page.evaluate("document.activeElement?.blur()")
            page.screenshot(path=str(ARTIFACTS / f"workspace-{scheme}-{width}.png"))
            navigate(page, "storageSection", keyboard=True)
            assert_no_overflow(page)
            colors[scheme]=surface_color(page.locator("#downloadPathInput"))
            assert_readable(page.locator("#storageRootStatus span"))
            page.screenshot(path=str(ARTIFACTS / f"storage-{scheme}-{width}.png"))
            navigate(page, "generalSection", keyboard=True)
            assert_no_overflow(page)
            expect(page.locator("#checkUpdateButton")).to_be_visible()
            assert_readable(page.locator("#generalSection .settings-item-desc").first)
            for field in page.locator("#generalSection .settings-toggle-input:disabled").all():
                expect(field).to_have_css("opacity","0")
            page.screenshot(path=str(ARTIFACTS / f"general-{scheme}-{width}.png"))
        assert colors["light"] != colors["dark"],colors
        page.emulate_media(color_scheme="dark")
        page.evaluate("document.documentElement.dataset.theme='light'")
        assert surface_color(page.locator("#downloadPathInput")) == colors["light"]
        page.evaluate("delete document.documentElement.dataset.theme")
    page.close()


def record_demo(context,base_url,errors):
    page=new_page(context,base_url,errors)
    page.emulate_media(reduced_motion="no-preference")
    video=page.video
    page.wait_for_timeout(650)
    navigate(page,"toolModulesSection")
    page.wait_for_timeout(650)
    button=page.locator("#toolModulesCollapse")
    if button.get_attribute("aria-expanded") == "false":button.click()
    page.wait_for_timeout(650)
    page.locator("#toolModuleSearch").fill("URL")
    page.wait_for_timeout(600)
    button.click()
    page.wait_for_timeout(450)
    navigate(page,"generalSection")
    page.wait_for_timeout(650)
    page.locator('input[name="minimizeMode"][value="standard"]').check()
    page.wait_for_timeout(650)
    navigate(page,"desktopSection")
    page.wait_for_timeout(650)
    page.locator("#desktopOrganizerToggle").check()
    page.wait_for_timeout(700)
    page.locator("#cancelDesktopOrganizer").click()
    page.wait_for_timeout(650)
    page.close()
    video.save_as(str(ARTIFACTS/"settings-motion-demo.webm"))


def test_autostart_feedback(context, base_url, errors):
    page = new_page(context, base_url, errors, ("get_autostart_status",))
    toggle = page.locator('#autostartEnabled')
    status = page.locator('#autostartStatus')
    retry = page.locator('#autostartRetry')
    remove = page.locator('#autostartRemove')
    pending(page, 'get_autostart_status')
    expect(toggle).to_be_disabled()
    expect(status).to_contain_text('正在读取')
    release(page, 'get_autostart_status', result={
        'available': True, 'enabled': False, 'registered': False, 'warning': None
    })
    expect(toggle).to_be_enabled()
    expect(toggle).not_to_be_checked()

    page.evaluate("window.__settingsHold('set_autostart_enabled')")
    toggle.check()
    pending(page, 'set_autostart_enabled')
    expect(toggle).to_be_disabled()
    expect(status).to_contain_text('正在登记')
    release(page, 'set_autostart_enabled', error='fixture save failure')
    expect(toggle).to_be_disabled()
    expect(toggle).not_to_be_checked()
    expect(retry).to_be_visible()
    expect(status).to_contain_text('未能确认')

    retry.click()
    expect(toggle).to_be_enabled()
    page.evaluate("window.__settingsHold('set_autostart_enabled')")
    toggle.check()
    pending(page, 'set_autostart_enabled')
    release(page, 'set_autostart_enabled', result={
        'available': True, 'enabled': False, 'registered': True,
        'warning': '已登记，但被 Windows 的启动应用禁用'
    })
    expect(toggle).not_to_be_checked()
    expect(remove).to_be_visible()
    expect(status).to_contain_text('Windows')
    remove.click()
    expect(remove).to_be_hidden()
    expect(toggle).to_be_enabled()
    expect(status).to_contain_text('已关闭')

    toggle.check()
    expect(toggle).to_be_checked()
    expect(status).to_contain_text('已开启')
    toggle.uncheck()
    expect(toggle).not_to_be_checked()
    expect(status).to_contain_text('已关闭')

    page.evaluate("window.__settingsHold('get_autostart_status'); window.dispatchEvent(new Event('focus'))")
    pending(page, 'get_autostart_status')
    release(page, 'get_autostart_status', result={
        'available': False, 'enabled': False, 'registered': True,
        'warning': '程序路径过长，无法重新登记'
    })
    expect(toggle).to_be_disabled()
    expect(remove).to_be_visible()
    page.evaluate("window.__settingsHold('set_autostart_enabled')")
    remove.click()
    pending(page, 'set_autostart_enabled')
    release(page, 'set_autostart_enabled', result={
        'available': False, 'enabled': False, 'registered': False,
        'warning': '程序路径过长，无法重新登记'
    })
    expect(remove).to_be_hidden()
    expect(toggle).to_be_disabled()

    page.evaluate("window.__settingsHold('get_autostart_status'); window.dispatchEvent(new Event('focus'))")
    pending(page, 'get_autostart_status')
    release(page, 'get_autostart_status', result={
        'available': False, 'enabled': False, 'registered': False,
        'warning': '同名启动项包含其他内容'
    })
    expect(toggle).to_be_disabled()
    expect(status).to_contain_text('同名')
    assert_no_overflow(page)
    page.close()


def run(base_url):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    errors=[]
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        recording={"record_video_dir":str(ARTIFACTS/"video"),"record_video_size":{"width":1366,"height":900}} if "--record-demo" in sys.argv else {}
        context=browser.new_context(viewport={"width":1366,"height":900},color_scheme="light",reduced_motion="reduce",**recording)
        context.add_init_script(SETTINGS_MOCK)
        context.add_init_script(INTERACTION_MOCK)
        try:
            if "--baseline" in sys.argv:
                capture_baseline(context,base_url,errors)
                return
            if "--record-demo" in sys.argv:
                record_demo(context,base_url,errors)
                assert not errors,errors
                print(f"Settings motion demo={ARTIFACTS/'settings-motion-demo.webm'}",flush=True)
                return
            print("Settings: rapid navigation and keyboard positioning",flush=True)
            test_navigation(context,base_url,errors)
            print("Settings: password load retry and pending/error/saved feedback",flush=True)
            test_password_feedback(context,base_url,errors)
            print("Settings: visible shell during loading, draft preservation and migration deduplication",flush=True)
            test_storage_migration(context,base_url,errors)
            print("Settings: modal focus, interrupted exit and keyboard dismissal",flush=True)
            test_modal_motion(context,base_url,errors)
            print("Settings: minimize saving commits only after native success",flush=True)
            test_minimize_save(context,base_url,errors)
            print("Settings: cleanup latest drafts and persistent failure feedback",flush=True)
            test_cleanup_drafts(context,base_url,errors)
            print("Settings: module pending state survives filtering and retains focus",flush=True)
            test_module_feedback(context,base_url,errors)
            print("Settings: disclosure motion interrupts and restores focus",flush=True)
            test_disclosure_motion(context,base_url,errors)
            print("Settings: autostart loading, save failure, Windows-disabled, moved path and foreign registration",flush=True)
            test_autostart_feedback(context,base_url,errors)
            print("Settings: narrow and wide light/dark layouts",flush=True)
            test_layout(context,base_url,errors)
            assert not errors,errors
        except Exception:
            for index,page in enumerate(context.pages):
                page.screenshot(path=str(ARTIFACTS / f"failure-{index}.png"),full_page=True)
            raise
        finally:
            context.close();browser.close()
    print(f"Settings interactions passed; screenshots={ARTIFACTS}",flush=True)


if __name__ == "__main__":
    with multi.production_url() as base_url:
        run(base_url)
