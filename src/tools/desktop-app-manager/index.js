import { registerTool } from '../toolRegistry.js';
import '../../css/tools/desktop-app-manager.css';
import '../../css/tools/desktop-app-manager-category.css';

const invoke = (command, args) => globalThis.window?.__TAURI__?.core?.invoke(command, args);
const byId = id => document.getElementById(id);
let controller;
let apps = [];
let selectedPath = '';
let activeFilter = 'all';
let pendingIconPath = '';
const DESKTOP_SNAPSHOT_KEY = 'dtkit_desktop_snapshot_v1';
const DESKTOP_CATEGORY_OPTIONS = Object.freeze([
    ['recent', '最近使用'],
    ['documents', '文档'],
    ['images', '图片'],
    ['videos', '视频'],
    ['audios', '音频'],
    ['archives', '压缩包'],
    ['programs', 'program'],
    ['folders', '文件夹'],
    ['others', '其他']
]);

function template() {
    return `<div class="app-manager-shell">
        <header class="app-manager-hero"><div><span class="app-manager-mark"><i class="ri-apps-2-line"></i></span><div><span class="app-manager-kicker">DESKTOP APPLICATION INDEX</span><h2>应用与图标管理</h2><p>轻量读取开始菜单和手动项目，不扫描整个磁盘。</p></div></div><button id="appManagerAdd" class="app-manager-button app-manager-button--primary" type="button"><i class="ri-add-line"></i>添加应用</button></header>
        <div class="app-manager-toolbar"><label><i class="ri-search-line"></i><input id="appManagerSearch" type="search" placeholder="搜索应用名称、分类或路径" autocomplete="off"></label><button id="appManagerRefresh" type="button" title="刷新索引"><i class="ri-refresh-line"></i></button></div>
        <div class="app-manager-workspace">
            <nav class="app-manager-nav" aria-label="应用筛选"><button class="is-active" data-app-filter="all"><i class="ri-apps-2-line"></i><span>全部应用</span><em id="appCountAll">0</em></button><button data-app-filter="missing"><i class="ri-image-line"></i><span>待检查图标</span><em id="appCountMissing">0</em></button><button data-app-filter="manual"><i class="ri-add-line"></i><span>手动添加</span><em id="appCountManual">0</em></button><button data-app-filter="hidden"><i class="ri-eye-line"></i><span>已隐藏</span><em id="appCountHidden">0</em></button></nav>
            <section class="app-manager-list-card"><header><strong id="appManagerListTitle">全部应用</strong><span id="appManagerSummary">正在读取…</span></header><div id="appManagerList" class="app-manager-list"></div></section>
            <aside id="appManagerDetail" class="app-manager-detail"></aside>
        </div>
        <p id="appManagerStatus" class="app-manager-status" aria-live="polite"></p>
    </div>`;
}

function setStatus(message, type = '') { const node = byId('appManagerStatus'); if (node) { node.textContent = message; node.dataset.type = type; } }
function fileName(path) { return String(path || '').split(/[\\/]/).pop()?.replace(/\.(exe|lnk|url)$/i, '') || '未命名应用'; }

function filteredApps() {
    const query = (byId('appManagerSearch')?.value || '').trim().toLocaleLowerCase();
    return apps.filter(app => {
        if (activeFilter === 'hidden' && !app.hidden) return false;
        if (activeFilter !== 'hidden' && app.hidden) return false;
        if (activeFilter === 'manual' && !app.manual) return false;
        if (activeFilter === 'missing' && app.icon) return false;
        return !query || [app.name, app.category, app.path].some(value => String(value).toLocaleLowerCase().includes(query));
    });
}

function appRow(app) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `app-manager-row${app.path === selectedPath ? ' is-selected' : ''}`; button.dataset.appPath = app.path;
    const icon = document.createElement('span'); icon.className = 'app-manager-row__icon'; icon.innerHTML = app.icon ? `<img src="${app.icon}" alt="">` : '<i class="ri-apps-2-line"></i>';
    const text = document.createElement('span'); text.className = 'app-manager-row__text'; const name = document.createElement('strong'); name.textContent = app.name; const path = document.createElement('small'); path.textContent = app.path; text.append(name, path);
    const meta = document.createElement('span'); meta.className = 'app-manager-row__meta'; meta.textContent = app.manual ? '手动' : '开始菜单';
    button.append(icon, text, meta); return button;
}

function renderList() {
    const visible = filteredApps();
    byId('appCountAll').textContent = apps.filter(app => !app.hidden).length;
    byId('appCountMissing').textContent = apps.filter(app => !app.hidden && !app.icon).length;
    byId('appCountManual').textContent = apps.filter(app => !app.hidden && app.manual).length;
    byId('appCountHidden').textContent = apps.filter(app => app.hidden).length;
    byId('appManagerSummary').textContent = `${visible.length} 条`;
    if (visible.length) byId('appManagerList').replaceChildren(...visible.map(appRow));
    else { const empty=document.createElement('div'); empty.className='app-manager-empty'; empty.innerHTML='<i class="ri-search-line"></i><strong>没有匹配的应用</strong><span>可以刷新索引或手动添加应用。</span>'; byId('appManagerList').replaceChildren(empty); }
}

