/**
 * 海底捞集团工会工作数据看板 - 后端服务
 *
 * 功能：
 *   - 数据 API:      GET/PUT /api/data, POST /api/reset
 *   - 看板配置 API:  GET/PUT /api/config
 *   - 登录鉴权:      POST /api/auth/login|logout|password, GET /api/auth/status
 *   - SSE 实时推送:  GET /api/stream
 *   - 静态文件托管（index.html / admin.html / login.html 等）
 *
 * 权限：
 *   - 看板（index.html、/api/data 读、/api/stream）需「看板密码」或「后台密码」
 *   - 后台（admin.html、写接口、配置修改、改密码）需「后台密码」
 *
 * 启动: node server.js [--port=5300]
 *
 * 文件（都在 DATA_DIR，云端指向持久化卷即可）：
 *   server-data.json    运行数据（首次从 seed-data.json 初始化）
 *   server-config.json  看板配置（首次从 seed-config.json 初始化）
 *   server-auth.json    密码哈希（首次用默认密码生成）
 */
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
// 数据目录：默认与代码同目录；云端可指向挂载的持久化卷（如 Railway Volume: /data）
const DATA_DIR = process.env.DATA_DIR || ROOT;
const DATA_FILE = path.join(DATA_DIR, 'server-data.json');
const CONFIG_FILE = path.join(DATA_DIR, 'server-config.json');
const AUTH_FILE = path.join(DATA_DIR, 'server-auth.json');
const SEED_FILE = path.join(ROOT, 'seed-data.json');
const CONFIG_SEED_FILE = path.join(ROOT, 'seed-config.json');
const LOGIN_PAGE = path.join(ROOT, 'login.html');

const PORT = (() => {
  const arg = process.argv.find(a => a.startsWith('--port='));
  if (arg) return parseInt(arg.split('=')[1], 10);
  return parseInt(process.env.PORT, 10) || 5300;
})();

/** 首次启动的默认密码（登录后请立刻在后台「安全设置」里修改） */
const DEFAULT_PASSWORDS = {
  dashboard: process.env.DEFAULT_DASHBOARD_PASSWORD || 'gonghui123',
  admin: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
};
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;  // 12 小时
const COOKIE_NAME = 'hdj_sid';

// ---------------------------------------------------------------------------
// 通用文件工具
// ---------------------------------------------------------------------------

/** 简单写入互斥锁 */
let writeChain = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

/** 原子写入：先写 .tmp 再 rename，避免崩溃中途导致文件损坏 */
function writeJsonAtomic(file, obj) {
  return writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, file, (e2) => e2 ? reject(e2) : resolve());
    });
  }));
}

function initFromSeed(target, seed, label) {
  if (fs.existsSync(target)) return;
  const seedObj = readJsonSafe(seed);
  if (!seedObj) { console.error(`[FATAL] 缺少 ${path.basename(seed)}，无法初始化 ${label}`); return; }
  ensureDir();
  fs.copyFileSync(seed, target);
  console.log(`[init] 已从 ${path.basename(seed)} 初始化 ${path.basename(target)}`);
}

// ---------------------------------------------------------------------------
// 数据 / 配置
// ---------------------------------------------------------------------------

function ensureDataFile() { initFromSeed(DATA_FILE, SEED_FILE, '数据'); }
function ensureConfigFile() { initFromSeed(CONFIG_FILE, CONFIG_SEED_FILE, '看板配置'); }

function readData() {
  const d = readJsonSafe(DATA_FILE);
  if (!d) console.error('[readData] 数据文件读取失败');
  return d;
}
function readConfig() { return readJsonSafe(CONFIG_FILE) || readJsonSafe(CONFIG_SEED_FILE) || {}; }

// ---------------------------------------------------------------------------
// 鉴权：密码哈希 + 会话
// ---------------------------------------------------------------------------

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function createAuthFile() {
  const roles = {};
  Object.keys(DEFAULT_PASSWORDS).forEach(role => {
    const salt = crypto.randomBytes(16).toString('hex');
    roles[role] = {
      salt,
      hash: hashPassword(DEFAULT_PASSWORDS[role], salt),
      updatedAt: new Date().toISOString(),
    };
  });
  const auth = { version: 1, roles };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf-8');
  return auth;
}

