# GitHub 上传指南 - 文件管理策略

## 📋 项目文件分类分析

### ✅ 应该上传的文件

#### 1. **源代码文件** (优先级：最高)
```
src/
├── main.js              ✅ 核心应用逻辑
├── index.html           ✅ 主页面
└── tools/
    ├── base64-codec.js  ✅ 工具代码
    ├── json-formatter.js ✅ 工具代码
    ├── timestamp-converter.js ✅ 工具代码
    └── ... (所有工具文件)
```
**原因**：这是项目的核心业务逻辑，其他开发者需要查看和改进的代码

#### 2. **样式文件** (优先级：高)
```
src/assets/css/
├── base.css             ✅ 基础样式
├── layout.css           ✅ 布局样式
├── responsive.css       ✅ 响应式样式
├── tools-library.css    ✅ 工具库样式
└── tools/               ✅ 工具特定样式
```
**原因**：UI/UX 设计的重要组成部分

#### 3. **Rust/Tauri 源代码** (优先级：高)
```
src-tauri/
├── src/
│   ├── main.rs          ✅ Tauri 主程序
│   └── lib.rs           ✅ Tauri 库代码
├── Cargo.toml           ✅ Rust 依赖配置
└── tauri.conf.json      ✅ Tauri 配置文件
```
**原因**：桌面应用的源代码，版本控制必须项

#### 4. **配置文件** (优先级：高)
```
package.json             ✅ Node.js 项目配置
Cargo.toml              ✅ Rust 项目配置
tauri.conf.json         ✅ Tauri 应用配置
.env.example            ✅ 环境变量示例（如果存在）
```
**原因**：定义了项目依赖、构建配置、应用元数据

#### 5. **文档文件** (优先级：中-高)
```
README.md               ✅ 项目主文档
QUICK_START.md          ✅ 快速开始指南
PROJECT_SUMMARY.md      ✅ 项目总结
DOCUMENTATION_INDEX.md  ✅ 文档索引
```
**原因**：帮助其他开发者理解和使用项目

#### 6. **其他重要文档** (优先级：中)
```
START_HERE.md           ✅ 新手指南
TEMPLATE_REFERENCE.md   ✅ 模板参考
TOOL_FORMAT_GUIDE.md    ✅ 工具格式指南
```
**原因**：开发指南和架构文档

#### 7. **license 文件** (如果存在)
```
LICENSE                 ✅ 许可证文件
```
**原因**：明确代码的使用许可

---

### ❌ 不应该上传的文件

#### 1. **依赖文件夹** (优先级：必须忽略)
```
node_modules/           ❌ Node.js 依赖包
src-tauri/target/       ❌ Rust 编译输出
.venv/                  ❌ Python 虚拟环境（如果存在）
venv/                   ❌ Python 虚拟环境（如果存在）
```
**原因**：
- 体积巨大（通常 100MB+ ~ 几 GB）
- 由 `package.json` / `Cargo.toml` 自动生成
- 与操作系统相关，不同平台差异大
- 其他开发者可通过 `npm install` 或 `cargo build` 恢复

#### 2. **编译和构建输出**
```
src-tauri/target/build/         ❌ Rust 构建中间文件
src-tauri/target/debug/         ❌ Rust 调试版本输出
src-tauri/target/release/       ❌ Rust 发布版本输出
dist/                           ❌ 前端编译输出（如果存在）
build/                          ❌ 构建文件夹（如果存在）
```
**原因**：
- 由源代码编译生成，无需版本控制
- 占用大量存储空间
- 平台相关性强

#### 3. **编辑器和 IDE 配置** (推荐忽略)
```
.vscode/                ❌ VS Code 配置（个人偏好）
.idea/                  ❌ JetBrains IDE 配置
*.swp, *.swo            ❌ Vim 临时文件
.DS_Store               ❌ macOS 系统文件
Thumbs.db               ❌ Windows 系统文件
```
**原因**：个人偏好，应该存储在全局 gitignore 或本地配置

#### 4. **日志和临时文件**
```
*.log                   ❌ 日志文件
*.tmp                   ❌ 临时文件
.cache/                 ❌ 缓存目录
```

#### 5. **操作系统特定文件**
```
.DS_Store               ❌ macOS
Thumbs.db               ❌ Windows
*~                      ❌ Linux 备份文件
```

#### 6. **敏感信息文件** (如果存在)
```
.env                    ❌ 环境变量（带密钥）
.env.local              ❌ 本地环境变量
*.key                   ❌ 密钥文件
*.pem                   ❌ 证书文件
```

