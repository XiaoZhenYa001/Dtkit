# DToolBox - 桌面工具箱

一个高效、易于扩展的桌面工具箱应用，采用 **Tauri + Web** 技术栈，基于模块化架构。
## 换ai之前请阅读项目,理解布局与结构(完全遵守),不要再生成新的md文件了,太多了
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
│   ├── css/                      # 🎨 样式组件化
│   │   ├── base.css             # 变量、重置、基础样式
│   │   ├── layout.css           # 侧边栏、标签栏、工具栏
│   │   ├── tools-library.css    # 工具库网格、卡片样式
│   │   ├── tools/               # 各工具独立样式
│   │   │   ├── timestamp-converter.css
│   │   │   └── json-formatter.css
│   │   └── responsive.css       # 响应式设计
│   │
│   ├── tools/                   # 🔧 工具模块目录
│   │   ├── toolRegistry.js      # ⚙️  工具注册中心
│   │   ├── index.js             # 📦 工具导入入口
│   │   ├── timestamp-converter.js  # ✅ 时间戳工具（已实现）
│   │   ├── json-formatter.js    # ✅ JSON 格式化（已实现）
│   │   ├── base64-codec.js      # ⏳ Base64 编解码（模板）
│   │   └── [other-tools].js     # 🔮 未来工具
│   │
│   ├── main.js                  # 📄 应用框架（精简后 326 行）
│   ├── index.html               # 🌐 前端页面
│   └── [assets, etc.]
│
├── src-tauri/                   # 🦀 Tauri 后端配置
├── package.json
├── PROJECT_SUMMARY.md           # 📚 项目总结文档
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

### 构建应用
```bash
npm run tauri build
```

## 📖 开发指南

本项目采用**模块化 + 组件化**架构，新工具添加流程标准化。

### 核心概念

#### 1. 工具注册中心 (`src/tools/toolRegistry.js`)
统一的工具生命周期管理（注册、初始化、销毁）

#### 2. 应用框架 (`src/main.js`)
提供标签页、视图切换等框架功能，不包含工具逻辑

#### 3. 工具模块 (`src/tools/*.js`)
独立的 ES6 模块，每个工具自包含业务逻辑

#### 4. 工具样式 (`src/css/tools/*.css`)
每个工具独立的 CSS 文件，无需修改现有样式

## 🛠️ 快速添加新工具（5-10 分钟）

📖 **详细指南**: 查看 [`TOOL_FORMAT_GUIDE.md`](TOOL_FORMAT_GUIDE.md) 获取完整的标准化工具实现流程

**快速清单** (修改 5 个文件):
1. ✏️ `src/tools/tool-name.js` - 工具逻辑（~150 行）
2. 🎨 `src/css/tools/tool-name.css` - 工具样式（~90 行）
3. 📄 `src/index.html` - 添加 HTML 视图（~80 行）
4. 📦 `src/tools/index.js` - 导入工具（1 行）
5. ⚙️ `src/main.js` - 配置视图切换（3-5 行）

**参考示例**:
- 新格式标准: `src/tools/base64-codec.js` + 相关文件 ✨
- 详细模板: [`TOOL_FORMAT_GUIDE.md`](TOOL_FORMAT_GUIDE.md) 中的代码模板

## 📊 当前工具列表

### ✅ 已实现 (3 个)
- **时间戳转换** - Unix 时间戳与日期相互转换
- **JSON 格式化** - JSON 校验、格式化、压缩、着色显示
- **Base64 编解码** - 文本 Base64 编码/解码，自动检测格式

### ⏳ 计划中
- 二维码生成
- 正则表达式测试
- 颜色提取器
- 图片压缩
- Hash 计算 (MD5/SHA)
- URL 编码/解码
- 单位换算
- 等等...

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

- **[TOOL_FORMAT_GUIDE.md](./TOOL_FORMAT_GUIDE.md)** - 🏗️ 标准化工具实现流程（必读）
- **[PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md)** - 项目总结和路线图
- **[src/tools/base64-codec.js](./src/tools/base64-codec.js)** - 新格式工具示例 ✨
- **[src/tools/toolRegistry.js](./src/tools/toolRegistry.js)** - 工具注册中心 API

## 💡 最佳实践

✅ **必读** [`TOOL_FORMAT_GUIDE.md`](./TOOL_FORMAT_GUIDE.md) 了解标准化流程  
✅ **参考** `base64-codec.js` 作为新工具实现模板 ✨  
✅ **遵循** 命名规范和代码模板  
✅ **使用** 提供的文件模板加速开发  
✅ **测试** 新工具的初始化和销毁流程  
✅ **清理** 资源（定时器、事件监听等）  

## ❓ 遇到问题？

常见问题和排查方法详见 [`TOOL_FORMAT_GUIDE.md#-常见错误`](./TOOL_FORMAT_GUIDE.md#-常见错误)

## 📝 项目信息

- **技术栈**: Tauri + HTML/CSS/JavaScript (Vanilla)
- **模块系统**: ES6 Modules
- **样式框架**: CSS 变量 + BEM 命名
- **图标库**: Remixicon (CDN)
- **Node 版本**: 14+
- **Rust 版本**: 1.70+

## 🎉 快速导航

| 需求 | 查看文件 |
|------|---------|
| 🔧 想添加新工具？ | 👉 [TOOL_FORMAT_GUIDE.md](./TOOL_FORMAT_GUIDE.md) |
| 📊 想了解项目状态？ | 👉 [PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md) |
| 💻 想看代码示例？ | 👉 [src/tools/base64-codec.js](./src/tools/base64-codec.js) ✨ |
| 🏗️ 想查架构文档？ | 👉 [TOOL_FORMAT_GUIDE.md#-文件模板标准](./TOOL_FORMAT_GUIDE.md#-文件模板标准) |
| 🐛 想排查问题？ | 👉 [TOOL_FORMAT_GUIDE.md#-常见错误](./TOOL_FORMAT_GUIDE.md#-常见错误) |

---

**最后更新**: 2025 年 12 月 15 日  
**当前版本**: 0.1.0