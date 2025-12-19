# DtKit 开发者指南

> 本文档面向项目维护者和新加入的开发者，帮助快速理解项目架构和开发流程。

## 目录

- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [核心模块详解](#核心模块详解)
- [如何添加新工具](#如何添加新工具)
- [状态管理](#状态管理)
- [样式规范](#样式规范)
- [开发与调试](#开发与调试)
- [常见问题](#常见问题)

---

## 项目概述

DtKit（Developer Toolkit）是一个基于 **Tauri 2.0** 构建的桌面工具箱应用，提供多种开发者常用工具，如 JSON 格式化、时间戳转换、Base64 编解码等。

### 设计理念

1. **模块化** - 每个功能模块独立，便于维护和扩展
2. **低耦合** - 通过回调函数和单例状态实现模块间通信
3. **易扩展** - 添加新工具只需创建一个文件夹，无需修改核心代码

---

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Tauri 2.0 | Rust 后端，提供原生系统能力 |
| 前端 | Vanilla JavaScript (ES Modules) | 无框架，轻量高效 |
| 样式 | CSS3 + CSS Variables | 主题变量系统 |
| 图标 | Remix Icon | 通过 CDN 引入 |
| 包管理 | npm + Cargo | 前端用 npm，Rust 用 Cargo |

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
│   │   └── utils.js              # 通用工具函数
│   │
│   ├── components/               # UI 组件
│   │   ├── tabs.js               # 标签页管理
│   │   ├── toolCard.js           # 工具卡片组件
│   │   └── navigation.js         # 后退/前进导航
│   │
│   ├── views/                    # 视图模块
│   │   ├── toolLibrary.js        # 工具库视图
│   │   ├── favorites.js          # 收藏视图
│   │   └── settings.js           # 设置视图
│   │
│   ├── tools/                    # 工具注册中心
│   │   ├── index.js              # 工具导出汇总
│   │   ├── toolRegistry.js       # 工具注册核心逻辑
│   │   ├── _TOOL_TEMPLATE/       # 新工具模板
│   │   ├── json-formatter/       # JSON 格式化工具
│   │   ├── timestamp-converter/  # 时间戳转换工具
│   │   ├── base64-codec/         # Base64 编解码工具
│   │   └── color-picker/         # 颜色选择器工具
│   │
│   ├── css/                      # 样式文件
│   │   ├── base.css              # 基础样式和变量
│   │   ├── layout.css            # 布局样式
│   │   ├── settings.css          # 设置页样式
│   │   ├── tools-library.css     # 工具库样式
│   │   └── tools/                # 各工具专属样式
│   │
│   └── assets/                   # 静态资源
│
├── src-tauri/                    # Tauri/Rust 后端
│   ├── src/
│   │   ├── main.rs               # Rust 入口
│   │   └── lib.rs                # Rust 库（插件注册）
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置
│   └── capabilities/             # 权限配置
│
└── package.json                  # npm 配置
```

---

## 核心模块详解

### 1. 状态管理 (`core/state.js`)

使用**单例模式**管理全局状态，所有模块共享同一个 `appState` 对象。

```javascript
// 导入状态
import appState, { getActiveTab, toggleFavorite } from '../core/state.js';

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
    currentView: 'toolLibrary', // 当前视图
    currentToolId: null,      // 当前工具 ID
    searchQuery: '',          // 搜索关键词
    favorites: [...],         // 收藏的工具 ID 列表
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

### 3. 工具注册中心 (`tools/toolRegistry.js`)

所有工具通过 `registerTool()` 注册。

```javascript
import { registerTool } from '../toolRegistry.js';

registerTool({
    id: 'my-tool',
    name: '我的工具',
    icon: 'ri-tools-line',
    category: 'dev',          // dev | design | other
    description: '工具描述',
    colorClass: 'tool-card__icon--blue',
    template: () => `<div>HTML模板</div>`,
    styles: () => `.my-class { color: red; }`,
    init: () => { /* 初始化逻辑 */ },
    destroy: () => { /* 清理逻辑 */ }
});
```

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
    category: 'dev',
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
npx tauri dev
```

### 打包发布

```bash
npx tauri build
```

### 查看控制台日志

应用启动后，右键 → 检查元素 → Console 查看日志。

### 常用调试命令

```javascript
// 查看当前状态
console.log(appState);

// 查看已注册的工具
console.log(getAllTools());

// 查看下载路径
console.log(window.getDownloadPath());
```

---

## 常见问题

### Q: 工具不显示在工具库中？

1. 检查是否在 `tools/index.js` 中导入了工具
2. 检查 `registerTool()` 的 `category` 是否正确（dev/design/other）
3. 打开控制台查看是否有报错

### Q: 如何添加 Tauri 原生功能？

1. 在 `src-tauri/Cargo.toml` 添加插件依赖
2. 在 `src-tauri/src/lib.rs` 注册插件
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
localStorage.setItem('my_key', JSON.stringify(data));

// 读取
const data = JSON.parse(localStorage.getItem('my_key') || '{}');
```

---

## 文件行数统计

| 文件 | 行数 | 职责 |
|------|------|------|
| main.js | ~260 | 应用入口，模块协调 |
| core/state.js | ~100 | 全局状态管理 |
| core/dom.js | ~55 | DOM 缓存 |
| core/utils.js | ~45 | 工具函数 |
| components/tabs.js | ~100 | 标签页组件 |
| components/navigation.js | ~95 | 导航组件 |
| components/toolCard.js | ~60 | 工具卡片 |
| views/toolLibrary.js | ~90 | 工具库视图 |
| views/favorites.js | ~65 | 收藏视图 |
| views/settings.js | ~230 | 设置视图 |

---

## 联系与贡献

如有问题或建议，请提交 Issue 或 Pull Request。

---

*最后更新：2025年12月19日*