---

## 📝 .gitignore 配置建议

创建 `.gitignore` 文件，包含以下内容：

```
# === 依赖文件 ===
node_modules/
package-lock.json
yarn.lock
pnpm-lock.yaml
src-tauri/target/

# === 编译输出 ===
dist/
build/
*.o
*.a
*.so

# === 编辑器配置 ===
.vscode/*
!.vscode/extensions.json
!.vscode/launch.json
!.vscode/settings.json.example
.idea/
*.swp
*.swo
*~

# === 系统文件 ===
.DS_Store
Thumbs.db
desktop.ini

# === 日志和临时文件 ===
*.log
npm-debug.log*
yarn-debug.log*
.cache/
*.tmp

# === 敏感信息 ===
.env
.env.local
.env.*.local
*.key
*.pem

# === IDE 特定 ===
.vscode/
.idea/
*.iml
.classpath
.project
.settings/

# === 操作系统 ===
.AppleDouble
.LSOverride
```

---

## 🔄 现在和未来的文件管理策略

### 现在应该上传的类型

| 文件类型 | 示例 | 优先级 | 备注 |
|---------|------|--------|------|
| JavaScript 源文件 | `.js` | ⭐⭐⭐⭐⭐ | 核心业务代码 |
| Rust 源文件 | `.rs` | ⭐⭐⭐⭐⭐ | Tauri 桌面应用 |
| HTML 模板 | `.html` | ⭐⭐⭐⭐⭐ | UI 结构 |
| CSS 样式 | `.css` | ⭐⭐⭐⭐ | 样式设计 |
| 项目配置 | `package.json`, `Cargo.toml` | ⭐⭐⭐⭐⭐ | 依赖和配置 |
| 文档文件 | `.md` | ⭐⭐⭐⭐ | 项目说明和指南 |
| License | `LICENSE` | ⭐⭐⭐⭐ | 法律要求 |

### 未来可能需要的文件类型

| 文件类型 | 用途 | 优先级 | 何时添加 |
|---------|------|--------|---------|
| TypeScript | `.ts` | ⭐⭐⭐ | 迁移到 TypeScript 时 |
| 测试文件 | `.test.js`, `.spec.rs` | ⭐⭐⭐⭐ | 添加单元测试时 |
| GitHub Actions | `.github/workflows/` | ⭐⭐⭐ | 配置 CI/CD 时 |
| Docker 配置 | `Dockerfile`, `.dockerignore` | ⭐⭐ | 容器化部署时 |
| 贡献指南 | `CONTRIBUTING.md` | ⭐⭐⭐ | 开源后 |
| 更新日志 | `CHANGELOG.md` | ⭐⭐⭐ | 发布版本时 |
| API 文档 | `docs/api.md` | ⭐⭐ | API 成熟时 |
| 截图/演示 | `docs/screenshots/` | ⭐⭐ | 增强 README 时 |

---

## 📦 上传前清单

- [ ] 创建 `.gitignore` 文件
- [ ] 检查是否有 `.env` 包含密钥（必须删除或提交 `.env.example`）
- [ ] 确认 `node_modules/` 和 `target/` 在 `.gitignore` 中
- [ ] 所有源代码文件已包含
- [ ] `package.json` 和 `Cargo.toml` 已包含
- [ ] README.md 准备就绪
- [ ] 没有个人编辑器配置泄露
- [ ] 项目大小合理（无大型二进制文件或媒体）

---

## 🚀 首次提交建议命令

```bash
# 初始化 Git 仓库
git init

# 创建 .gitignore 文件（基于上面的配置）
echo "node_modules/" >> .gitignore
# ... 添加其他规则

# 查看哪些文件会被提交
git status

# 添加所有适当的文件
git add .

# 首次提交
git commit -m "Initial commit: Add DtKit project with web and Tauri desktop app"

# 连接远程仓库（替换为你的 GitHub 仓库 URL）
git remote add origin https://github.com/yourname/dtkit.git

# 推送到 GitHub
git branch -M main
git push -u origin main
```

---

## 📌 关键原则

1. **最小化提交体积**：避免提交生成文件和依赖
2. **最大化可维护性**：所有源代码和配置文件都应提交
3. **保护隐私**：环境变量和密钥绝不提交
4. **文档完整**：README 和指南文件必须提交
5. **配置灵活**：`.env.example` 提交，`.env` 忽略