function selectedApp() { return apps.find(app => app.path === selectedPath) || null; }
function categorySuggestions() {
    const categories = new Set(['program']);
    for (const app of apps) {
        const category = String(app.category || '').trim();
        if (category) categories.add(category);
    }
    try {
        const snapshot = JSON.parse(localStorage.getItem(DESKTOP_SNAPSHOT_KEY) || 'null');
        for (const [key, value] of DESKTOP_CATEGORY_OPTIONS) {
            if (Array.isArray(snapshot?.files?.[key]) && snapshot.files[key].length) categories.add(value);
        }
    } catch {}
    try {
        const saved = JSON.parse(localStorage.getItem('desktop_organizer_custom_categories') || '[]');
        if (Array.isArray(saved)) {
            for (const category of saved) {
                const name = typeof category?.name === 'string' ? category.name.trim() : '';
                if (name) categories.add(name);
            }
        }
    } catch {}
    return [...categories].sort((left, right) => {
        if (left === 'program') return -1;
        if (right === 'program') return 1;
        return left.localeCompare(right, 'zh-CN');
    });
}
function categoryDisplayName(category) { return category === 'program' ? '程序' : category; }
function setCategoryOptionsOpen(open) {
    const options = byId('appManagerCategoryOptions');
    const input = byId('appManagerCategory');
    if (!options || !input) return;
    options.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    byId('appManagerCategoryToggle')?.setAttribute('aria-expanded', String(open));
}
function renderCategoryOptions() {
    const options = byId('appManagerCategoryOptions');
    const currentValue = byId('appManagerCategory')?.value || '';
    if (!options) return;
    options.replaceChildren(...categorySuggestions().map(category => {
        const option = document.createElement('button');
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(category === currentValue));
        option.dataset.categoryValue = category;
        option.textContent = categoryDisplayName(category);
        return option;
    }));
}
async function loadSelectedSystemIcon(app, image) {
    if (app.icon || !image) return;
    try { const icon = await invoke('desktop_get_app_icon', { path: app.path }); if (icon && image.isConnected && selectedPath === app.path) image.src = icon; } catch {}
}

function renderDetail() {
    const panel = byId('appManagerDetail'); const app = selectedApp(); pendingIconPath = '';
    if (!app) { panel.innerHTML='<div class="app-manager-detail__empty"><span><i class="ri-layout-grid-line"></i></span><strong>选择一个应用</strong><p>在这里修正名称、分类、图标或隐藏状态。</p></div>'; return; }
    panel.innerHTML=`<div class="app-manager-detail__head"><span class="app-manager-detail__icon"><img id="appManagerIconPreview" alt=""></span><div><strong></strong><small></small></div></div><div class="app-manager-fields"><label><span>显示名称</span><input id="appManagerName" maxlength="160"></label><div class="app-manager-category-field"><label for="appManagerCategory">分类</label><div class="app-manager-category-combobox"><input id="appManagerCategory" maxlength="80" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="appManagerCategoryOptions" autocomplete="off"><button id="appManagerCategoryToggle" type="button" aria-label="选择已有分类" aria-expanded="false"><i class="ri-arrow-down-s-line"></i></button><div id="appManagerCategoryOptions" class="app-manager-category-options" role="listbox" hidden></div></div></div><label><span>应用路径</span><input id="appManagerPath" readonly></label><label class="app-manager-hidden"><input id="appManagerHidden" type="checkbox"><span><strong>在桌面整理中隐藏</strong><small>仍保留管理记录，可以随时恢复。</small></span></label></div><div class="app-manager-icon-actions"><button id="appManagerChooseIcon" type="button"><i class="ri-image-line"></i>选择自定义图标</button><small>PNG、JPG或ICO，最大4MB</small></div><div class="app-manager-detail__actions"><button data-app-action="open" type="button"><i class="ri-external-link-line"></i>打开</button><button data-app-action="locate" type="button"><i class="ri-folder-open-line"></i>定位</button><button data-app-action="reset" class="is-danger" type="button">${app.manual ? '移除' : '恢复默认'}</button><button data-app-action="save" class="is-primary" type="button">保存修改</button></div>`;
    panel.querySelector('.app-manager-detail__head strong').textContent=app.name; panel.querySelector('.app-manager-detail__head small').textContent=app.manual?'手动添加':'开始菜单';
    byId('appManagerName').value=app.name; byId('appManagerCategory').value=app.category || 'program'; byId('appManagerPath').value=app.path; byId('appManagerHidden').checked=app.hidden;
    renderCategoryOptions();
    const preview=byId('appManagerIconPreview'); if(app.icon) preview.src=app.icon; else loadSelectedSystemIcon(app,preview);
}

