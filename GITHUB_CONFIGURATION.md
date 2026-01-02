# GitHub 仓库配置指南

> 最后更新：2026年1月2日

## ✅ 已完成的本地配置

### 分支策略

| 分支 | 用途 | 说明 |
|------|------|------|
| `main` | 生产分支 | 稳定版本，仅接受 develop 合并 |
| `develop` | 阶段开发分支 | 功能集成测试 |
| `dev` | 日常开发分支 | 日常开发使用 |

**工作流程**：`dev` → `develop` → `main`

🔗 查看分支：https://github.com/XiaoZhenYa001/Dtkit/branches

---

## 📋 需要在 GitHub 网页界面完成的配置

### 1️⃣ 设置分支保护规则

**为什么需要？**
- 防止直接推送到生产分支
- 强制进行 Pull Request 审查
- 确保代码质量

**操作步骤：**

1. **进入仓库设置**
   - 访问：https://github.com/XiaoZhenYa001/Dtkit/settings/branches
   - 或点击 Settings → Branches

2. **添加分支保护规则**
   - 点击 "Add branch protection rule"

3. **配置 main 分支保护**
   
   **第一个规则 - 保护 main 分支：**
   ```
   Branch name pattern: main
   ```

   勾选以下选项：
   - ☑️ **Require a pull request before merging**
     - 至少需要 1 个批准
   - ☑️ **Require status checks to pass before merging**
     - 如果配置了 CI/CD 工作流程
   - ☑️ **Require branches to be up to date before merging**
   - ☑️ **Require code reviews before merging**
     - Required approving reviews: 1
     - Dismiss stale pull request approvals when new commits are pushed: ✓
   - ☑️ **Require conversation resolution before merging**
   - ☑️ **Include administrators**
     - 确保管理员也受同样规则约束

   点击 "Create"

4. **配置 develop 分支保护（可选但推荐）**
   
   **第二个规则 - 保护 develop 分支：**
   ```
   Branch name pattern: develop
   ```

   勾选选项（同 main，但可以放松要求）：
   - ☑️ **Require a pull request before merging**
     - 至少需要 1 个批准
   - ☑️ **Require code reviews before merging**
   - ☑️ **Require conversation resolution before merging**

---

### 2️⃣ 配置代码审查规则

**为什么需要？**
- 自动请求 CODEOWNERS 审查
- 确保关键文件有人审查
- 防止未经授权的更改

**操作步骤：**

1. **创建 CODEOWNERS 文件**
   
   在本地项目根目录创建文件：`.github/CODEOWNERS`

2. **文件内容示例**

   ```
   # 全局默认负责人
   * @XiaoZhenYa001

   # Web 应用代码
   /src/**                    @XiaoZhenYa001

   # Tauri 桌面应用
   /src-tauri/**              @XiaoZhenYa001

   # 项目配置
   /package.json              @XiaoZhenYa001
   /Cargo.toml                @XiaoZhenYa001
   /tauri.conf.json           @XiaoZhenYa001

   # 文档
   /*.md                       @XiaoZhenYa001
   /docs/**                    @XiaoZhenYa001

   # 配置文件
   /.github/**                 @XiaoZhenYa001
   /.gitignore                 @XiaoZhenYa001
   ```

3. **提交 CODEOWNERS 文件**

   ```bash
   # 创建目录（如果不存在）
   mkdir -p .github
   
   # 添加文件
   git add .github/CODEOWNERS
   git commit -m "docs: Add CODEOWNERS file for code review requirements"
   git push origin develop
   ```

4. **在 GitHub 设置中启用 CODEOWNERS**
   - 进入 Settings → Code and automation → Code security and analysis
   - 启用 "Require code reviews from code owners"（如果可用）

---

### 3️⃣ 配置 Pull Request 审查规则

**操作步骤：**

1. **进入仓库设置**
   - 访问：https://github.com/XiaoZhenYa001/Dtkit/settings
   - 或点击 Settings

