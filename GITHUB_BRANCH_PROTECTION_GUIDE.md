# GitHub 分支保护规则配置指南（图文版）

## 快速导航

- [完整配置步骤](#完整配置步骤)
- [main 分支保护规则](#main-分支保护规则配置)
- [develop 分支保护规则](#develop-分支保护规则配置)
- [配置检查清单](#配置检查清单)

---

## 完整配置步骤

### 步骤 1：进入仓库设置页面

1. 打开 GitHub 仓库：https://github.com/XiaoZhenYa001/Dtkit
2. 点击 **Settings** 标签
3. 在左侧菜单中选择 **Branches**

### 步骤 2：添加分支保护规则

1. 点击 **Add branch protection rule** 按钮
2. 在 "Branch name pattern" 输入框中输入分支名称

---

## main 分支保护规则配置

### 配置值

| 配置项 | 值 |
|--------|-----|
| Branch name pattern | `main` |

### 必选配置项

| 配置项 | 状态 | 说明 |
|--------|------|------|
| Require a pull request before merging | ✅ | 所有更改必须通过 PR |
| Require status checks to pass before merging | ✅ | PR 必须通过 CI/CD 检查 |
| Require branches to be up to date before merging | ✅ | 合并前必须同步最新代码 |
| Require code reviews before merging | ✅ | 需要代码审查批准 |
| Require conversation resolution before merging | ✅ | 必须解决所有讨论 |
| Include administrators | ✅ | 管理员也受规则约束 |

### 代码审查规则

```
Required approving reviews: 1
```

- 勾选：Dismiss stale pull request approvals when new commits are pushed
- 勾选：Require review from Code Owners

### 完整配置截图参考

```
┌─────────────────────────────────────────────────────────┐
│ Add a rule to protect matching branches                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Branch name pattern: [main             ]               │
│                                                         │
│ ☑ Require a pull request before merging                │
│   └─ Required approving reviews: [1]                   │
│      ☑ Dismiss stale PR approvals on new commits       │
│      ☑ Require review from Code Owners                 │
│                                                         │
│ ☑ Require status checks to pass before merging         │
│   └─ Require branches to be up to date before merging  │
│                                                         │
│ ☑ Require conversation resolution before merging       │
│                                                         │
│ ☑ Include administrators                               │
│                                                         │
│ [ Create ] [ Cancel ]                                  │
└─────────────────────────────────────────────────────────┘
```

---

## develop 分支保护规则配置

### 配置值

| 配置项 | 值 |
|--------|-----|
| Branch name pattern | `develop` |

### 推荐配置项

| 配置项 | 状态 | 说明 |
|--------|------|------|
| Require a pull request before merging | ✅ | 所有更改必须通过 PR |
| Require code reviews before merging | ✅ | 需要代码审查 |
| Require conversation resolution before merging | ✅ | 必须解决讨论 |
| Include administrators | ✅ | 管理员也受约束 |

### 代码审查规则

```
Required approving reviews: 1
```

---

## GitHub 在线配置步骤（详细版）

### 1. 访问分支保护设置

```
GitHub 仓库
    ↓
Settings (仓库设置)
    ↓
Branches (左侧菜单)
    ↓
Add branch protection rule
```

### 2. 第一个规则：保护 main 分支

**步骤：**

1. 填写分支名称
   ```
   Branch name pattern: main
   ```

2. 勾选 **Require a pull request before merging**
   ```
   ☑ Require a pull request before merging
   ```

3. 设置审查要求
   ```
   Required approving reviews: 1
   
   ☑ Dismiss stale pull request approvals when new commits are pushed
   ☑ Require review from Code Owners
   ```

4. 勾选 **Require status checks to pass before merging**
   ```
   ☑ Require status checks to pass before merging
   ☑ Require branches to be up to date before merging
   ```

5. 勾选 **Require conversation resolution before merging**
   ```
   ☑ Require conversation resolution before merging
   ```

6. 勾选 **Include administrators**
   ```
   ☑ Include administrators
   ```

7. 点击 **Create**

### 3. 第二个规则：保护 develop 分支

重复步骤 2，但分支名称改为 `develop`

---

## 配置检查清单

### main 分支保护规则

- [ ] 进入 Settings → Branches
- [ ] 点击 "Add branch protection rule"
- [ ] 输入分支名称：`main`
- [ ] ✅ Require a pull request before merging
- [ ] ✅ Required approving reviews: `1`
- [ ] ✅ Dismiss stale pull request approvals
- [ ] ✅ Require review from Code Owners
- [ ] ✅ Require status checks to pass
- [ ] ✅ Require branches to be up to date
- [ ] ✅ Require conversation resolution
- [ ] ✅ Include administrators
- [ ] 点击 **Create**

### develop 分支保护规则

- [ ] 点击 "Add branch protection rule"
- [ ] 输入分支名称：`develop`
- [ ] ✅ Require a pull request before merging
- [ ] ✅ Required approving reviews: `1`
- [ ] ✅ Require conversation resolution
- [ ] ✅ Include administrators
- [ ] 点击 **Create**

### CODEOWNERS 配置

- [ ] `.github/CODEOWNERS` 文件已创建
- [ ] 文件已推送到 GitHub
- [ ] 在分支保护规则中勾选 "Require review from Code Owners"

### Pull Request 模板

- [ ] `.github/pull_request_template.md` 文件已创建
- [ ] 文件已推送到 GitHub
- [ ] 在 GitHub 创建 PR 时自动应用模板

---

## 预期效果

### 保护规则生效后

✅ **强制执行 Pull Request 流程**
- 无法直接推送到 `main` 分支
- 所有代码必须通过 PR 提交

✅ **自动代码审查**
- PR 自动请求 CODEOWNERS 审查
- 需要至少 1 人批准

✅ **防止过期审查**
- 新提交后旧批准自动失效
- 需要重新审查最新代码

✅ **强制讨论解决**
- PR 上的所有讨论必须解决
- 防止遗留问题

✅ **同步最新代码**
- 合并前必须同步远程最新代码
- 防止合并冲突

---

## 工作流程示例

### 有了分支保护规则后

```
开发者创建功能分支
    ↓
git checkout -b feature/new-feature
    ↓
进行开发和提交
    ↓
git push origin feature/new-feature
    ↓
在 GitHub 创建 Pull Request
    ↓
❌ 尝试直接推送到 main → 被拒绝
    ↓
PR 自动请求 Code Owner 审查
    ↓
审查者审查代码
    ↓
批准 PR
    ↓
解决所有讨论
    ↓
✅ 点击 "Merge pull request"
    ↓
代码合并到 develop
    ↓
（定期）手动合并 develop 到 main
```

---

## 常见问题

### Q: 为什么我无法直接推送到 main？

**A:** 这是分支保护规则的预期行为，确保所有代码都经过审查。
请通过 Pull Request 提交更改。

### Q: 如何绕过审查规则？

**A:** 不建议绕过。如确实需要，只有仓库所有者可以在特殊情况下禁用。

### Q: CODEOWNERS 有什么作用？

**A:** 自动指定谁必须审查代码。`@XiaoZhenYa001` 会自动被添加为审查者。

### Q: 我可以否决自己的 PR 吗？

**A:** 通常不行。大多数配置要求其他人批准。

### Q: 如何更新分支保护规则？

**A:** 进入 Settings → Branches，点击规则进行编辑。

---

## 技术支持

- 📖 [GitHub 官方文档](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- 🔗 [CODEOWNERS 文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- 💬 [GitHub Community](https://github.community)

---

**祝你使用愉快！** 🚀