let AUTH = null;
function loadAuth() {
  ensureDir();
  AUTH = readJsonSafe(AUTH_FILE);
  if (!AUTH || !AUTH.roles || !AUTH.roles.dashboard || !AUTH.roles.admin) AUTH = createAuthFile();
  return AUTH;
}

function verifyPassword(role, password) {
  const rec = AUTH && AUTH.roles && AUTH.roles[role];
  if (!rec || password === undefined || password === null) return false;
  const got = hashPassword(password, rec.salt);
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setPassword(role, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  AUTH.roles[role] = { salt, hash: hashPassword(password, salt), updatedAt: new Date().toISOString() };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(AUTH, null, 2), 'utf-8');
}

/** token -> { role, expires } */
const sessions = new Map();

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getToken(req) { return parseCookies(req.headers.cookie)[COOKIE_NAME] || null; }

function getSession(req) {
  const token = getToken(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.token = token;
  return s;
}

const isViewer = s => !!s && (s.role === 'dashboard' || s.role === 'admin');
const isAdmin = s => !!s && s.role === 'admin';

function setSessionCookie(res, token, maxAgeMs) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  // 线上为 https 时加 Secure（本机 http 调试不加）
  if (process.env.FORCE_INSECURE_COOKIE !== '1' && (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production')) {
    parts.push('Secure');
  }
  res.append('Set-Cookie', parts.join('; '));
}

function requireView(req, res, next) {
  if (isViewer(getSession(req))) return next();
  res.status(401).json({ error: '需要登录', needLogin: true });
}
function requireAdmin(req, res, next) {
  if (isAdmin(getSession(req))) return next();
  res.status(401).json({ error: '需要后台登录', needLogin: true });
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

app.disable('etag');
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// 简单访问日志
app.use((req, _res, next) => {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${req.method} ${req.url}`);
  next();
});

// --------------------------- 鉴权接口 --------------------------------------

app.get('/api/auth/status', (req, res) => {
  const s = getSession(req);
  res.json({
    needAuth: true,
    dashboard: isViewer(s),
    admin: isAdmin(s),
    role: s ? s.role : null,
    offline: false,
    ts: Date.now(),
  });
});

app.post('/api/auth/login', (req, res) => {
  const { role, password } = req.body || {};
  if (role !== 'dashboard' && role !== 'admin') {
    return res.status(400).json({ error: 'role 参数无效' });
  }
  if (!verifyPassword(role, password)) {
    return res.status(401).json({ error: role === 'admin' ? '后台密码错误' : '看板密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, expires: Date.now() + SESSION_TTL_MS, since: Date.now() });
  setSessionCookie(res, token, SESSION_TTL_MS);
  res.json({ ok: true, role, dashboard: true, admin: role === 'admin' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/auth/password', (req, res) => {
  const s = getSession(req);
  if (!isAdmin(s)) return res.status(401).json({ error: '需要后台登录' });
  const { role, current, next } = req.body || {};
  if (role !== 'dashboard' && role !== 'admin') return res.status(400).json({ error: 'role 参数无效' });
  if (!next || String(next).length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
  if (String(next).length > 64) return res.status(400).json({ error: '新密码过长（≤64 位）' });
  // 改任何一个密码，都要先验证当前后台密码
  if (!verifyPassword('admin', current)) return res.status(403).json({ error: '当前后台密码不正确' });
  setPassword(role, next);
  // 让其它会话失效，保留当前会话
  const keep = s.token;
  [...sessions.keys()].forEach(t => { if (t !== keep) sessions.delete(t); });
  console.log(`[auth] 密码已更新: ${role}`);
  res.json({ ok: true, message: role === 'admin' ? '后台密码已更新' : '看板密码已更新' });
});

// --------------------------- 数据接口 --------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), clients: sseClients.size });
});

app.get('/api/data', requireView, (_req, res) => {
  const data = readData();
  if (!data) return res.status(500).json({ error: '数据读取失败' });
  res.json(data);
});

app.put('/api/data', requireAdmin, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: '请求体必须是 JSON 对象' });
  }
  try {
    body._meta = {
      ...(body._meta || {}),
      lastModified: new Date().toISOString(),
      modifiedBy: req.headers['x-editor'] || 'anonymous',
    };
    await writeJsonAtomic(DATA_FILE, body);
    broadcast('update', { ts: body._meta.lastModified, editorId: req.headers['x-client-id'] || null });
    res.json({ ok: true, ts: body._meta.lastModified, clients: sseClients.size });
  } catch (e) {
    console.error('[PUT /api/data] 写入失败:', e);
    res.status(500).json({ error: '写入失败', detail: e.message });
  }
});

app.post('/api/reset', requireAdmin, async (_req, res) => {
  try {
    const seed = readJsonSafe(SEED_FILE);
    if (!seed) return res.status(500).json({ error: 'seed-data.json 缺失' });
    seed._meta = { lastModified: new Date().toISOString(), modifiedBy: 'reset' };
    await writeJsonAtomic(DATA_FILE, seed);
    broadcast('update', { ts: seed._meta.lastModified, reset: true });
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /api/reset]', e);
    res.status(500).json({ error: '重置失败', detail: e.message });
  }
});

// --------------------------- 看板配置接口 ----------------------------------

app.get('/api/config', requireView, (_req, res) => {
  res.json(readConfig());
});

app.put('/api/config', requireAdmin, async (req, res) => {
  const cfg = req.body;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return res.status(400).json({ error: '配置必须是 JSON 对象' });
  }
  if (!Array.isArray(cfg.modules) || !Array.isArray(cfg.metrics)) {
    return res.status(400).json({ error: '配置缺少 modules / metrics 数组' });
  }
  try {
    cfg._meta = { lastModified: new Date().toISOString(), modifiedBy: req.headers['x-editor'] || 'admin' };
    await writeJsonAtomic(CONFIG_FILE, cfg);
    broadcast('config', { ts: cfg._meta.lastModified, editorId: req.headers['x-client-id'] || null });
    res.json({ ok: true, ts: cfg._meta.lastModified });
  } catch (e) {
    console.error('[PUT /api/config] 写入失败:', e);
    res.status(500).json({ error: '配置保存失败', detail: e.message });
  }
});

// --------------------------- SSE -------------------------------------------

app.get('/api/stream', requireView, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now(), clients: sseClients.size + 1 })}\n\n`);
  sseClients.add(res);

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

// --------------------------- 页面门禁 + 静态托管 ----------------------------
// 需要登录的静态资源：页面本体与前端脚本（避免未登录直接拿到数据种子/脚本）

const VIEW_ONLY_FILES = new Set([
  '/index.html', '/', '/app.js', '/data-store.js', '/config-engine.js',
  '/seed-data.js', '/seed-config.js',
]);
const ADMIN_ONLY_FILES = new Set(['/admin.html', '/admin.js']);

function redirectToLogin(res, role, nextPath) {
  const next = nextPath && nextPath !== '/' ? `&next=${encodeURIComponent(nextPath)}` : '';
  res.redirect(302, `/login.html?role=${role}${next}`);
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path;
  if (!VIEW_ONLY_FILES.has(p) && !ADMIN_ONLY_FILES.has(p)) return next();

  const s = getSession(req);
  if (ADMIN_ONLY_FILES.has(p)) {
    if (isAdmin(s)) return next();
    // 看板观众访问后台 → 需后台密码
    return redirectToLogin(res, isViewer(s) ? 'admin' : 'dashboard', p);
  }
  if (isViewer(s)) return next();
  return redirectToLogin(res, 'dashboard', p);
});

app.use(express.static(ROOT, {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// 兜底 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

ensureDir();
ensureDataFile();
ensureConfigFile();
const authExisted = fs.existsSync(AUTH_FILE);
loadAuth();

const server = app.listen(PORT, () => {
  console.log(`\n[gh-dashboard] 服务已启动`);
  console.log(`  看板地址:   http://localhost:${PORT}/`);
  console.log(`  后台地址:   http://localhost:${PORT}/admin.html`);
  console.log(`  健康检查:   http://localhost:${PORT}/api/health`);
  console.log(`  数据文件:   ${DATA_FILE}`);
  console.log(`  配置文件:   ${CONFIG_FILE}`);
  console.log(`  密码文件:   ${AUTH_FILE}`);
  console.log(`  登录密码:   看板 ${authExisted ? '(已设置)' : DEFAULT_PASSWORDS.dashboard} / 后台 ${authExisted ? '(已设置)' : DEFAULT_PASSWORDS.admin}`);
  console.log(`              ⚠️ 首次登录后请在后台「安全设置」里修改密码\n`);
});

// 优雅退出
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    console.log(`\n[${sig}] 关闭服务...`);
    server.close(() => process.exit(0));
  });
});