async function loadApps(refresh = false) { setStatus('正在读取轻量应用索引…'); try { apps=await invoke('desktop_list_apps',{includeHidden:true,refresh}); if(selectedPath&&!apps.some(app=>app.path===selectedPath))selectedPath=''; renderList(); renderDetail(); setStatus(`已索引 ${apps.length} 个应用。`,'success'); } catch(error){setStatus(String(error),'error');} }

async function addApp() {
    const path=await window.__TAURI__?.dialog?.open({multiple:false,directory:false,title:'选择应用',filters:[{name:'Windows 应用',extensions:['exe','lnk','url']}]}); if(!path||Array.isArray(path))return;
    try { await invoke('desktop_save_app',{request:{path,name:fileName(path),category:'program',hidden:false,manual:true,iconPath:null}}); selectedPath=path; await loadApps(); setStatus('应用已添加。','success'); } catch(error){setStatus(String(error),'error');}
}

async function handleDetailAction(event) {
    const action=event.target.closest('[data-app-action]')?.dataset.appAction; const app=selectedApp(); if(!action||!app)return;
    try {
        if(action==='open')await invoke('desktop_open_app',{path:app.path});
        if(action==='locate')await invoke('desktop_locate_app',{path:app.path});
        if(action==='reset'){await invoke('desktop_reset_app',{path:app.path});selectedPath='';await loadApps();setStatus(app.manual?'应用已从索引移除。':'已恢复系统识别信息。','success');}
        if(action==='save'){await invoke('desktop_save_app',{request:{path:app.path,name:byId('appManagerName').value,category:byId('appManagerCategory').value,hidden:byId('appManagerHidden').checked,manual:app.manual,iconPath:pendingIconPath||null}});await loadApps();setStatus('应用信息已保存。','success');}
    } catch(error){setStatus(String(error),'error');}
}

async function chooseIcon() { const path=await window.__TAURI__?.dialog?.open({multiple:false,directory:false,title:'选择应用图标',filters:[{name:'图片图标',extensions:['png','jpg','jpeg','ico']}]}); if(!path||Array.isArray(path))return; pendingIconPath=path; byId('appManagerIconPreview').src=window.__TAURI__?.core?.convertFileSrc?.(path)||''; setStatus('图标已选择，点击“保存修改”后生效。'); }

function init() {
    controller?.abort(); controller=new AbortController(); const {signal}=controller;
    byId('appManagerAdd')?.addEventListener('click',addApp,{signal}); byId('appManagerRefresh')?.addEventListener('click',()=>loadApps(true),{signal}); byId('appManagerSearch')?.addEventListener('input',renderList,{signal});
    document.querySelector('.app-manager-nav')?.addEventListener('click',event=>{const button=event.target.closest('[data-app-filter]');if(!button)return;activeFilter=button.dataset.appFilter;document.querySelectorAll('[data-app-filter]').forEach(item=>item.classList.toggle('is-active',item===button));byId('appManagerListTitle').textContent=button.querySelector('span').textContent;renderList();},{signal});
    byId('appManagerList')?.addEventListener('click',event=>{const row=event.target.closest('[data-app-path]');if(!row)return;selectedPath=row.dataset.appPath;renderList();renderDetail();},{signal});
    byId('appManagerDetail')?.addEventListener('click',event=>{
        const option=event.target.closest('[data-category-value]');
        if(option){byId('appManagerCategory').value=option.dataset.categoryValue;setCategoryOptionsOpen(false);byId('appManagerCategory').focus();return;}
        if(event.target.closest('#appManagerCategoryToggle')){renderCategoryOptions();setCategoryOptionsOpen(byId('appManagerCategoryOptions').hidden);return;}
        if(event.target.closest('#appManagerCategory')){renderCategoryOptions();setCategoryOptionsOpen(true);return;}
        if(event.target.closest('#appManagerChooseIcon'))chooseIcon();else handleDetailAction(event);
    },{signal});
    byId('appManagerDetail')?.addEventListener('keydown',event=>{
        if(!event.target.closest('#appManagerCategory'))return;
        if(event.key==='Escape'){setCategoryOptionsOpen(false);return;}
        if(event.key==='ArrowDown'){event.preventDefault();renderCategoryOptions();setCategoryOptionsOpen(true);byId('appManagerCategoryOptions')?.querySelector('[role="option"]')?.focus();}
    },{signal});
    document.addEventListener('click',event=>{if(!event.target.closest('.app-manager-category-combobox'))setCategoryOptionsOpen(false);},{signal});
    loadApps();
}
function destroy(){controller?.abort();controller=null;apps=[];selectedPath='';pendingIconPath='';}

registerTool({id:'desktop-app-manager',name:'应用与图标管理',surface:'internal',icon:'ri-apps-2-line',colorClass:'tool-card__icon--orange',category:'utility',status:'ready',description:'管理桌面整理识别到的应用、分类和自定义图标。',template,init,destroy});
