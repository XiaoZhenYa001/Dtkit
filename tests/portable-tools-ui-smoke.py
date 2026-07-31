from playwright.sync_api import sync_playwright

MOCK = r"""
(() => {
  const calls = [];
  const snippets = [
    {id:'s1',title:'常用回复',content:'您好，问题已经处理完成。',tags:['回复'],pinned:true,createdAt:1,updatedAt:2},
    {id:'s2',title:'Git 命令',content:'git status --short',tags:['开发'],pinned:false,createdAt:1,updatedAt:1}
  ];
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XoMcWQAAAABJRU5ErkJggg==';
  window.__dtkitCalls = calls;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    if (String(input).includes('api.github.com/repos/XiaoZhenYa001/Dtkit/releases/latest')) {
      calls.push({command:'github_latest_release',args:{}});
      return new Response(JSON.stringify({tag_name:'v0.3.0',name:'DtKit 0.3.0'}), {status:200,headers:{'Content-Type':'application/json'}});
    }
    return nativeFetch(input, options);
  };
  window.__TAURI__ = {
    core: { invoke: async (command, args = {}) => {
      calls.push({command,args});
      if (command === 'get_storage_layout') return {root:'D:\\DtKit',downloads:'D:\\DtKit\\Downloads',writable:true,warning:null};
      if (command === 'get_tool_module_settings') return [];
      if (command === 'set_tool_module_enabled') return args.enabled ? [] : [args.toolId];
      if (command === 'get_shortcut_bindings') return [];
      if (command === 'replace_shortcut_bindings') return args.bindings || [];
      if (command === 'search_snippets') return {items:snippets,total:2,truncated:false};
      if (command === 'save_snippet') return snippets[0];
      if (command === 'capture_screen_for_annotation') return {dataUrl:pixel,width:640,height:360};
      if (command === 'get_lan_share') return null;
      if (command === 'list_transfer_items') return [];
      if (command === 'get_resource_policy') return {minimizeMode:'efficient',maxConcurrentJobs:2,quickHostRetentionSeconds:0};
      if (command === 'get_cleanup_status') return {usage:{cacheBytes:0,logBytes:0,recoveryBytes:0},policy:{enabled:false,cacheRetentionDays:7,logRetentionDays:7},latestRecoveryBatch:null};
      if (command === 'get_password_settings') return {clipboardClearSeconds:30};
      if (command === 'get_hotzone_status') return false;
      return null;
    }},
    dialog: {open: async () => null},
    event: {listen: async () => () => {}},
    window: {getCurrentWindow: () => ({toggleMaximize: async () => {}})}
  };
})();
"""

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1360, "height": 880})
        page.add_init_script(MOCK)
        page.goto("http://127.0.0.1:9005", wait_until="networkidle")

        page.locator('[data-tool-id="text-snippets"]').click()
        page.locator(".snippet-shell").wait_for()
        page.locator(".snippet-row").first.wait_for()
        assert page.locator(".snippet-row").count() == 2
        assert page.locator("#snippetTagStrip button").count() == 2
        page.locator(".snippet-row").first.click()
        assert page.locator(".snippet-row").first.get_attribute("aria-selected") == "true"
        page.locator("#snippetAdd").click()
        page.locator("#snippetTitle").fill("不会保存")
        page.locator("#snippetContent").fill("取消编辑")
        page.locator("#snippetEditorCancel").click()
        assert not page.locator("#snippetEditor").is_visible()
        assert not page.evaluate("window.__dtkitCalls.some(c => c.command === 'save_snippet')")

        # Side navigation is part of the same per-tab browser history.
        page.locator('[data-view="favorites"]').click()
        page.locator("#favoritesView.view--active").wait_for()
        page.locator("#backBtn").click()
        page.locator(".snippet-shell").wait_for()
        page.locator("#backBtn").click()
        page.locator("#toolLibraryView.view--active").wait_for()
        page.locator("#forwardBtn").click()
        page.locator(".snippet-shell").wait_for()
        page.screenshot(path="C:/tmp/dtkit-snippets-detail.png", full_page=True)

        page.locator('[data-view="toolLibrary"]').click()
        capture_calls = page.evaluate("window.__dtkitCalls.filter(c => c.command === 'capture_screen_for_annotation').length")
        page.locator('[data-tool-id="screenshot-annotator"]').click()
        page.locator('.capture-loading[data-state="ready"]').wait_for(state="visible")
        assert page.evaluate("window.__dtkitCalls.filter(c => c.command === 'capture_screen_for_annotation').length") == capture_calls
        assert page.locator("#captureAgainLabel").inner_text() == "开始截图"
        page.locator("#captureAgain").click()
        page.locator("#captureCanvas").wait_for(state="visible")
        assert page.locator("#captureCanvas").evaluate("canvas => canvas.width") == 640
        assert page.locator("#captureLoading").is_hidden()
        assert page.locator("#captureSave").is_enabled()
        bounds = page.locator("#captureCanvas").bounding_box()
        page.mouse.move(bounds["x"] + 10, bounds["y"] + 10)
        page.mouse.down()
        page.mouse.move(bounds["x"] + 60, bounds["y"] + 40)
        page.mouse.up()
        assert page.locator("#captureUndo").is_enabled()
        page.locator('[data-capture-mode="text"]').click()
        page.mouse.click(bounds["x"] + 100, bounds["y"] + 80)
        assert page.locator("#captureTextDialog").is_visible()
        page.locator("#captureTextInput").fill("重点")
        page.locator(".capture-text-submit").click()
        assert not page.locator("#captureTextDialog").is_visible()
        page.screenshot(path="C:/tmp/dtkit-screenshot-detail.png", full_page=True)

        page.locator('[data-view="toolLibrary"]').click()
        page.locator('[data-tool-id="qr-generator"]').click()
        page.locator(".qr-workspace").wait_for()
        page.locator("#qrDataInput").fill("mailto:hello@example.com")
        page.locator('[data-qr-prefix="tel:"]').click()
        assert page.locator("#qrDataInput").input_value() == "tel:hello@example.com"
        page.locator('[data-qr-prefix=""]').click()
        assert page.locator("#qrDataInput").input_value() == "hello@example.com"
        assert "17" in page.locator("#qrDataCount").inner_text()
        page.screenshot(path="C:/tmp/dtkit-qr-create-detail.png", full_page=True)
        page.locator('[data-qr-tab="temporary"]').click()
        assert page.locator("#qrTemporaryPanel").is_visible()
        assert "10" in page.locator(".qr-temp-intro").inner_text()
        assert page.locator("#qrCopyContent").is_disabled()
        assert page.locator("#qrCodePreview").is_hidden()
        assert page.locator("#qrPreviewEmpty").is_visible()
        page.screenshot(path="C:/tmp/dtkit-qr-detail.png", full_page=True)

        page.locator('[data-view="settings"]').click()
        page.locator("#toolModulesSection").scroll_into_view_if_needed()
        assert page.locator("#toolModulesContent").is_hidden()
        page.locator("#toolModulesCollapse").click()
        assert page.locator("#toolModulesCollapse").get_attribute("aria-expanded") == "true"
        page.locator("#toolModuleList .tool-module-row").first.wait_for()
        assert page.locator("#toolModuleList .tool-module-row").count() == 18
        toggle = page.locator('input[data-tool-id="hash-tool"]')
        toggle.uncheck()
        page.wait_for_function("window.__dtkitCalls.some(c => c.command === 'set_tool_module_enabled' && c.args.toolId === 'hash-tool')")
        page.locator("#toolModuleDisabledOnly").check()
        assert page.locator("#toolModuleList .tool-module-row").count() == 1

        page.locator("#checkUpdateButton").click()
        page.wait_for_function("document.querySelector('#updateCheckStatus').textContent.includes('v0.3.0')")
        assert page.locator("#checkUpdateButton").inner_text() == "前往下载"
        page.locator("#checkUpdateButton").click()
        page.wait_for_function("window.__dtkitCalls.some(c => c.command === 'open_release_page')")

        page.screenshot(path="C:/tmp/dtkit-portable-tools.png", full_page=True)

        quick_page = browser.new_page(viewport={"width": 720, "height": 520})
        quick_page.add_init_script(MOCK)
        quick_page.goto("http://127.0.0.1:9005/quick.html?kind=tool&toolId=text-snippets", wait_until="networkidle")
        quick_page.locator(".snippet-shell--quick").wait_for()
        assert quick_page.locator(".snippet-row").count() == 2
        quick_page.screenshot(path="C:/tmp/dtkit-snippets-quick-detail.png", full_page=True)
        quick_page.close()

        quick_capture = browser.new_page(viewport={"width": 900, "height": 620})
        quick_capture.add_init_script(MOCK)
        quick_capture.goto("http://127.0.0.1:9005/quick.html?kind=tool&toolId=screenshot-annotator", wait_until="networkidle")
        quick_capture.locator("#captureCanvas").wait_for(state="visible")
        assert quick_capture.evaluate("window.__dtkitCalls.some(c => c.command === 'capture_screen_for_annotation')")
        quick_capture.close()

        browser.close()
        print("portable tools UI smoke passed")

if __name__ == "__main__":
    run()
