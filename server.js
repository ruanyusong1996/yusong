/**
 * 海底捞集团工会工作数据看板 - 后端服务
 *
 * 功能：
 *   - REST API: GET /api/data, PUT /api/data, POST /api/reset
 *   - SSE 实时推送: GET /api/stream
 *   - 静态文件托管（index.html / admin.html 等）
 *
 * 启动: node server.js [--port=5300]
 *
 * 数据存储: ./server-data.json (首次启动从 seed-data.json 初始化)
 */
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// 数据目录：默认与代码同目录；云端可指向挂载的持久化卷（如 Railway Volume: /data）
const DATA_DIR = process.env.DATA_DIR || ROOT;
const DATA_FILE = path.join(DATA_DIR, 'server-data.json');
const SEED_FILE = path.join(ROOT, 'seed-data.json');
const PORT = (() => {
  const arg = process.argv.find(a => a.startsWith('--port='));
  if (arg) return parseInt(arg.split('=')[1], 10);
  return parseInt(process.env.PORT, 10) || 5300;
})();

// ---------------------------------------------------------------------------
// 数据存储
// ---------------------------------------------------------------------------

/** 简单写入互斥锁（同一时间只允许一个 PUT） */
let writeChain = Promise.resolve();

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) return;
  if (!fs.existsSync(SEED_FILE)) {
    console.error('[FATAL] 缺少 seed-data.json，无法初始化');
    process.exit(1);
  }
  fs.copyFileSync(SEED_FILE, DATA_FILE);
  console.log(`[init] 已从 ${path.basename(SEED_FILE)} 初始化 ${path.basename(DATA_FILE)}`);
}

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[readData] 读取失败:', e.message);
    return null;
  }
}

/** 原子写入：先写 .tmp 再 rename，避免崩溃中途导致文件损坏 */
function writeDataAtomic(data) {
  return writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DATA_FILE, (e2) => e2 ? reject(e2) : resolve());
    });
  }));
}

// ---------------------------------------------------------------------------
// SSE 客户端管理
// ---------------------------------------------------------------------------

/** @type {Set<import('express').Response>} */
const sseClients = new Set();

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { /* 客户端已断开 */ }
  }
}

// ---------------------------------------------------------------------------
// Express 应用
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// 简单访问日志
app.use((req, _res, next) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${req.method} ${req.url}`);
  next();
});

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), clients: sseClients.size });
});

// 拉取所有数据
app.get('/api/data', (_req, res) => {
  const data = readData();
  if (!data) return res.status(500).json({ error: '数据读取失败' });
  res.json(data);
});

// 推送数据（覆盖保存）
app.put('/api/data', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: '请求体必须是 JSON 对象' });
  }

  // 粗略校验：必须包含 4 个模块键
  const required = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支'];
  const missing = required.filter(k => !(k in body));
  if (missing.length) {
    return res.status(400).json({ error: '缺少必要模块', missing });
  }

  try {
    body._meta = {
      ...(body._meta || {}),
      lastModified: new Date().toISOString(),
      modifiedBy: req.headers['x-editor'] || 'anonymous',
    };
    await writeDataAtomic(body);

    // 通知所有 SSE 客户端刷新（带上发起方 id，发起方自己会忽略）
    const editorId = req.headers['x-client-id'] || null;
    broadcast('update', { ts: body._meta.lastModified, editorId });

    res.json({ ok: true, ts: body._meta.lastModified, clients: sseClients.size });
  } catch (e) {
    console.error('[PUT /api/data] 写入失败:', e);
    res.status(500).json({ error: '写入失败', detail: e.message });
  }
});

// 重置为默认数据
app.post('/api/reset', async (_req, res) => {
  try {
    if (!fs.existsSync(SEED_FILE)) return res.status(500).json({ error: 'seed-data.json 缺失' });
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
    seed._meta = { lastModified: new Date().toISOString(), modifiedBy: 'reset' };
    await writeDataAtomic(seed);
    broadcast('update', { ts: seed._meta.lastModified, reset: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/reset]', e);
    res.status(500).json({ error: '重置失败', detail: e.message });
  }
});

// SSE 实时推送
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // 初始握手
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now(), clients: sseClients.size + 1 })}\n\n`);

  sseClients.add(res);

  // 30s 心跳（防止代理超时）
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch (_) {}
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[sse] 客户端断开, 当前 ${sseClients.size} 个连接`);
  });
  console.log(`[sse] 客户端连接, 当前 ${sseClients.size} 个连接`);
});

// 静态文件托管（index.html, admin.html, lib/, styles.css, app.js 等）
app.use(express.static(ROOT, {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// 兜底 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

ensureDataFile();

const server = app.listen(PORT, () => {
  console.log(`\n[gh-dashboard] 服务已启动`);
  console.log(`  看板地址:   http://localhost:${PORT}/`);
  console.log(`  后台地址:   http://localhost:${PORT}/admin.html`);
  console.log(`  健康检查:   http://localhost:${PORT}/api/health`);
  console.log(`  数据文件:   ${DATA_FILE}\n`);
});

// 优雅退出
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    console.log(`\n[${sig}] 关闭服务...`);
    server.close(() => process.exit(0));
  });
});
