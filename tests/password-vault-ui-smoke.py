import os
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4173")
SCREENSHOT = Path(r"C:\tmp\dtkit-password-vault.png")
IMPORT_SCREENSHOT = Path(r"C:\tmp\dtkit-password-import-review.png")


MOCK = r"""
(() => {
  const items = [
    {id:'1',service:'GitHub',username:'octocat',note:'个人账号',category:'开发',favorite:true,lastUsedAt:1786000000000,deletedAt:null},
    {id:'2',service:'校园门户',username:'student',note:'教务系统',category:'学习',favorite:false,lastUsedAt:null,deletedAt:null}
  ];
  const invoke = async (command, args = {}) => {
    if (command === 'get_password_settings') return {clipboardClearSeconds:30};
    if (command === 'get_password_overview') return {total:2,favoriteCount:1,recentCount:1,trashCount:0,categories:[{name:'开发',count:1},{name:'学习',count:1}]};
    if (command === 'list_passwords') {
      let result = items;
      if (args.view === 'favorites') result = result.filter(item => item.favorite);
      if (args.view === 'recent') result = result.filter(item => item.lastUsedAt);
      if (args.view === 'category') result = result.filter(item => item.category === args.category);
      return {items:result,total:result.length,truncated:false};
    }
    if (command === 'get_password_detail') return {id:args.id,service:'GitHub',username:'octocat',phone:'',email:'octocat@example.com',note:'个人账号',category:'开发',url:'https://github.com',favorite:true,createdAt:1780000000000,updatedAt:1785000000000,lastUsedAt:1786000000000,useCount:8,customFields:[{index:0,label:'恢复代码',value:'',sensitive:true,hasValue:true}]};
    if (command === 'get_password_entry_for_edit') return {id:args.id,service:'GitHub',username:'octocat',phone:'',email:'octocat@example.com',password:'secret',note:'个人账号',category:'开发',url:'https://github.com',favorite:true,customFields:[{label:'恢复代码',value:'code',sensitive:true}]};
    if (command === 'preview_password_import') return {token:'import-1',format:'CSV',total:3,ready:1,duplicates:0,invalid:2,warnings:[],items:[{id:'preview-1',service:'GitHub',username:'octocat',note:'ok',category:'dev'}],issues:[{id:'missing-name',editable:true,source:'第 3 行',service:'',username:'missing-name',email:'',note:'work',category:'dev',errors:['名称为空']},{id:'missing-password',editable:true,source:'第 4 行',service:'Mail',username:'me',email:'me@example.com',note:'',category:'personal',errors:['密码为空']}]};
    if (command === 'update_password_import_entry') {
      window.__importCorrection = args;
      return {ready:2,duplicates:0,invalid:1,item:{id:'preview-2',service:'Mail',username:'me',note:'',category:'personal'},issue:null};
    }
    if (command === 'discard_password_import') return null;
    if (command === 'get_shortcut_bindings') return [];
    if (command === 'get_tool_module_settings') return {disabled:[]};
    if (command === 'take_missed_alarm_triggers') return [];
    return null;
  };
  Object.defineProperty(window, '__TAURI__', {value:{core:{invoke},dialog:{open:async()=>'invalid.csv'}}, configurable:true});
})();
"""


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.add_init_script(MOCK)
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    page.locator('[data-view="passwords"]').click()
    page.locator('.password-workspace').wait_for(state="visible")

    assert page.locator('.password-nav').is_visible()
    assert page.locator('.password-list-card').is_visible()
    assert page.locator('.password-detail').is_visible()
    assert page.locator('.password-result').count() == 2
    workspace_box = page.locator('.password-workspace').bounding_box()
    assert workspace_box['y'] + workspace_box['height'] >= 860, 'password workspace should fill the remaining content area'

    add_button = page.locator('#passwordAdd')
    add_button.hover()
    add_hover = add_button.evaluate("node => { const style = getComputedStyle(node); return { color: style.color, backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor }; }")
    assert add_hover['backgroundImage'] != 'none', f"primary hover lost its accent background: {add_hover}"
    assert add_hover['color'] == 'rgb(255, 255, 255)'

    page.locator('#passwordImport').click()
    page.locator('#passwordImportDialog').wait_for(state='visible')
    assert page.locator('.password-import-issue').count() == 2
    assert page.locator('.password-import-issue').first.locator('.password-import-issue__source').inner_text() == '第 3 行'
    assert 'missing-name' in page.locator('.password-import-issue').first.inner_text()
    assert '名称为空' in page.locator('.password-import-issue').first.inner_text()
    assert '密码为空' in page.locator('.password-import-issue').nth(1).inner_text()
    assert 'secret-2' not in page.locator('#passwordImportDialog').inner_text()
    page.locator('[data-import-issue-edit="missing-password"]').click()
    correction = page.locator('[data-import-issue-form="missing-password"]')
    correction.locator('input[name="password"]').fill('only-in-input-42!')
    correction.locator('button[type="submit"]').click()
    page.wait_for_function('window.__importCorrection !== undefined')
    correction.wait_for(state='detached')
    assert page.locator('#passwordImportReadyCount').inner_text() == '2 条'
    assert 'only-in-input-42!' not in page.locator('#passwordImportDialog').inner_text()
    IMPORT_SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(IMPORT_SCREENSHOT), full_page=True)
    page.locator('#passwordImportDialog .password-dialog__close').click()

    page.locator('#passwordAdd').click()
    editor = page.locator('#passwordEditor')
    editor.wait_for(state="visible")
    before = editor.bounding_box()
    assert abs((before['x'] + before['width'] / 2) - 700) <= 2
    assert abs((before['y'] + before['height'] / 2) - 450) <= 2
    header = editor.locator('.password-dialog__header')
    handle = header.bounding_box()
    page.mouse.move(handle['x'] + 80, handle['y'] + 20)
    page.mouse.down()
    page.mouse.move(handle['x'] + 150, handle['y'] + 70, steps=5)
    page.mouse.up()
    after = editor.bounding_box()
    assert after['x'] > before['x'] + 30
    assert after['y'] > before['y'] + 20
    editor.locator('.password-dialog__close').click()
    assert not editor.is_visible(), 'empty required fields must not block cancelling the editor'

    page.locator('.password-result').first.click()
    assert page.locator('.password-detail__header h3').inner_text() == 'GitHub'
    assert '••••' in page.locator('.password-detail__fields').inner_text()

    page.locator('[data-detail-action="edit"]').click()
    page.locator('#passwordEditor').wait_for(state="visible")
    assert page.locator('#passwordUrl').input_value() == 'https://github.com'
    assert page.locator('.password-custom-field').count() == 1
    page.locator('#passwordEditor .password-dialog__close').click()

    page.locator('[data-password-view="favorites"]').click()
    assert page.locator('.password-result').count() == 1
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    browser.close()

print("Password vault UI smoke test passed")
