# 海底捞集团工会工作数据看板

一个可多人协作的工会数据看板：**前台大屏看板** + **后台数据管理**，数据存在服务端，多人同时访问共享同一份数据，改完秒级同步。

---

## 一、快速开始

```bash
# 1. 进入目录
cd output

# 2. 安装依赖（首次运行，仅一次）
npm install

# 3. 启动服务
npm start
# 或指定端口
node server.js --port=8080
```

启动后浏览器打开：

| 页面 | 地址 | 用途 |
|---|---|---|
| 数据看板 | http://localhost:5300/ | 大屏展示，点击数字跳明细 |
| 后台管理 | http://localhost:5300/admin.html | 增删改数据 |

### 局域网内多人共享

1. 找到本机内网 IP：
   ```bash
   # macOS
   ipconfig getifaddr en0
   # Linux
   hostname -I | awk '{print $1}'
   ```
2. 把 `http://<你的IP>:5300/` 发给同事，例如 `http://192.168.1.20:5300/admin.html`
3. 大家访问同一个地址 → 数据天然共享。A 改一条，B 的看板 1 秒内自动刷新。

> 首次从别的电脑访问可能被系统防火墙拦截，需要允许 Node 进程接听入站连接。

---

## 二、文件结构

```
output/
├── server.js            # 后端服务：REST API + SSE + 静态托管
├── package.json         # 依赖声明
├── server-data.json     # ★ 实际数据文件（运行时生成，改这个就是改数据）
├── seed-data.json       # 初始数据（首次启动时复制为 server-data.json）
├── seed-data.js         # 同上的 JS 版本（供 file:// 离线模式使用）
│
├── index.html           # 看板页面
├── app.js               # 看板逻辑：汇总计算 + 图表 + 明细弹层
├── styles.css           # 看板样式（科技蓝主题）
│
├── admin.html           # 后台管理页面
├── admin.js             # 后台逻辑：表格编辑 + 校验 + 导入导出
├── admin.css            # 后台样式
│
├── data-store.js        # ★ 数据访问层：自动在「API 模式」和「本地模式」间切换
├── lib/echarts.min.js   # 本地图表库（无外网依赖）
├── node_modules/        # 依赖（npm install 生成）
│
├── test-persistence.js       # 回归测试 A：数据持久化（含「静默降级必须上报」）
├── test-auth-config.sh       # 回归测试 B：鉴权 / 配置 / 备份（78 项）
├── test-e2e-cdp.js           # 回归测试 C：真实浏览器 E2E（CDP 驱动）
├── run-auth-test-local.js    # 本地跑 B 的包装（同进程起服务）
└── run-e2e-local.js          # 本地跑 C 的包装（同进程起服务）
```

---

## 三、数据存取原理

`data-store.js` 启动时会探测同源的 `/api/health`：

- **探测成功** → **API 模式**（多人共享）
  - 读数据：`GET /api/data`
  - 写数据：`PUT /api/data`（服务端原子写入 `server-data.json`）
  - 实时同步：`EventSource /api/stream`（SSE）——服务端推、浏览器自动重连
- **探测失败** → **本地模式**（单人离线）
  - 使用 `localStorage`，跨 tab 靠 `storage` 事件同步

所以：

- 用 `npm start` 打开 → 自动多人共享
- 直接双击 `index.html`（`file://`）打开 → 自动本地模式，无需后端也能看

页面右上角有状态徽章：**云端共享**（青色）/ **本地存储**（绿色）/ **已断线**（红色）。

---

