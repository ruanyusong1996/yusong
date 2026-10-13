# 部署到公网：手把手操作手册

> 目标：拿到一个永久公网链接（类似 `https://gh-dashboard.up.railway.app`），发给别人就能访问并多人协作。

整套流程分 3 步，全程 5–10 分钟。我先帮你把所有能跑的命令都准备好了，你只需要在 2 个网站点点鼠标。

---

## 第 1 步：在 GitHub 创建一个空仓库

> 这一步**完全不需要任何代码**，就是网页上点几下。

1. 打开 https://github.com/new （需要先登录 GitHub，没有账号就点右上角 Sign up 注册，免费）
2. 填表：
   - **Repository name**：`gh-dashboard`（名字随便起，后面要用）
   - **Description**：可不填
   - **Public / Private**：选 `Public`（Railway 免费层只支持 Public 私有仓库要付费）
   - 下面四个勾选框**全部不要勾**（不勾 Add README、不勾 Add .gitignore、不勾 Choose a license）
3. 点绿色按钮 **Create repository**
4. 创建后会跳到一个新页面，中间会有一块"…or push an existing repository from the command line"，**记下这个 SSH 地址**：
   ```
   git@github.com:<你的用户名>/gh-dashboard.git
   ```
   或者 HTTPS 地址：
   ```
   https://github.com/<你的用户名>/gh-dashboard.git
   ```

记下你的 **GitHub 用户名** 和仓库地址，下一步要用。

---

## 第 2 步：把本地代码推到 GitHub

打开终端（macOS 按 `⌘ + Space` 搜"终端"），**复制粘贴下面这一整段**：

### 如果上面记的是 HTTPS 地址（推荐新手用）：

```bash
cd /Users/yusong/WorkBuddy/2026-10-13-14-12-54/output

git remote add origin https://github.com/你的用户名/gh-dashboard.git
git push -u origin main
```

把 `你的用户名` 换成你 GitHub 真实用户名。运行时：
- 第一次 push 会弹窗问账号密码 → **密码那栏不是填 GitHub 密码**，要填 **Personal Access Token**
  - 没有 Token？浏览器开 https://github.com/settings/tokens/new ，Note 随便填（如 `mac-push`），Expiration 选 `90 days`，Scope 勾选 **`repo`**，点最下面的 **Generate token**
  - 复制那串以 `ghp_` 开头的 token，当密码粘贴进去
- 看到一串文件上传进度 + `Branch 'main' set up to track ...` 就成功了

### 如果上面记的是 SSH 地址（无需输密码，但要配 SSH key）：

```bash
cd /Users/yusong/WorkBuddy/2026-10-13-14-12-54/output

# 配 SSH（一次性）
ssh-keygen -t ed25519 -C "你的邮箱@example.com"        # 全程回车
cat ~/.ssh/id_ed25519.pub | pbcopy                       # 公钥已复制
```

把这段粘到 https://github.com/settings/keys → **New SSH key** → Title 写个名字、Key 直接 `⌘V` 粘贴 → **Add SSH key**。

然后回到终端：

```bash
git remote add origin git@github.com:你的用户名/gh-dashboard.git
git push -u origin main
```

看到 `Branch 'main' set up to track ...` 就算成功。

### 验证

刷新 GitHub 仓库页面，应该能看到 16 个文件。✅

---

## 第 3 步：在 Railway 部署

1. 打开 https://railway.app/new
2. 点击 **Login with GitHub**（用刚登录过的 GitHub 账号直接授权）
3. 点 **Deploy from GitHub repo**
4. 在仓库列表里找到 `gh-dashboard`（如果列表为空，先点旁边的 **Configure GitHub App** 授权 Railway 访问你的仓库）
5. 点仓库名称 → **Deploy Now**
6. Railway 自动开始：
   - 用 Nixpacks 检测到 Node 项目
   - `npm install`（装依赖，约 30 秒）
   - `npm start`（启动 server.js）
7. 等右上方 Logs 显示 `Server listening on http://0.0.0.0:PORT` 就部署成功了

---

## 第 4 步：拿到公网链接

1. 在 Railway 项目页面，点你的服务（中间那个卡片，名字通常自动取了仓库名）
2. 顶部标签切到 **Settings**
3. 往下翻到 **Networking** 区块
4. 点 **Generate Domain** 按钮
5. 几秒后出现一个地址，类似 `gh-dashboard-production.up.railway.app`
6. **复制它**

这就是你的公网链接。访问方式：
- 看板：`https://gh-dashboard-production.up.railway.app/`
- 后台：`https://gh-dashboard-production.up.railway.app/admin.html`

把这个链接发给同事，他们打开就能看到你的看板。

---

## ⚠️ 关键提醒：Railway 免费层会休眠

**每 15 分钟没人访问，容器自动休眠；下次唤醒时容器重建，`server-data.json` 丢失，数据回到初始的 20/13/7。**

应付办法（任选其一即可）：

### 方案 A：定期备份（最简单）

每次更新数据后，进后台 → 右上角 **导出 JSON** → 下载一份到本地。出问题时你点重置再上传这个 JSON 即可。

### 方案 B：自动备份到 GitHub（推荐）

每个礼拜让 Railway 把 `server-data.json` 自动 commit 回 GitHub，告诉我我可以加。

### 方案 C：用真数据库（最稳）

把 JSON 文件换成 Railway 自带的 Postgres，告诉我我可以改 `server.js`，加数据库适配层 —— 这样容器重建数据也不会丢。

---

## 推送失败/卡住了？常见原因

| 现象 | 原因 | 解决 |
|---|---|---|
| `Authentication failed for ...` | 用了 HTTPS 但密码写成了 GitHub 密码 | 去 https://github.com/settings/tokens 生成 token 当密码填 |
| `Repository not found` | 用户名写错了 | `git remote set-url origin https://github.com/正确的用户名/gh-dashboard.git` |
| `Permission denied (publickey)` | 用了 SSH 但没配 key | 回到第 2 步的 SSH 配置段 |
| Railway 找不到仓库 | 没授权 Railway 访问你的 repo | 点 **Configure GitHub App** → 选仓库 |
| 部署失败 Logs 里写 `Cannot find module 'express'` | node_modules 没被 commit（这是对的）| Railway 应当自动 `npm install`，等着就行；如失败，Service → **Restart** |

实在推不动代码？最笨的备选：
1. 在 GitHub 仓库页面点 **uploading an existing file**（或拖拽）
2. 把 `/Users/yusong/WorkBuddy/2026-10-13-14-12-54/output/` 里除了 `node_modules` 和 `.git` 的所有文件拖进去
3. 点 **Commit changes**
4. 之后回到第 3 步 Railway 部署

部署成功拿到链接后，把链接发给我，我帮你验证多人协作效果（同时改、跨地区访问）。
