# 部署到公网：手把手操作手册

> 目标：拿到一个公网链接（形如 `https://yusong-production-xxxx.up.railway.app`），发给别人就能访问并多人协作。

---

## ✅ 你的进度

| 步骤 | 状态 |
|---|---|
| 第 1 步 在 GitHub 创建仓库 | ✅ 已完成（`github.com/ruanyusong1996/yusong`） |
| 第 2 步 推送代码 | ✅ 已完成（远程 main 分支已有 2 个提交） |
| **第 3 步 Railway 部署** | ⬅ **你在这里** |
| 第 4 步 生成公网链接 | 待做 |
| 第 5 步 挂磁盘保数据 | 待做（强烈建议） |

**从第 3 步开始照着做就行。**

---

# 第 3 步：在 Railway 部署（★ 2026 最新界面）

> ⚠️ **你找不到界面，是因为 Railway 改版了**：旧教程里的 "Deploy from GitHub repo" 已经**改名为 "GitHub Repository"**，而且整个页面布局也换了。

## 3.1 先登录

1. 打开 👉 **https://railway.com/new**
2. 页面底部会弹出一长条 **cookie 提示**（中文）→ 点右边的 **「全部接受」** 关掉它
3. 看**右上角**的 **Login** → 点它
4. 在弹出页选 **Continue with GitHub**（用 GitHub 账号一键登录，不用另注册）
5. 第一次会跳到 GitHub 问「Authorize Railway」→ 点绿色 **Authorize** 按钮

## 3.2 创建项目

登录后再次打开 👉 **https://railway.com/new**

页面正中间会出现这样一张卡片（就是下面截图的样子）：

![Railway 新建项目界面](railway-new-ui.png)

框里从上到下是：

| 位置 | 选项 | 说明 |
|---|---|---|
| ① 顶部输入框 | **Describe your project or paste a repo link** | 偷懒通道：直接粘仓库链接 |
| ② 第一个卡片 | **GitHub Repository** | ← **点这个**（就是旧版的 "Deploy from GitHub repo"） |
| ③ | Database / Template / Docker Image / Function / Bucket / Sandbox | 都不点 |

**两种走法，任选一种：**

### 走法 A（最快，推荐）

直接在 **① 那个输入框** 里粘贴你的仓库地址，回车：

```
https://github.com/ruanyusong1996/yusong
```

### 走法 B（常规）

点 **② GitHub Repository** → 弹出仓库列表 → 找到 **`yusong`** → 点它

> 如果列表是空的、并提示 "Configure GitHub App"，说明 Railway 还没拿到你 GitHub 仓库的权限：
> 点 **Configure GitHub App** → 选 **Only select repositories** → 勾上 `yusong` → **Save** → 再回到 `railway.com/new` 重来。

## 3.3 开始部署

- 如果弹出配置页，直接点右下角 **Deploy Now**（**不用改任何设置**，`railway.toml` 已经替你配好了）
- Railway 自动执行：装依赖 → 识别为 Node 项目 → 跑 `node server.js`
- 等 **1～2 分钟**，直到日志里出现这几行白字：

```
海底捞集团工会工作数据看板 - 后端服务
数据文件:   /app/server-data.json
Server listening on http://0.0.0.0:xxxx
```

看到 `Server listening` 就说明服务跑起来了 ✅

---

# 第 4 步：生成公网链接

服务跑起来还只是内网，要手动开个公网门：

1. 在项目画布上**点一下你的服务卡片**
2. 顶部标签切到 **Settings**
3. 往下翻，找到 **Networking** 区块
4. 点 **Generate Domain** 按钮
5. 几秒后出现一行地址，形如 `yusong-production-xxxx.up.railway.app`
6. 点右边的**复制按钮** —— 这就是你要发出去的链接

访问方式：

- 📊 看板：`https://yusong-production-xxxx.up.railway.app/`
- ⚙️ 后台：`https://yusong-production-xxxx.up.railway.app/admin.html`

把链接发给同事，他们打开就能看、也能直接改数据，改动会实时同步给所有人。

---

# 第 5 步：挂一块磁盘，让数据永不丢失（强烈建议）

> **为什么必须做**：Railway 免费层在你长时间不访问后会把容器重启一遍，重启时 `/app` 目录回到代码初始状态 —— 你改的所有数据会**退回初始的 20/13/7**。挂一块 Volume 就彻底解决。

1. 在项目画布**空白处右键**（或点右上角 **+ Create**）
2. 选 **Volume**
3. 创建后，把 **Mount path（挂载路径）** 填成：
   ```
   /data
   ```
4. 回到你的**服务** → **Variables** 标签 → **+ New Variable**，加一条：

   | 变量名 | 值 |
   |---|---|
   | `DATA_DIR` | `/data` |

   > 这是 `server.js` 内置支持的开关：设了它，数据文件就写到 `/data/server-data.json`，也就是那块**不会丢的磁盘**上。

5. 加完变量 Railway 会自动重新部署一次。等它跑完，就齐活了 —— 以后不管容器重启多少次，数据都还在。

---

## ⚠️ 关于费用：Railway 免费层额度很小

Railway 现在**没有永久免费**了，只有：

| 计划 | 额度 | 说明 |
|---|---|---|
| Free Trial | $5 一次性，30 天有效 | 新账号自动给 |
| Free | **$1 / 月** | 试用到期后自动转这个 |
| Hobby | $5 / 月 | 含 $5 用量额度 |

你这个服务很轻（Node + 42KB 数据），空闲时内存约 100MB 左右：

- 内存成本 ≈ 0.1GB × $10/GB/月 ≈ **$1 / 月**

也就是说**刚好卡在免费层的 $1 额度边缘**，可能够、也可能偶尔超一点点。真跑起来后可以去 **Settings → Usage** 看实际消耗。

**如果不想操心**，随时可以切到别的平台（见文末）。

---

## 常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 打开 railway.com/new 只有营销页，没有卡片列表 | 没登录 / 没关 cookie 弹窗 | 先点右上角 **Login** → Continue with GitHub；再点「全部接受」 |
| 仓库列表里找不到 `yusong` | Railway 没拿到 GitHub 权限 | 点 **Configure GitHub App** → 勾选 `yusong` → Save |
| 部署失败，日志 `Cannot find module 'express'` | 依赖没装上 | 等它自动重试；或 Service → 右上 **⋯** → **Redeploy** |
| 部署成功但链接打不开 | 忘了 Generate Domain | 回到第 4 步 |
| 数据用着用着变回 20/13/7 | 容器重建丢数据 | 做第 5 步挂 Volume |
| 页面能开但一直显示"本地存储"徽章 | 前端没连上后端 | 确认日志里没有报错、`/api/health` 能打开 |

---

## 如果 Railway 还是走不通，换这几个平台（都更快）

| 平台 | 免费额度 | 特点 |
|---|---|---|
| **Zeabur** | 每月 $5 credits | 有**香港/新加坡节点**，国内访问快很多，中文界面，步骤和 Railway 几乎一样 |
| **Render** | 真免费 | 但 15 分钟无访问会休眠，唤醒要等 30 秒 |
| **Fly.io** | 有免费额度 | 需要命令行操作 |

**Zeabur 尤其值得考虑** —— 你这个是中文团队协作场景，HK/SG 节点延迟能低 100～150ms，体验差别很明显，而且 $5/月的免费额度比 Railway 的 $1 宽松 5 倍。

需要我换到 Zeabur 或者帮你把数据存进数据库（彻底不依赖磁盘），直接说。

---

部署完成拿到链接后，把链接发我，我帮你验证多人协作效果（同时改、跨地区访问）。
