# DtKit 开发者指南

> 本文档面向项目维护者和新加入的开发者，帮助快速理解项目架构和开发流程。

## 目录

- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [核心模块详解](#核心模块详解)
- [Tauri 后端命令](#tauri-后端命令)
- [如何添加新工具](#如何添加新工具)
- [状态管理](#状态管理)
- [样式规范](#样式规范)
- [开发与调试](#开发与调试)
- [常见问题](#常见问题)

---

## 项目概述

DtKit（Developer Toolkit）是一个基于 **Tauri 2.0** 构建的桌面工具箱应用，提供多种开发者常用工具，如 JSON 格式化、时间戳转换、Base64 编解码、二维码生成、下载管理等。

### 设计理念

1. **模块化** - 每个功能模块独立，便于维护和扩展
2. **低耦合** - 通过回调函数和单例状态实现模块间通信
3. **易扩展** - 添加新工具只需创建一个文件夹，无需修改核心代码
4. **本地优先** - 图标字体等资源本地化，避免 CDN 依赖

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri 2.0 | Rust 后端，提供原生系统能力 |
| 前端 | Vanilla JavaScript (ES Modules) | 无框架，轻量高效 |
| 样式 | CSS3 + CSS Variables | 主题变量系统 |
| 图标 | Remix Icon (本地 woff2) | 本地字体文件，无 CDN 依赖 |
| 包管理 | npm + Cargo | 前端用 npm，Rust 用 Cargo |

### Rust 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| tauri | 2.x | 核心框架 |
| tauri-plugin-dialog | 2.x | 文件夹选择对话框 |
| tauri-plugin-fs | 2.x | 文件系统操作 |
| tauri-plugin-shell | 2.x | 系统命令执行 |
| reqwest | 0.11 | HTTP 请求（下载功能） |
| tokio | 1.x | 异步运行时 |
| uuid | 1.x | 唯一 ID 生成 |

---

## 项目结构

```
DtKit/
├── src/                          # 前端源码
│   ├── main.js                   # 应用入口，协调各模块
│   ├── index.html                # 主 HTML 文件
│   │
│   ├── core/                     # 核心模块
│   │   ├── state.js              # 全局状态管理（单例模式）
│   │   ├── dom.js                # DOM 元素缓存
│   │   └── utils.js              # 通用工具函数（showToast 等）
│   │
│   ├── components/               # UI 组件
│   │   ├── tabs.js               # 标签页管理
│   │   ├── toolCard.js           # 工具卡片组件
│   │   └── navigation.js         # 后退/前进导航
│   │
│   ├── views/                    # 视图模块
│   │   ├── toolLibrary.js        # 工具库视图
│   │   ├── favorites.js          # 收藏视图（支持拖拽排序）
│   │   ├── settings.js           # 设置视图
│   │   └── downloads.js          # 下载管理器视图
│   │
│   ├── tools/                    # 工具注册中心
│   │   ├── index.js              # 工具导出汇总
│   │   ├── toolRegistry.js       # 工具注册核心逻辑
│   │   ├── _TOOL_TEMPLATE/       # 新工具模板
│   │   ├── json-formatter/       # JSON 格式化工具
│   │   ├── timestamp-converter/  # 时间戳转换工具
│   │   ├── base64-codec/         # Base64 编解码工具
│   │   ├── color-picker/         # 颜色选择器工具
│   │   ├── qr-generator/         # 二维码生成器
│   │   ├── alarm-clock/          # 闹钟工具
│   │   ├── hash-tool/            # Hash 计算器（玻璃拟态）
│   │   ├── html-preview/         # HTML 代码预览
│   │   ├── image-compressor.js   # 图片压缩（待迁移）
│   │   ├── favicon-generator.js  # Favicon 生成器（待迁移）
│   │   ├── url-encoder.js        # URL 编解码（待迁移）
│   │   ├── crontab-explainer.js  # Crontab 解释器（待迁移）
│   │   └── unit-converter.js     # 单位转换器（待迁移）
│   │
│   ├── css/                      # 样式文件
│   │   ├── base.css              # 基础样式和变量
│   │   ├── layout.css            # 布局样式
│   │   ├── settings.css          # 设置页样式
│   │   ├── tools-library.css     # 工具库样式
│   │   ├── downloads.css         # 下载管理器样式
│   │   ├── responsive.css        # 响应式样式
│   │   └── tools/                # 各工具专属样式
│   │
│   └── assets/                   # 静态资源
│       ├── remixicon.css         # 图标样式
│       └── fonts/                # 本地字体文件
│           └── remixicon.woff2
│
├── src-tauri/                    # Tauri/Rust 后端
│   ├── src/
│   │   ├── main.rs               # Rust 入口
│   │   └── lib.rs                # Rust 命令定义
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置
│   └── capabilities/             # 权限配置
│       └── default.json          # 默认权限
│
└── package.json                  # npm 配置
```

---

## 核心模块详解

### 1. 状态管理 (`core/state.js`)

使用**单例模式**管理全局状态，所有模块共享同一个 `appState` 对象。

```javascript
// 导入状态
import appState, { getActiveTab, toggleFavorite, getDownloadPath } from '../core/state.js';

// 访问状态
console.log(appState.currentView);      // 当前视图
console.log(appState.favorites);        // 收藏列表
console.log(appState.settings.downloadPath); // 下载路径
```

**状态结构：**

```javascript
appState = {
    tabs: [...],              // 标签页列表
    activeTabId: 'xxx',       // 当前活动标签 ID
    currentView: 'toolLibrary', // 当前视图: toolLibrary | favorites | settings | downloads
    currentToolId: null,      // 当前工具 ID
    searchQuery: '',          // 搜索关键词
    favorites: [...],         // 收藏的工具 ID 列表（支持排序）
    settings: {
        downloadPath: '...'   // 下载路径
    }
}
```

### 2. DOM 缓存 (`core/dom.js`)

避免重复查询 DOM，提升性能。

```javascript
import DOM, { initDOM } from '../core/dom.js';

// 使用缓存的 DOM 元素
DOM.tabBar.innerHTML = '...';
DOM.searchInput.value = '';
```

### 3. 工具函数 (`core/utils.js`)

```javascript
import { showToast, debounce } from '../core/utils.js';

// 显示 Toast 通知
showToast('操作成功', 'success');  // success | error | warning | info

// 防抖函数
const debouncedSearch = debounce(search, 300);
```

### 4. 工具注册中心 (`tools/toolRegistry.js`)

所有工具通过 `registerTool()` 注册。

```javascript
import { registerTool } from '../toolRegistry.js';

registerTool({
    id: 'my-tool',
    name: '我的工具',
    icon: 'ri-tools-line',
    category: 'dev',          // dev | design | other | daily
    description: '工具描述',
    colorClass: 'tool-card__icon--blue',
    template: () => `<div>HTML模板</div>`,
    styles: () => `.my-class { color: red; }`,
    init: () => { /* 初始化逻辑 */ },
    destroy: () => { /* 清理逻辑 */ }
});
```

---

## Tauri 后端命令

### 已注册的 Rust 命令

| 命令 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `greet` | name: String | String | 测试命令 |
| `write_binary_file` | path: String, data: Vec<u8> | Result<()> | 写入二进制文件 |
| `run_command` | cmd: String, args: Vec<String> | Result<String> | 执行系统命令 |
| `start_download` | url, save_path, custom_filename | Result<String> | 开始下载文件 |
| `get_download_tasks` | - | Vec<DownloadTask> | 获取所有下载任务 |
| `cancel_download` | task_id: String | Result<()> | 取消下载 |
| `remove_download_record` | task_id: String | Result<()> | 删除下载记录 |
| `open_file` | path: String | Result<()> | 打开文件 |
| `open_file_location` | path: String | Result<()> | 打开文件所在目录 |

### 前端调用 Tauri API

```javascript
// 检查 Tauri 环境
if (window.__TAURI__) {
    // 调用 Rust 命令
    const result = await window.__TAURI__.core.invoke('start_download', {
        url: 'https://example.com/file.zip',
        savePath: 'D:/Downloads',
        customFilename: null
    });
    
    // 使用对话框
    const { open } = window.__TAURI__.dialog;
    const selected = await open({
        directory: true,
        title: '选择文件夹'
    });
    
    // 监听事件
    const unlisten = await window.__TAURI__.event.listen('download-progress', (event) => {
        console.log(event.payload);
    });
}
```

### Tauri 事件

| 事件名 | Payload | 说明 |
|--------|---------|------|
| `download-started` | DownloadTask | 下载开始 |
| `download-progress` | { id, downloaded, total_size, speed, percentage } | 下载进度更新 |
| `download-status-changed` | DownloadTask | 下载状态变化（完成/失败） |

---

## 如何添加新工具

### 步骤 1：复制模板

```bash
cp -r src/tools/_TOOL_TEMPLATE src/tools/my-new-tool
```

### 步骤 2：编辑工具文件

修改 `src/tools/my-new-tool/index.js`：

```javascript
import { registerTool } from '../toolRegistry.js';

// HTML 模板
function getTemplate() {
    return `
        <div class="tool-view my-tool">
            <h2>我的新工具</h2>
            <input type="text" id="myInput" placeholder="输入内容">
            <button id="myBtn">执行</button>
            <div id="myResult"></div>
        </div>
    `;
}

// CSS 样式
function getStyles() {
    return `
        .my-tool {
            padding: 2rem;
        }
        .my-tool input {
            width: 100%;
            padding: 0.5rem;
        }
    `;
}

// 初始化函数
function init() {
    const btn = document.getElementById('myBtn');
    const input = document.getElementById('myInput');
    const result = document.getElementById('myResult');
    
    btn?.addEventListener('click', () => {
        result.textContent = `你输入了: ${input.value}`;
    });
}

// 销毁函数（可选）
function destroy() {
    // 清理事件监听器、定时器等
}

// 注册工具
registerTool({
    id: 'my-new-tool',
    name: '我的新工具',
    icon: 'ri-magic-line',
    category: 'dev',  // dev | design | other | daily
    description: '这是一个示例工具',
    colorClass: 'tool-card__icon--purple',
    template: getTemplate,
    styles: getStyles,
    init: init,
    destroy: destroy
});
```

### 步骤 3：在 index.js 中导入

编辑 `src/tools/index.js`，添加导入：

```javascript
import './my-new-tool/index.js';
```

### 步骤 4：刷新应用

工具会自动出现在工具库中。

---

## 视图系统

### 视图类型

| 视图 | 文件 | 说明 |
|------|------|------|
| `toolLibrary` | views/toolLibrary.js | 工具库主页 |
| `favorites` | views/favorites.js | 收藏工具（支持拖拽排序） |
| `settings` | views/settings.js | 应用设置 |
| `downloads` | views/downloads.js | 下载管理器 |

### 导航栏行为

- 在 **工具库** 和 **收藏** 视图时：显示搜索框和导航按钮
- 在 **设置** 和 **下载** 视图时：隐藏导航栏

---

## 模块间通信

### 回调注入模式

模块之间通过回调函数通信，避免循环依赖。

```javascript
// tabs.js - 定义回调接口
let onUpdateContentView = null;

export function setTabCallbacks(callbacks) {
    onUpdateContentView = callbacks.onUpdateContentView;
}

// 使用回调
function switchTab(tabId) {
    // ...
    if (onUpdateContentView) onUpdateContentView();
}
```

```javascript
// main.js - 注入回调
import { setTabCallbacks } from './components/tabs.js';

setTabCallbacks({
    onUpdateContentView: updateContentView
});
```

---

## 样式规范

### CSS 变量

所有颜色、间距、圆角等使用 CSS 变量，定义在 `css/base.css`：

```css
:root {
    --color-primary: #2563eb;
    --color-bg-primary: #f8fafc;
    --color-text-primary: #0f172a;
    --spacing-md: 1rem;
    --radius-md: 0.75rem;
}
```

### 工具卡片颜色类

| 类名 | 颜色 |
|------|------|
| `tool-card__icon--blue` | 蓝色 |
| `tool-card__icon--purple` | 紫色 |
| `tool-card__icon--green` | 绿色 |
| `tool-card__icon--orange` | 橙色 |
| `tool-card__icon--red` | 红色 |
| `tool-card__icon--cyan` | 青色 |

---

## 开发与调试

### 启动开发服务器

```bash
cd DtKit
npm run tauri dev
```

### 打包发布

```bash
npm run tauri build
```

输出位置：
- MSI 安装包：`src-tauri/target/release/bundle/msi/`
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/`
- 可执行文件：`src-tauri/target/release/DtKit.exe`

### 查看控制台日志

应用启动后，按 **F12** 或 **Ctrl+Shift+I** 打开开发者工具查看日志。

### 常用调试命令

```javascript
// 查看当前状态
console.log(appState);

// 查看已注册的工具
console.log(getAllTools());

// 查看下载路径
console.log(window.getDownloadPath());

// 检查 Tauri API 是否可用
console.log(window.__TAURI__);
console.log(Object.keys(window.__TAURI__));
```

---

## 权限配置

Tauri 权限在 `src-tauri/capabilities/default.json` 中配置：

```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default",
    "fs:default",
    "fs:write-all",
    "fs:read-all",
    "shell:default"
  ]
}
```

添加新功能时可能需要添加对应权限。

---

## 常见问题

### Q: 工具不显示在工具库中？

1. 检查是否在 `tools/index.js` 中导入了工具
2. 检查 `registerTool()` 的 `category` 是否正确（dev/design/other/daily）
3. 打开控制台查看是否有报错

### Q: 如何添加 Tauri 原生功能？

1. 在 `src-tauri/Cargo.toml` 添加插件依赖
2. 在 `src-tauri/src/lib.rs` 注册命令或插件
3. 在 `src-tauri/capabilities/default.json` 添加权限
4. 在前端通过 `window.__TAURI__` 调用

### Q: 样式不生效？

1. 检查工具的 `styles()` 函数是否返回了正确的 CSS
2. 检查 CSS 选择器是否正确
3. 使用浏览器开发工具检查元素

### Q: 如何持久化存储数据？

使用 `localStorage`：

```javascript
// 保存
localStorage.setItem('dtkit_my_key', JSON.stringify(data));

// 读取
const data = JSON.parse(localStorage.getItem('dtkit_my_key') || '{}');
```

### Q: 图标不显示？

确保 `src/assets/fonts/remixicon.woff2` 文件存在，并且 `remixicon.css` 正确引用了本地字体。

### Q: 下载功能提示"需要在桌面应用中使用"？

1. 确保在 Tauri 构建的应用中运行（不是浏览器）
2. 检查 `window.__TAURI__` 是否存在
3. 检查控制台是否有 Tauri API 初始化相关日志

---

## 已实现工具列表

| 工具 | ID | 分类 | 状态 |
|------|-----|------|------|
| 时间戳转换 | timestamp-converter | dev | ✅ 完成 |
| JSON 格式化 | json-formatter | dev | ✅ 完成 |
| Base64 编解码 | base64-codec | dev | ✅ 完成 |
| Hash 计算器 | hash-tool | dev | ✅ 完成（玻璃拟态风格） |
| 颜色提取器 | color-picker | design | ✅ 完成 |
| 二维码生成器 | qr-generator | design | ✅ 完成 |
| HTML 代码预览 | html-preview | design | ✅ 完成（支持全屏） |
| 定时闹钟 | alarm-clock | daily | ✅ 完成 |
| 图片压缩 | image-compressor | design | 🔄 待迁移 |
| Favicon 生成器 | favicon-generator | design | 🔄 待迁移 |
| URL 编解码 | url-encoder | dev | 🔄 待迁移 |
| Crontab 解释器 | crontab-explainer | dev | 🔄 待迁移 |
| 单位转换器 | unit-converter | other | 🔄 待迁移 |

---

## Rust 后端命令

### 已注册的命令

| 命令 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `greet` | name: String | String | 测试命令 |
| `write_binary_file` | path: String, data: Vec<u8> | Result<()> | 写入二进制文件 |
| `run_command` | cmd: String, args: Vec<String> | Result<String> | 执行系统命令 |
| `calculate_text_hash` | text, algorithms, uppercase | HashMap | 计算文本哈希值 |
| `calculate_file_hash` | file_path, algorithms, uppercase, task_id | HashMap | 计算文件哈希值（流式） |
| `start_download` | url, save_path, custom_filename | Result<String> | 开始下载文件 |
| `get_download_tasks` | - | Vec<DownloadTask> | 获取所有下载任务 |
| `cancel_download` | task_id: String | Result<()> | 取消下载 |
| `remove_download_record` | task_id: String | Result<()> | 删除下载记录 |
| `open_file` | path: String | Result<()> | 打开文件 |
| `open_file_location` | path: String | Result<()> | 打开文件所在目录 |

### Rust 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| tauri | 2.x | 核心框架 |
| tauri-plugin-dialog | 2.x | 文件/文件夹选择对话框 |
| tauri-plugin-fs | 2.x | 文件系统操作 |
| tauri-plugin-shell | 2.x | 系统命令执行 |
| reqwest | 0.11 | HTTP 请求（下载功能） |
| tokio | 1.x | 异步运行时 |
| uuid | 1.x | 唯一 ID 生成 |
| md-5/sha1/sha2 | 0.10 | 哈希计算 |
| hex | 0.4 | 十六进制编码 |
| lazy_static | 1.4 | 全局状态管理 |

---

## 联系与贡献

如有问题或建议，请提交 Issue 或 Pull Request。

---

*最后更新：2025年12月28日*