2. **配置 Pull Request 模板**

   在本地创建文件：`.github/pull_request_template.md`

   ```markdown
   ## 描述
   请简要描述此 PR 的目的和背景。

   ## 相关问题
   关闭 #(issue number)

   ## 更改类型
   - [ ] 🐛 Bug 修复（非破坏性变更）
   - [ ] ✨ 新功能（非破坏性变更）
   - [ ] 📝 文档更新
   - [ ] ⚙️ 配置变更
   - [ ] 🔄 重构代码
   - [ ] 🎨 样式改进
   - [ ] 🚀 性能优化
   - [ ] ⚠️ 破坏性变更

   ## 测试方法
   请描述测试此变更的步骤：
   1. 
   2. 
   3. 

   ## 检查清单
   - [ ] 我已阅读本项目的 CONTRIBUTING.md
   - [ ] 我的代码遵循项目的编码规范
   - [ ] 我已进行自我审查
   - [ ] 我已添加必要的注释说明
   - [ ] 我的更改没有产生新警告
   - [ ] 我已添加测试用例
   - [ ] 新增和现有单元测试都通过了

   ## 截图/日志（如适用）
   如果是 UI 变更，请添加截图。

   ## 其他信息
   ```

3. **提交 PR 模板**

   ```bash
   git add .github/pull_request_template.md
   git commit -m "docs: Add pull request template"
   git push origin develop
   ```

---

## 🔄 推荐的 Git 工作流程

### 日常开发流程

1. **从 develop 创建功能分支**
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

2. **进行开发和提交**
   ```bash
   git add .
   git commit -m "feat: Add your feature description"
   git push origin feature/your-feature-name
   ```

3. **创建 Pull Request**
   - 进入 GitHub 仓库
   - 点击 "Compare & pull request"
   - 填写 PR 标题和描述
   - 等待代码审查

4. **合并到 develop**
   - 至少 1 人批准
   - 所有讨论解决
   - 点击 "Squash and merge" 或 "Merge pull request"

5. **定期合并到 main**
   ```bash
   git checkout main
   git pull origin main
   git merge develop
   git push origin main
   ```

---

## 📝 分支命名规范

建议遵循以下分支命名规范：

```
main/                    - 生产分支（发布版本）
develop/                 - 开发集成分支
feature/xxx              - 功能分支（来自 develop）
bugfix/xxx               - 修复分支（来自 develop）
hotfix/xxx               - 热修复分支（来自 main）
release/xxx              - 发布准备分支（来自 develop）
docs/xxx                 - 文档分支
chore/xxx                - 配置/依赖更新分支
```

**示例：**
- `feature/user-authentication`
- `bugfix/login-validation`
- `hotfix/security-patch`
- `docs/api-documentation`
- `chore/update-dependencies`

---

## 🚀 配置优先级

**必需（强烈推荐）：**
1. ✅ main 分支保护规则
2. ✅ 创建 CODEOWNERS 文件

**推荐：**
3. develop 分支保护规则
4. Pull Request 模板
5. 自动化测试工作流程（GitHub Actions）

**可选：**
6. 代码覆盖率检查
7. 自动化部署

---

## 📚 相关文档

- [GitHub 分支保护规则官方文档](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- [CODEOWNERS 官方文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [Pull Request 模板官方文档](https://docs.github.com/en/communities/using-templates-for-community-engagement/creating-a-pull-request-template-for-your-repository)

---

## ✨ 下一步建议

1. 配置分支保护规则（15 分钟）
2. 创建并推送 CODEOWNERS 文件（5 分钟）
3. 创建并推送 Pull Request 模板（5 分钟）
4. 配置 GitHub Actions CI/CD（如需要）
5. 添加 CONTRIBUTING.md 贡献指南

完成这些配置后，你的 GitHub 仓库将具备专业级的版本控制和协作功能！
