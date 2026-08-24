# DtKit - 桌面工具箱

> 🔧 高效、易于扩展的桌面工具箱应用 | Tauri 2.0 + Vite | 模块化架构

[![Version](https://img.shields.io/badge/version-0.2.7-blue.svg)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.0-orange.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)]()

## 🎯 项目特点

- ✅ **模块化设计** - 工具与框架分离，易于添加新工具
- ✅ **ES6 模块化** - 使用现代 JavaScript 模块系统
- ✅ **工具注册机制** - 统一的工具管理和生命周期控制
- ✅ **无缝扩展** - 添加新工具无需修改框架代码
- ✅ **样式保持** - HTML/CSS 结构完全保持不变

## 📁 项目结构

```
DtKit/
├── src/
│   ├── index.html               # 🌐 前端入口页面
│   ├── main.js                  # 📄 应用主框架
│   │
│   ├── assets/                  # 🎨 静态资源
│   │   ├── remixicon.css        # 完整图标源文件（用于生成子集）
│   │   └── remixicon-subset.css # 应用实际加载的图标子集
│   │
│   ├── components/              # 🧩 UI 组件
│   │   ├── navigation.js        # 导航组件
│   │   ├── tabs.js              # 标签页组件
│   │   └── toolCard.js          # 工具卡片组件
│   │
│   ├── core/                    # ⚙️ 核心模块
│   │   ├── dom.js               # DOM 操作
│   │   ├── mirrorSource.js      # 镜像源管理
│   │   ├── state.js             # 状态管理
│   │   └── utils.js             # 工具函数
│   │
│   ├── css/                     # 🎨 样式文件
│   │   ├── base.css             # 基础样式
│   │   ├── layout.css           # 布局样式
│   │   ├── tools-library.css    # 工具库样式
│   │   ├── responsive.css       # 响应式设计
│   │   └── tools/               # 各工具独立样式
│   │
│   ├── desktop-organizer/       # 🗂️ 桌面整理模块（独立窗口）
│   │   ├── index.html
│   │   ├── main.js
│   │   └── styles.css
│   │
│   ├── tools/                   # 🔧 工具模块目录
│   │   ├── toolRegistry.js      # 工具注册中心
│   │   ├── index.js             # 工具导入入口
│   │   ├── _TOOL_TEMPLATE/      # 工具模板
│   │   └── [tool-name]/         # 各工具模块
│   │
│   └── views/                   # 📄 视图模块
│       ├── downloads.js         # 下载视图
│       ├── favorites.js         # 收藏视图
│       ├── settings.js          # 设置视图
│       └── toolLibrary.js       # 工具库视图
│
├── src-tauri/                   # 🦀 Tauri 后端
│   ├── src/
│   │   ├── main.rs              # Rust 入口
│   │   ├── lib.rs               # 库模块
│   │   └── desktop/             # 桌面整理后端
│   ├── tauri.conf.json          # Tauri 配置
│   └── Cargo.toml               # Rust 依赖
│
├── package.json                 # 📦 npm 配置
└── README.md                    # 📝 本文件
```

## 🚀 快速开始

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run tauri dev
```

仅调试前端时可以运行：
```bash
npm run dev
```

### 构建应用
```bash
npm run tauri build
```

`tauri build` 会自动先执行 `npm run build`，生成经过压缩和分包的 `dist/` 前端产物。

### 更新图标子集

新增或移除 `ri-*` 图标后，安装一次字体构建依赖并重新生成子集：

```bash
python -m pip install fonttools brotli
npm run icons:build
```

`npm run test:js` 会检查应用引用的完整图标类是否全部包含在子集中。

### 更新 HTML 预览运行器

HTML 预览运行器使用 CSP SHA-256 白名单。修改 `src/preview-runner.js` 后需要更新哈希：

```bash
npm run csp:hash
```

`npm run test:js` 会检查生产与开发 CSP 中的哈希是否和运行器源码一致。

## 📖 开发指南

本项目采用**模块化 + 组件化**架构。

### 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| 工具注册中心 | `src/tools/toolRegistry.js` | 工具生命周期管理 |
| 应用框架 | `src/main.js` | 标签页、视图切换 |
| 工具模块 | `src/tools/*/index.js` | 独立的工具逻辑 |
| 样式文件 | `src/css/tools/*.css` | 工具独立样式 |

## 🛠️ 添加新工具

1. 复制 `src/tools/_TOOL_TEMPLATE/` 目录
2. 重命名为新工具名称
3. 实现 `index.js` 中的 `init()` 和 `destroy()` 方法
4. 在 `src/tools/index.js` 中登记工具清单和动态加载器
5. 将清单状态设为 `ready`、`beta` 或 `planned`

## 📊 当前工具列表

### ✅ 已实现 (11 个)

| 工具 | 说明 | 目录 |
|------|------|------|
| ⏰ 时间戳转换 | Unix 时间戳与日期相互转换 | `timestamp-converter/` |
| 📝 JSON 格式化 | JSON 校验、格式化、压缩、着色显示 | `json-formatter/` |
| 🔐 Base64 编解码 | 文本 Base64 编码/解码 | `base64-codec/` |
| #️⃣ Hash 计算 | MD5/SHA 哈希计算 | `hash-tool/` |
| 🎨 颜色选择器 | 颜色拾取与格式转换 | `color-picker/` |
| 📱 二维码生成 | 生成自定义二维码 | `qr-generator/` |
| ⏰ 闹钟工具 | 定时提醒功能 | `alarm-clock/` |
| 🌐 HTML 预览 | 实时预览 HTML 代码 | `html-preview/` |
| 🔗 URL 编码 | URL 组件和完整网址编解码 | `url-encoder/` |
| 📐 单位换算 | 数据、长度、质量、温度、面积、速度换算 | `unit-converter/` |
| 📅 Cron 表达式 | 标准 5 段 Crontab 解析和执行时间预估 | `crontab-explainer/` |

### ⏳ 计划中 (2 个已展示入口)

- 🖼️ 图片压缩
- 🌟 Favicon 生成

计划中工具会在工具库标记为“即将推出”，并禁止打开空白页面。

### 🧭 后续候选

- 🔍 正则表达式测试
- 📝 Markdown 预览
- 🔤 文本差异对比
- 🌐 IP 查询工具
- 📊 代码统计
- 🔄 进制转换
- 📑 文本格式化

## 🏗️ 架构优势

| 方面 | 优势 |
|------|------|
| **可维护性** | 工具逻辑独立，修改一个工具不影响其他工具 |
| **可扩展性** | 添加新工具只需新建一个文件，无需修改框架 |
| **代码复用** | 工具可以共享公共函数和工具类 |
| **性能** | 按需加载工具，不会加载未使用的工具逻辑 |
| **测试** | 每个工具可独立测试 |
| **团队协作** | 不同开发者可以并行开发不同工具 |

## 🔄 工作流程

添加新工具 → 在工具模块中实现 → 注册工具 → 添加 HTML 视图 → 配置框架 → 测试 → 完成

所有流程都有详细文档支持。

## 📚 相关文档

- [版本说明与各类说明.md](版本说明与各类说明.md) - 版本管理与开发规范
- [DESKTOP_ORGANIZER_DESIGN.md](DESKTOP_ORGANIZER_DESIGN.md) - 桌面整理设计文档
- [GITHUB_CONFIGURATION.md](GITHUB_CONFIGURATION.md) - GitHub 配置指南
- [待添加功能.md](待添加功能.md) - 功能规划清单

## � 项目信息

| 项目 | 说明 |
|------|------|
| 技术栈 | Tauri 2.0 + Vite + HTML/CSS/JavaScript |
| 模块系统 | ES6 Modules |
| 样式规范 | CSS 变量 + BEM 命名 |
| 图标库 | Remixicon |
| 后端 | Rust 1.70+ |



**最后更新**: 2026 年 8 月 24 日

**当前版本**: 0.2.7
