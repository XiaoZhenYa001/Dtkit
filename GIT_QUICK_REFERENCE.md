# 🚀 GitHub 版本控制快速参考卡片

## 📦 项目基本信息

| 项目 | 信息 |
|------|------|
| **仓库名** | DtKit |
| **所有者** | XiaoZhenYa001 |
| **仓库 URL** | https://github.com/XiaoZhenYa001/Dtkit |
| **SSH URL** | git@github.com:XiaoZhenYa001/Dtkit.git |
| **主分支** | main (生产) |
| **开发分支** | develop (集成测试) |
| **工作分支** | dev (日常开发) |

---

## 🌳 分支结构

```
main (生产发布)
 ↑
 └─── develop (开发集成)
       ↑
       └─── dev (工作分支)
       └─── feature/xxx
       └─── bugfix/xxx
```

---

## ⚡ 快速命令

### 克隆仓库
```bash
git clone git@github.com:XiaoZhenYa001/Dtkit.git
cd Dtkit
```

### 切换到开发分支
```bash
git checkout develop
git pull origin develop
```

### 创建功能分支
```bash
git checkout -b feature/your-feature-name
```

### 提交代码
```bash
# 提交（遵循规范：type(scope): message）
git add .
git commit -m "feat(module): Add feature description"

# 推送
git push origin feature/your-feature-name
```

### 创建 Pull Request
1. 推送分支到 GitHub
2. 进入仓库，GitHub 会提示创建 PR
3. 选择目标分支为 `develop`
4. 填写 PR 模板信息
5. 点击 "Create pull request"

### 更新本地分支
```bash
git fetch origin
git rebase origin/develop
```

### 同步最新代码
```bash
git checkout develop
git pull origin develop
git checkout feature/your-branch
git rebase develop
```

---

## 📝 提交规范

### 格式
```
<type>(<scope>): <subject>
```

### Type 类型
- `feat` - 新功能
- `fix` - Bug 修复
- `docs` - 文档
- `style` - 代码格式
- `refactor` - 重构
- `perf` - 性能优化
- `test` - 测试
- `chore` - 配置/依赖

### 示例
```bash
git commit -m "feat(tools): Add new unit converter"
git commit -m "fix(core): Fix memory leak in compressor"
git commit -m "docs: Update README"
```

---

## ✅ 分支保护规则

### main 分支
- ✅ 必须通过 Pull Request
- ✅ 需要至少 1 人审查批准
- ✅ 需要通过 CI/CD 检查
- ✅ 必须解决所有讨论
- ✅ 包括管理员

### develop 分支
- ✅ 必须通过 Pull Request
- ✅ 需要至少 1 人审查批准
- ✅ 必须解决所有讨论

---

## 📋 Check List

### 提交前检查
- [ ] 代码已本地测试
- [ ] 遵循提交规范
- [ ] 添加必要注释
- [ ] 没有调试代码
- [ ] 没有个人信息

### PR 提交前检查
- [ ] 填写完整 PR 描述
- [ ] 选择正确的变更类型
- [ ] 选择目标分支（通常是 develop）
- [ ] 没有冲突
- [ ] 通过自动检查

### 代码审查清单
- [ ] 代码逻辑正确
- [ ] 遵循项目规范
- [ ] 有适当注释
- [ ] 没有安全问题
- [ ] 性能可接受

---

## 🚫 禁止事项

❌ **绝不要：**
- 直接推送到 `main` 分支
- 直接推送到 `develop` 分支（使用 PR）
- 提交密钥或敏感信息
- 提交大型二进制文件
- 强制推送到 `main` 或 `develop`

---

## 📞 常用命令速查

| 命令 | 说明 |
|------|------|
| `git status` | 查看状态 |
| `git log` | 查看提交历史 |
| `git branch -a` | 列出所有分支 |
| `git diff` | 查看变更 |
| `git fetch` | 获取远程更新 |
| `git pull` | 拉取更新 |
| `git push` | 推送代码 |
| `git merge` | 合并分支 |
| `git rebase` | 变基分支 |
| `git tag` | 创建标签 |

---

## 📚 相关文件

| 文件 | 用途 |
|------|------|
| `.github/CODEOWNERS` | 代码所有者 |
| `.github/pull_request_template.md` | PR 模板 |
| `CONTRIBUTING.md` | 贡献指南 |
| `GITHUB_CONFIGURATION.md` | 配置说明 |
| `GITHUB_BRANCH_PROTECTION_GUIDE.md` | 分支保护指南 |
| `.gitignore` | 忽略规则 |

---

## 🔗 快速链接

- 🏠 [仓库](https://github.com/XiaoZhenYa001/Dtkit)
- 🌳 [分支](https://github.com/XiaoZhenYa001/Dtkit/branches)
- 📋 [Issues](https://github.com/XiaoZhenYa001/Dtkit/issues)
- 🔀 [Pull Requests](https://github.com/XiaoZhenYa001/Dtkit/pulls)
- ⚙️ [设置](https://github.com/XiaoZhenYa001/Dtkit/settings)
- 🔒 [分支保护](https://github.com/XiaoZhenYa001/Dtkit/settings/branches)

---

## 💡 工作流程示例

### 日常开发流程

```bash
# 1. 启动工作
git checkout develop
git pull origin develop
git checkout -b feature/user-login

# 2. 开发和提交
echo "// New feature" >> src/feature.js
git add src/feature.js
git commit -m "feat(auth): Add user login functionality"

# 3. 推送到 GitHub
git push origin feature/user-login

# 4. 创建 PR（在 GitHub 网页上）
# - 自动应用 PR 模板
# - 自动请求 Code Owner 审查

# 5. 审查和修改（如需要）
git add .
git commit -m "fix(auth): Update login validation"
git push origin feature/user-login

# 6. 合并（审查批准后）
# 在 GitHub 上点击 "Squash and merge"

# 7. 本地清理
git checkout develop
git pull origin develop
git branch -d feature/user-login
```

---

## 🎯 目标状态

✅ **完成的配置**
- [x] Git 仓库初始化
- [x] 三个分支创建（main, develop, dev）
- [x] 代码推送到 GitHub
- [x] CODEOWNERS 文件
- [x] PR 模板
- [x] 贡献指南

⏳ **需要网页配置**
- [ ] main 分支保护规则
- [ ] develop 分支保护规则

---

## 📞 需要帮助？

查看以下文档：
- 详细配置：[GITHUB_CONFIGURATION.md](GITHUB_CONFIGURATION.md)
- 分支保护：[GITHUB_BRANCH_PROTECTION_GUIDE.md](GITHUB_BRANCH_PROTECTION_GUIDE.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
- 上传指南：[GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md)

---

**最后更新：** 2025年12月18日

**保持代码整洁，贡献快乐！** 🚀
