# DtKit 项目结构说明

## 📁 新的项目结构

```
src/
├── index.html              # 主 HTML 文件（只包含框架结构）
├── main.js                 # 主程序入口
├── css/                    # 全局样式
│   ├── base.css           # 基础样式
│   ├── layout.css         # 布局样式
│   ├── responsive.css     # 响应式设计
│   ├── settings.css       # 设置页面样式
│   └── tools-library.css  # 工具库样式
│
└── tools/                  # 🔧 工具模块目录
    ├── index.js           # 工具索引（导入所有工具）
    ├── toolRegistry.js    # 工具注册中心
    ├── _TOOL_TEMPLATE/    # 📋 工具开发模板
    │   └── index.js
    │
    ├── timestamp-converter/   # ⏰ 时间戳转换工具
    │   └── index.js          # 包含 HTML、CSS、JS
    │
    ├── json-formatter/        # 📄 JSON 格式化工具
    │   └── index.js
    │
    ├── base64-codec/          # 🔐 Base64 编解码工具
    │   └── index.js
    │
    ├── color-picker/          # 🎨 颜色提取器工具
    │   └── index.js
    │
    └── ... 其他工具
```

## 🚀 添加新工具的步骤

### 1️⃣ 创建工具文件夹

在 `src/tools/` 目录下创建新文件夹：

```
src/tools/my-new-tool/
```

### 2️⃣ 创建 index.js

复制 `_TOOL_TEMPLATE/index.js` 到新文件夹，然后修改：

```javascript
import { registerTool } from '../toolRegistry.js';

// HTML 模板
function getTemplate() {
    return `
        <div class="view-container">
            <!-- 你的工具 HTML -->
        </div>
    `;
}

// CSS 样式
function getStyles() {
    return `
        /* 你的工具样式 */
    `;
}

// 初始化函数
function initMyTool() {
    // 工具初始化逻辑
}

// 销毁函数
function destroyMyTool() {
    // 清理资源
}

// 注册工具
registerTool({
    id: 'my-new-tool',
    name: '我的新工具',
    icon: 'ri-tools-line',
    colorClass: 'tool-card__icon--blue',
    category: 'dev',  // dev / design / other
    description: '工具描述',
    template: getTemplate,
    styles: getStyles,
    init: initMyTool,
    destroy: destroyMyTool
});
```

### 3️⃣ 导入工具

在 `src/tools/index.js` 中添加一行：

```javascript
import './my-new-tool/index.js';
```

**完成！** 无需修改 `index.html` 或 `main.js`！

## 📝 工具配置说明

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 工具唯一标识（kebab-case） |
| `name` | string | ✅ | 工具显示名称 |
| `icon` | string | ✅ | Remix Icon 图标类名 |
| `colorClass` | string | ✅ | 卡片颜色类名 |
| `category` | string | ✅ | 分类：`dev` / `design` / `other` |
| `description` | string | ⬜ | 工具描述文字 |
| `template` | function | ⬜ | 返回 HTML 字符串的函数 |
| `styles` | function | ⬜ | 返回 CSS 字符串的函数 |
| `init` | function | ✅ | 工具初始化函数 |
| `destroy` | function | ⬜ | 工具销毁函数 |

## 🎨 可用的卡片颜色

```
tool-card__icon--blue    蓝色
tool-card__icon--green   绿色
tool-card__icon--orange  橙色
tool-card__icon--pink    粉色
tool-card__icon--purple  紫色
tool-card__icon--teal    青色
tool-card__icon--red     红色
tool-card__icon--yellow  黄色
```

## 🔧 可用的 CSS 变量

在你的工具样式中可以使用这些全局变量：

```css
/* 颜色 */
var(--color-bg-primary)      /* 主背景色 */
var(--color-bg-secondary)    /* 次要背景色 */
var(--color-bg-tertiary)     /* 第三背景色 */
var(--color-border)          /* 边框颜色 */
var(--color-text-primary)    /* 主文字颜色 */
var(--color-text-secondary)  /* 次要文字颜色 */
var(--color-primary)         /* 主题色 */

/* 间距 */
var(--spacing-xs)    /* 0.25rem */
var(--spacing-sm)    /* 0.5rem */
var(--spacing-md)    /* 1rem */
var(--spacing-lg)    /* 1.5rem */
var(--spacing-xl)    /* 2rem */

/* 圆角 */
var(--radius-sm)     /* 小圆角 */
var(--radius-md)     /* 中圆角 */
var(--radius-lg)     /* 大圆角 */

/* 字体 */
var(--font-size-xs)
var(--font-size-sm)
var(--font-size-md)
var(--font-size-lg)
var(--font-size-xl)
var(--font-mono)     /* 等宽字体 */
```

## 📦 图标参考

本项目使用 [Remix Icon](https://remixicon.com/)，常用图标：

- `ri-time-line` - 时间
- `ri-braces-line` - JSON/代码
- `ri-lock-2-line` - 锁/加密
- `ri-palette-line` - 调色板
- `ri-image-line` - 图片
- `ri-hashtag` - 哈希
- `ri-link` - 链接
- `ri-calendar-line` - 日历
- `ri-calculator-line` - 计算器
- `ri-file-text-line` - 文本文件
- `ri-code-line` - 代码
- `ri-tools-line` - 工具

## 🔄 工具生命周期

```
1. 用户点击工具卡片
   ↓
2. renderToolView(toolId) 被调用
   - 注入工具的 CSS 样式到 <head>
   - 渲染工具的 HTML 模板到动态容器
   ↓
3. initTool(toolId) 被调用
   - 执行工具的初始化函数
   - 绑定事件监听器
   ↓
4. 用户使用工具...
   ↓
5. 用户切换到其他工具或页面
   ↓
6. destroyTool(toolId) 被调用
   - 执行工具的销毁函数
   - 清理定时器、事件监听器等
```

## ❓ 常见问题

### Q: 如何在工具之间共享代码？

创建 `src/tools/shared/` 目录存放共享模块：

```javascript
// src/tools/shared/utils.js
export function formatDate(date) { ... }

// 在工具中使用
import { formatDate } from '../shared/utils.js';
```

### Q: 如何添加工具专属的静态资源？

在工具文件夹中创建 `assets/` 目录：

```
src/tools/my-tool/
├── index.js
└── assets/
    └── icon.svg
```

### Q: 如何让工具保持状态？

使用模块级变量保存状态：

```javascript
let toolState = {
    lastInput: '',
    history: []
};

// 在 destroy 函数中清理
function destroyMyTool() {
    toolState = { lastInput: '', history: [] };
}
```
