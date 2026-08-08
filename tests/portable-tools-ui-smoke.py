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
  window.__toggleMaximizeCalls = 0;
  window.__alwaysOnTopCalls = [];
  window.__dtkitListeners = {};
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
      if (command === 'start_screen_region_capture') {
        const capture = args.longDirection
          ? {dataUrl:pixel,width:640,height:1040,x:0,y:0}
          : {dataUrl:pixel,width:640,height:360,x:0,y:0};
        queueMicrotask(() => window.__dtkitListeners['screen-region-captured']?.({payload:{cancelled:false,capture}}));
        return null;
      }
      if (command === 'get_screen_region_capture') return {dataUrl:pixel,width:640,height:360,x:0,y:0};
      if (command === 'get_screen_color_pick_capture') return {dataUrl:pixel,width:640,height:360,x:0,y:0};
      if (command === 'get_lan_share') return null;
      if (command === 'list_transfer_items') return [];
      if (command === 'get_resource_policy') return {minimizeMode:'efficient',maxConcurrentJobs:2,quickHostRetentionSeconds:0};
      if (command === 'get_cleanup_status') return {usage:{cacheBytes:0,logBytes:0,recoveryBytes:0},policy:{enabled:false,cacheRetentionDays:7,logRetentionDays:7},latestRecoveryBatch:null};
      if (command === 'get_password_settings') return {clipboardClearSeconds:30};
      if (command === 'get_hotzone_status') return false;
      return null;
    }},
    dialog: {open: async () => null},
    event: {listen: async (name, callback) => { window.__dtkitListeners[name] = callback; return () => delete window.__dtkitListeners[name]; }},
    window: {getCurrentWindow: () => ({
      toggleMaximize: async () => { window.__toggleMaximizeCalls += 1; },
      setAlwaysOnTop: async value => { window.__alwaysOnTopCalls.push(value); },
      minimize: async () => {}
    })}
  };
})();
"""

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1360, "height": 880})
        page.add_init_script(MOCK)
        page.goto("http://127.0.0.1:9005", wait_until="networkidle")

        page.locator("#searchInput").fill("白板")
        assert page.locator("#designToolsSection").is_visible()
        assert page.locator("#designToolsGrid [data-tool-id='whiteboard']").count() == 1
        for section in ("#devToolsSection", "#utilityToolsSection", "#otherToolsSection"):
            assert not page.locator(section).is_visible()
        page.locator("#searchInput").fill("")

        html_card = page.locator("[data-tool-id='html-preview']")
        assert "tool-card__icon--orange" in html_card.locator(".tool-card__icon").get_attribute("class")
        page.set_viewport_size({"width": 1050, "height": 760})
        for tool_id in ("alarm-clock", "timestamp-converter", "html-preview", "hash-tool"):
            page.locator(f"[data-tool-id='{tool_id}'] .tool-card__favorite").click()
        page.locator('[data-view="favorites"]').click()
        page.locator("#favoritesGrid .tool-card").first.wait_for(state="visible")
        page.set_viewport_size({"width": 1720, "height": 760})
        page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        favorite_heights = page.locator("#favoritesGrid .tool-card").evaluate_all(
            "cards => cards.map(card => Math.round(card.getBoundingClientRect().height))"
        )
        assert max(favorite_heights) - min(favorite_heights) <= 1
        favorite_layout = page.locator("#favoritesGrid").evaluate("""grid => {
          const gridRect = grid.getBoundingClientRect();
          const cards = [...grid.querySelectorAll('.tool-card')].map(card => card.getBoundingClientRect());
          return {
            width: gridRect.width,
            cardWidth: cards[0]?.width || 0,
            tops: cards.map(card => Math.round(card.top))
          };
        }""")
        assert favorite_layout["width"] >= 1300
        favorite_reflows_after_resize = len(set(favorite_layout["tops"][:4])) == 1
        page.screenshot(path="C:/tmp/dtkit-favorites-reflow.png", full_page=True)
        page.locator('[data-view="toolLibrary"]').click()

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
        page.set_viewport_size({"width": 1088, "height": 760})
        capture_calls = page.evaluate("window.__dtkitCalls.filter(c => c.command === 'start_screen_region_capture').length")
        page.locator('[data-tool-id="screenshot-annotator"]').click()
        page.locator('.capture-loading[data-state="ready"]').wait_for(state="visible")
        toolbar_groups = page.locator(".capture-toolbar").evaluate("""toolbar => {
          const tools = toolbar.querySelector('.capture-tools').getBoundingClientRect();
          const actions = toolbar.querySelector('.capture-actions').getBoundingClientRect();
          const lastTool = toolbar.querySelector('.capture-tools > :last-child').getBoundingClientRect();
          const firstAction = toolbar.querySelector('.capture-actions > :first-child').getBoundingClientRect();
          return {
            toolsRight: tools.right,
            toolsBottom: tools.bottom,
            actionsLeft: actions.left,
            actionsTop: actions.top,
            lastToolRight: lastTool.right,
            firstActionLeft: firstAction.left
          };
        }""")
        groups_separated = toolbar_groups["toolsRight"] <= toolbar_groups["actionsLeft"] + 1 or toolbar_groups["toolsBottom"] <= toolbar_groups["actionsTop"] + 1
        children_separated = toolbar_groups["lastToolRight"] <= toolbar_groups["firstActionLeft"] + 1 or toolbar_groups["toolsBottom"] <= toolbar_groups["actionsTop"] + 1
        assert groups_separated and children_separated
        assert favorite_reflows_after_resize
        assert page.evaluate("window.__dtkitCalls.filter(c => c.command === 'start_screen_region_capture').length") == capture_calls
        assert page.locator("#captureAgainLabel").inner_text() == "开始截图"
        page.locator("#captureAgain").click()
        page.locator("#captureCanvas").wait_for(state="visible")
        assert page.locator("#captureCanvas").evaluate("canvas => canvas.width") == 640
        assert page.locator("#captureLoading").is_hidden()
        assert page.locator("#captureSave").is_enabled()
        bounds = page.locator("#captureCanvas").bounding_box()
        page.locator('[data-capture-mode="pen"]').click()
        page.mouse.move(bounds["x"] + 20, bounds["y"] + 20)
        assert page.locator("#captureBrushCursor").is_visible()
        brush_box = page.locator("#captureBrushCursor").bounding_box()
        assert brush_box["width"] >= 4 and brush_box["height"] >= 4
        page.mouse.move(bounds["x"] + 10, bounds["y"] + 10)
        page.mouse.down()
        page.mouse.move(bounds["x"] + 60, bounds["y"] + 40)
        page.mouse.up()
        assert page.locator("#captureUndo").is_enabled()
        page.locator('[data-capture-mode="text"]').click()
        page.mouse.click(bounds["x"] + 100, bounds["y"] + 80)
        assert page.locator("#captureInlineText").is_visible()
        editor_bounds = page.locator("#captureInlineText").bounding_box()
        assert abs(editor_bounds["x"] - (bounds["x"] + 100)) <= 4
        assert abs(editor_bounds["y"] - (bounds["y"] + 80)) <= 4
        page.locator("#captureInlineText").fill("重点")
        page.locator("#captureInlineText").press("Enter")
        assert page.locator("#captureInlineText").is_hidden()
        assert int(page.locator("#captureCanvas").get_attribute("data-annotation-count")) >= 2
        page.locator('[data-capture-mode="select"]').click()
        page.mouse.dblclick(bounds["x"] + 105, bounds["y"] + 75)
        assert page.locator("#captureInlineText").is_visible()
        page.locator("#captureInlineText").fill("重点修改")
        page.mouse.click(bounds["x"] + 340, bounds["y"] + 250)
        assert page.locator("#captureInlineText").is_hidden()
        page.locator("#captureShapeTrigger").click()
        assert page.locator("#captureShapeMenu").is_visible()
        page.locator('[data-shape-style="fill"]').click()
        page.locator('[data-shape-mode="ellipse"]').click()
        assert "椭圆" in page.locator("#captureShapeTrigger").inner_text()
        page.mouse.move(bounds["x"] + 180, bounds["y"] + 120)
        page.mouse.down()
        page.mouse.move(bounds["x"] + 260, bounds["y"] + 190)
        page.mouse.up()
        assert int(page.locator("#captureCanvas").get_attribute("data-annotation-count")) >= 3
        assert page.locator("#captureZoomValue").inner_text().endswith("%")
        zoom_before = page.locator("#captureZoomValue").inner_text()
        page.locator("#captureZoomIn").click()
        assert page.locator("#captureZoomValue").inner_text() != zoom_before
        page.locator("#captureCanvasTrigger").click()
        page.locator("#captureCornerRadius").fill("28")
        assert page.locator("#captureCanvas").get_attribute("data-corner-radius") == "28"
        page.locator("#captureLong").click()
        assert page.locator("#captureLongDialog").is_visible()
        page.locator('[data-long-direction="vertical"]').click()
        page.locator("#captureLongStart").click()
        page.wait_for_function("document.querySelector('#captureCanvas').height === 1040")
        long_call = page.evaluate("window.__dtkitCalls.findLast(c => c.command === 'start_screen_region_capture')")
        assert long_call["args"]["longDirection"] == "vertical"
        page.screenshot(path="C:/tmp/dtkit-screenshot-detail.png", full_page=True)
        page.locator("#captureDelete").click()
        assert page.locator("#captureCanvas").is_hidden()
        assert page.locator("#captureLoading").is_visible()
        assert page.locator("#captureSave").is_disabled()

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

        page.locator('[data-view="toolLibrary"]').click()
        page.locator('[data-tool-id="color-picker"]').click()
        page.locator("#screenColorPicker").click()
        page.wait_for_function("window.__dtkitCalls.some(c => c.command === 'start_screen_color_pick')")
        page.evaluate("window.__dtkitListeners['screen-color-picked']({payload:{color:'#12ABEF',cancelled:false}})")
        assert page.locator("#hexInput").input_value() == "#12ABEF"

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
        assert quick_capture.evaluate("window.__dtkitCalls.some(c => c.command === 'start_screen_region_capture')")
        assert "quick-tool--screenshot-annotator" in quick_capture.locator("html").get_attribute("class")
        assert quick_capture.locator("#captureZoomFit").is_enabled()
        stage_box = quick_capture.locator("#captureStage").bounding_box()
        assert stage_box["width"] >= 850
        assert stage_box["height"] >= 400
        assert stage_box["width"] >= stage_box["height"] * 1.5
        for _ in range(12):
            quick_capture.locator("#captureZoomIn").click()
        quick_capture.locator("#captureStage").evaluate("stage => { stage.scrollLeft = 260; stage.scrollTop = 120; }")
        quick_capture.keyboard.down("Control")
        assert quick_capture.locator("#captureStage").get_attribute("data-pan-ready") == "true"
        before_pan = quick_capture.locator("#captureStage").evaluate("stage => stage.scrollLeft")
        quick_capture.mouse.move(stage_box["x"] + stage_box["width"] / 2, stage_box["y"] + stage_box["height"] / 2)
        quick_capture.mouse.down()
        quick_capture.mouse.move(stage_box["x"] + stage_box["width"] / 2 + 70, stage_box["y"] + stage_box["height"] / 2)
        quick_capture.mouse.up()
        after_pan = quick_capture.locator("#captureStage").evaluate("stage => stage.scrollLeft")
        assert after_pan < before_pan
        quick_capture.keyboard.up("Control")
        quick_capture.screenshot(path="C:/tmp/dtkit-screenshot-quick-rectangle.png")
        quick_capture.close()

        quick_html = browser.new_page(viewport={"width": 760, "height": 580})
        quick_html.add_init_script(MOCK)
        quick_html.goto("http://127.0.0.1:9005/quick.html?kind=tool&toolId=html-preview", wait_until="networkidle")
        quick_html.locator(".html-preview-container").wait_for(state="visible")
        assert "quick-tool--html-preview" in quick_html.locator("html").get_attribute("class")
        columns = quick_html.locator(".html-preview-main").evaluate("node => getComputedStyle(node).gridTemplateColumns.split(' ').length")
        assert columns == 2
        quick_html.locator("#quickPin").click()
        assert quick_html.evaluate("window.__alwaysOnTopCalls") == [True]
        assert quick_html.locator("#quickPin").get_attribute("aria-pressed") == "true"
        quick_html.locator("#quickPin").click()
        assert quick_html.evaluate("window.__alwaysOnTopCalls") == [True, False]
        quick_html.locator("#quickMaximize").click()
        assert quick_html.evaluate("window.__toggleMaximizeCalls") == 1
        quick_html.screenshot(path="C:/tmp/dtkit-html-preview-quick.png", full_page=True)
        quick_html.close()

        color_overlay = browser.new_page(viewport={"width": 760, "height": 520})
        color_overlay.add_init_script(MOCK)
        color_overlay.goto("http://127.0.0.1:9005/color-pick.html", wait_until="networkidle")
        color_overlay.locator("#loading").wait_for(state="hidden")
        color_overlay.mouse.move(240, 190)
        color_overlay.wait_for_function("document.querySelector('#pickedRgb').textContent.includes('RGB')")
        assert color_overlay.locator("#pickCursor").is_visible()
        assert color_overlay.locator("#magnifier").is_visible()
        magnifier_box = color_overlay.locator("#magnifier").bounding_box()
        assert magnifier_box["x"] >= 0 and magnifier_box["y"] >= 0
        assert magnifier_box["x"] + magnifier_box["width"] <= 760
        assert magnifier_box["y"] + magnifier_box["height"] <= 520
        color_overlay.screenshot(path="C:/tmp/dtkit-color-pick-overlay.png")
        color_overlay.close()

        region_overlay = browser.new_page(viewport={"width": 760, "height": 520})
        region_overlay.add_init_script(MOCK)
        region_overlay.goto("http://127.0.0.1:9005/screen-region.html", wait_until="networkidle")
        region_overlay.locator("#regionLoading").wait_for(state="hidden")
        region_overlay.mouse.move(110, 90)
        region_overlay.mouse.down()
        region_overlay.mouse.move(510, 350)
        assert region_overlay.locator("#regionSelection").is_visible()
        region_overlay.mouse.up()
        region_overlay.wait_for_function("window.__dtkitCalls.some(c => c.command === 'finish_screen_region_capture')")
        finish_call = region_overlay.evaluate("window.__dtkitCalls.find(c => c.command === 'finish_screen_region_capture')")
        assert finish_call["args"]["width"] > 0 and finish_call["args"]["height"] > 0
        region_overlay.screenshot(path="C:/tmp/dtkit-screen-region-overlay.png")
        region_overlay.close()

        browser.close()
        print("portable tools UI smoke passed")

if __name__ == "__main__":
    run()
