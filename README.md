# DtKit - 桌面工具箱

> 🔧 高效、易于扩展的桌面工具箱应用 | Tauri 2.0 + Vite | 模块化架构

[![Version](https://img.shields.io/badge/version-0.2.9-blue.svg)]()
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

## 多页面与独立启动

打开工具后点击「新建同类页面」，可同时编辑多个独立页面；也可以新建标签后再选择同一工具。每页的输入、预览、滚动位置独立，切换和前进/后退保留页面，关闭标签释放对应页面。「重命名」可区分不同用途。闹钟任务、已保存白板和便签等实际数据仍共用，修改会读取最新记录以避免覆盖其他页面的操作。

「独立窗口」打开当前种类的一个新工具窗口。「创建启动入口」在桌面创建对应的快捷方式，下次只启动这个工具，不创建主界面，也不启动桌面整理和无关的全局快捷键服务。命令行同样支持：

```powershell
.\DtKit.exe --tool html-preview
```

工具代码和样式按需加载；隐藏的工具页暂停计时器、动画和刷新，HTML 预览会卸载用户脚本沙盒。独立窗口关闭前等待保存完成，然后立即释放窗口；没有窗口或必要后台任务时，单工具进程自动退出。已安排的闹钟、文件作业、局域网分享和敏感剪贴板清理会继续运行。

「主界面休眠」先保存页面草稿，再释放主 WebView，独立工具继续运行；从托盘恢复主界面后还原页面。HTML 编辑器与白板支持草稿恢复。不能安全保存的会话（例如尚未导出的截图或文件选择）、保存失败或超过本机保存上限时，会保留并暂停主 WebView，避免丢失内容。工作区草稿存储在本机，不包含密码输入与文件内容；页面关闭会移除对应的工作区草稿。

## 📖 开发指南

### 工具页面生命周期

`tool-page.html` 为每个页面提供独立的 JS 环境；同一主窗口内的页面复用原生 WebView。工具可在注册信息中提供 `serialize` / `restore` 保存与恢复页面状态，以及异步 `flush` / `destroy` 完成原生草稿写入。实际共享数据应由后端或事务存储管理，不能用历史页面快照覆盖最新数据。

本项目采用**模块化 + 组件化**架构。

### 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| 工具注册中心 | `src/tools/toolRegistry.js` | 工具生命周期管理 |
| 应用框架 | `src/main.js` | 标签页、视图切换 |
| 工具模块 | `src/tools/*/index.js` | 独立的工具逻辑 |
| 样式文件 | `src/css/tools/*.css` | 工具独立样式 |

## 📝 桌面便签

在工具库打开「便签」，点击「新建便签」即可在独立小窗中记录内容。支持六种纸张颜色、窗口置顶、拖动缩放、标题与正文搜索；关闭小窗会保存内容，再次打开时恢复位置和尺寸。内容修改后自动保存，`Ctrl+S` 可立即保存。

不需要的便签可先移入回收站，需要时恢复；只有回收站中的便签可以永久删除。为保护尚未保存的编辑，移入回收站前请先关闭对应小窗。便签数据位于应用数据目录的 `Kits/StickyNotes`，随应用数据目录迁移；浏览器预览不写入桌面便签。

便签按需创建窗口，没有定时刷新或启动时批量打开；最多保存 200 张（含回收站），同时打开 8 张。若保存失败，小窗会保留编辑并提供重试；异常退出后的未确认草稿可在再次打开时检查和恢复。

## 🚀 自启动管理

在工具库打开「自启动管理」，可直接检查当前用户与所有用户的常见登录启动程序。支持按注册表、启动文件夹、状态和范围筛选，搜索名称、命令与路径；「我关闭的」集中显示由 DtKit 关闭、可以恢复的项目。系统助手中的开机启动入口使用相同功能。

「程序位置」在资源管理器中选中实际程序文件，快捷方式会先读取其目标；「启动文件位置」可定位启动文件或快捷方式。找不到目标时会显示原因，并保留入口详情。工具只读取配置和快捷方式，不会执行检测到的程序。

关闭前保存恢复记录，再停用对应入口；恢复时检查原始命令或文件是否被其他软件改动，遇到冲突不覆盖新配置。任务管理器或 Windows 设置关闭的项目会标明来源，可通过「Windows 启动设置」管理。系统范围的修改可能需要管理员权限。

扫描只在打开工具、手动刷新及操作后执行，没有后台轮询。当前覆盖 Run、RunOnce（一次性登录任务）以及当前用户和所有用户的启动文件夹；计划任务、服务、驱动及其他特殊自动启动方式不在当前列表中。启停影响后续登录启动，不会关闭正在运行的程序。

恢复记录位于应用数据目录 `Kits/SystemAssistant`，随应用数据目录一起迁移。依据：[Microsoft 登录启动注册表入口](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)、[Windows 启动应用管理](https://support.microsoft.com/en-us/windows/experience/startup-boot/configure-startup-applications-in-windows)。

## 🖱️ 右键菜单管理

在工具库打开「右键菜单管理」，按文件、文件夹、文件夹空白处、桌面、磁盘和文件类型查看菜单注册项。支持本地搜索、状态与来源筛选；输入 `.pdf` 等扩展名后，可补充扫描该类型的关联菜单。「我关闭的」集中显示可以由 DtKit 恢复的项目。

扫描和修改均按需运行，不加载第三方菜单 DLL、不驻留轮询。普通命令通过隐藏标记关闭；扩展组件按 CLSID 管理，同一组件在多个场景下的菜单会联动，关闭前会显示影响范围。修改前保存恢复记录，重新开启时核对注册表状态后恢复；原始命令和组件注册不会被删除。系统级项目可能需要以管理员身份运行 DtKit。

当前主要覆盖资源管理器的传统菜单，包括 Windows 11「显示更多选项」中的注册项。新版打包应用菜单、程序内部右键菜单和按所选文件动态生成的子菜单不保证完整枚举。系统核心项目、其他软件关闭的项目及不支持安全管理的注册方式会显示只读原因。部分扩展有缓存，修改后可能需要重新打开资源管理器窗口或重新登录；工具不会自动重启资源管理器。

恢复记录位于应用数据目录 `Kits/ContextMenu`，随应用数据目录一起迁移。菜单状态反映注册配置；文件类型、按住 Shift、应用自身设置等条件仍可能影响实际显示。

实现依据：[Microsoft Shell 扩展注册](https://learn.microsoft.com/en-us/windows/win32/shell/reg-shell-exts)、[Windows 11 打包应用菜单](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer)。

## 📅 课表

工具库 → 课表。主视图按周显示课程、教室和节次，点击课程编辑，点击空白格添加。支持连续周、指定周、单双周、课程安排复制和同周冲突校验；周数随日期自动推进。

设置分为基本设置、特色设置、导入与导出、其他设置：可调整开学日期、当前周、总周数、周末、非本周课程、每周起始日和逐节作息；支持静态背景图片、学历选择、新学期归档和历史学期切换。课表保存在应用的本地存储中，建议定期导出完整 JSON 备份。

JSON 备份包含课程、设置、背景和最多 10 个历史学期；CSV 可合并或替换课程，导入前有校验和预览；ICS 按本机当地时间导出每次上课，可导入日历；PNG 导出正在查看的一周。

桌面小部件支持今日 / 本周、拖动、缩放和置顶，只在用户添加时创建一个 WebView，不随启动自动打开。数据通过存储事件同步，只在课程开始、结束或跨日时安排一次更新，隐藏或最小化暂停计时，关闭直接释放窗口。

验证：`node --test tests/timetable.test.js`；构建后运行 `python tests/timetable-ui-smoke.py`（脚本自行启动本地静态服务，IPC 使用模拟对象）。

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



**最后更新**: 2026 年 10 月 7 日

**当前版本**: 0.2.9