## 四、API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查，返回 `{ok, ts, clients, version, persistent, storageMode, dataMtime}`；**`persistent` 用来判断数据是否会随重新部署丢失** |
| `GET` | `/api/data` | 拉取全部数据 |
| `PUT` | `/api/data` | 覆盖保存全部数据（JSON body），成功后向所有 SSE 客户端广播；空数据 / 会把全部行清空的写入会被拒绝（400） |
| `POST` | `/api/reset` | 重置为 `seed-data.json` 初始数据（写前自动快照） |
| `GET` | `/api/config` | 拉取看板配置（文字/主题/布局/模块/指标/图表/统计表） |
| `PUT` | `/api/config` | 覆盖保存看板配置，并向所有 SSE 客户端广播 `config` 事件 |
| `GET` | `/api/storage` | 🔒 存储诊断：数据目录、是否持久、行数、快照数量与修复建议 |
| `GET` | `/api/backups` | 🔒 快照列表（含时间、类型、行数、大小） |
| `POST` | `/api/backups` | 🔒 手动打一份快照 `{kind: 'data'\|'config'}` |
| `POST` | `/api/backups/restore` | 🔒 用指定快照覆盖回去 `{name}`（覆盖前自动再存一份当前版本） |
| `POST` | `/api/auth/login` \| `logout` \| `password` | 🔑 登录 / 退出 / 改密码 |
| `GET` | `/api/auth/status` | 🔑 当前会话角色 |
| `GET` | `/api/stream` | SSE 事件流，事件类型：`hello` / `update` / `config` |

> 🔒 = 需要后台密码；🔑 = 鉴权相关；其余需要看板密码（`/api/health`、`/login.html` 公开）

示例：

```bash
# 查看数据
curl http://localhost:5300/api/data

# 重置数据
curl -X POST http://localhost:5300/api/reset
```

---

## 五、数据字段说明

数据按 4 个模块组织，每一模块为 `{ title, subtitle, headers, rows }`：

| 模块 Key | 标题 | 记录数 | 主要字段 |
|---|---|---|---|
| `01-组织建设` | 工会组织建设 | 20 | 工会名称、依托公司、工会主席、职工人数、组建状态、工会级别、备注 |
| `02-走访慰问` | 员工走访慰问 | 56 | 慰问类型、员工姓名、所在大区、部门/门店、慰问日期、物品金额、事由、经办人 |
| `03-员工活动` | 员工活动 | 52 | 活动日期、内容、形式、类型、区域、组织部门、覆盖人数、支出金额 |
| `04-经费收支` | 工会经费收支 | 7 | 工会名称、收支类型、经费项目、年初金额、支出金额、结余、事由、经办人 |

看板上的所有汇总数字（工会总数、已组建数、走访人次、活动场次、经费结余……）都是**从明细实时计算**的，不是写死的。

---

## 六、部署到 Railway（5 分钟拿到公网链接）

Railway 每月送 **$5 免费额度**，你这服务内存 60MB、流量几乎为零，跑几个月都没问题。部署后拿到一个 `https://xxx.up.railway.app` 的固定链接，**关电脑也不影响**，可发给任何人访问。

### 步骤 1：把代码推到 GitHub

```bash
cd output            # 进入项目目录

# 如果你已经有 GitHub 账号并配置了 SSH key
git init
git add .
git commit -m "init: 工会数据看板"
git branch -M main
git remote add origin git@github.com:<你的用户名>/gh-dashboard.git
git push -u origin main
```

> 还没配 SSH key？最快的方式是用 [GitHub CLI](https://cli.github.com/)：`brew install gh && gh auth login`，然后 `gh repo create gh-dashboard --public --source=. --push` 一行搞定。
>
> 或者用 HTTPS：`git remote add origin https://github.com/<用户名>/gh-dashboard.git`，第一次推送要输用户名 + [Personal Access Token](https://github.com/settings/tokens)。

### 步骤 2：在 Railway 创建项目

1. 打开 https://railway.app/new
2. 点击 **Deploy from GitHub repo**
3. 授权 Railway 访问你的 GitHub，选择刚才创建的 `gh-dashboard` 仓库
4. Railway 自动检测到 Node 项目，按 `railway.toml` 配置开始构建部署

### 步骤 3：拿到公网链接

部署完成后：
1. 在 Railway 项目页点击你的服务
2. 切到 **Settings** → **Networking** → **Generate Domain**
3. 复制生成的 `https://xxx.up.railway.app` —— 这就是你的公网链接

### 步骤 4：把链接发给大家

看板：`https://xxx.up.railway.app/`
后台：`https://xxx.up.railway.app/admin.html`

两个人同时打开后台，**任一人改动，另一人秒级看到**。

> ⚠️ **重要 - 数据持久化**：Railway 容器**重新部署 / 重启时，代码目录 `/app` 会被整体替换**，
> 数据文件写在里面就会丢。这就是「每次改完就变回 20/13/7」的原因。
>
> **正确的解决办法：挂一块 Volume**（不是加 Postgres）。入口在 **`⌘K` 命令面板 → `volume`**，
> 或**画布空白处右键 → Volume**，挂载路径必须填 `/data`。详见 `DEPLOY_GUIDE.md` 第 5 步。
> 挂上后程序会自动识别 `/data`，**不需要改任何代码**；`GET /api/health` 的 `persistent`
> 会变成 `true`，后台「安全设置 → 数据存储与备份」也会显示 🟢 已开启。
>
> 没挂卷时程序不会静默失败：后台顶部会常驻红色告警条，`/api/health` 会如实报 `persistent: false`。
> 保险起见，也可以在后台点「导出 JSON」手动留一份本地备份。

### 备选：自有服务器 + PM2

```bash
# 上传 output/ 到服务器
npm install -g pm2
cd output && npm install
pm2 start server.js --name gh-dashboard
pm2 save && pm2 startup
```

Nginx 反代必须关缓冲（SSE 必需）：

```nginx
location / {
    proxy_pass http://127.0.0.1:5300;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_set_header Host $host;
    proxy_buffering off;          # ★ SSE 必需
    proxy_cache off;
    proxy_read_timeout 3600s;
}
```


---

## 七、注意事项

1. **并发写入**：服务端对写操作做了串行化（`writeChain`）+ 原子替换（先写 `.tmp` 再 rename），避免并发把文件写坏。
2. **多人同时改同一条**：采用「后写覆盖」策略（last-write-wins）。如果需要字段级合并或版本冲突检测，需要再加一层乐观锁。
3. **登录鉴权**：看板页需「看板密码」，后台页与所有写接口需「后台密码」；两个密码可在后台「安全设置」里随时修改。密码用 scrypt + 随机盐哈希存储，会话走 HttpOnly Cookie（12 小时有效、内存态、重启即失效）。
4. **数据备份**：直接复制 `server-data.json` 即可；后台页面的「导出 JSON」也能下载快照。
5. **看板配置会被服务端兜底收敛**：`PUT /api/config` 与 `GET /api/config` 都会跑一遍
   `normalizeConfig()` —— 图表色板必须是合法颜色数组、列宽必须是 1~12 的整数，
   不符合的会被自动修正并在响应里回传 `warnings`。**这样即使前端有类型 bug、
   或磁盘上已经存了一份坏配置，看板也不会渲染失败。**（历史故障：色板被存成逗号
   字符串 `"#4DD8FF,#5FE0FF,…"`，ECharts 逐字符取色拿到 `'#'` →
   `addColorStop` 抛异常 → 所有图表渲染成黑色。）
6. **SSE 与代理**：经 Nginx / 云负载均衡时务必关闭响应缓冲，否则推送会被攒着不发出。

---

## 八、回归测试

改完代码后**务必全跑一遍**，尤其是 `test:persist` —— 它守的就是「重新部署数据被清空」这条底线。

```bash
npm run test:persist           # 53 项：数据目录解析 / 重启后数据还在 / 防误清空 / 备份恢复 / 降级告警
npm run test:api               # 78 项：鉴权、配置、备份、静态文件白名单
npm run test:e2e               # 76 项：真实浏览器跑看板 + 后台（持久目录）
npm run test:e2e:nonpersist    # 85 项：模拟「卷没挂上」，验证告警条与标红
npm test                       # 依次跑前三个
```

| 脚本 | 覆盖内容 |
| --- | --- |
| `test-persistence.js A` | `DATA_DIR` 解析、启动自检、写后读回 |
| `test-persistence.js B` | **重启（等价于重新部署）后数据标记仍在**、空写入被拒、备份一键恢复 |
| `test-persistence.js C` | 主目录为空时从其它候选目录「认领」数据，而不是退回种子 |
| `test-persistence.js D` | 目标卷不可用时**必须如实上报 `persistent:false`**，且写/备份仍可用 |

> ⚠️ 本仓库的测试脚本都是「**同进程内启动服务**」（`require('./server.js')`），
> 不是后台常驻进程。因此在受限环境里也能跑，不需要 `npm start` 先起服务。

