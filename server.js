/**
 * 海底捞集团工会工作数据看板 - 后端服务
 *
 * 功能：
 *   - 数据 API:      GET/PUT /api/data, POST /api/reset
 *   - 看板配置 API:  GET/PUT /api/config
 *   - 登录鉴权:      POST /api/auth/login|logout|password, GET /api/auth/status
 *   - 存储诊断:      GET /api/health（公开，含 persistent 标记）
 *                    GET /api/storage（后台，数据目录/行数/备份数）
 *   - 备份恢复:      GET /api/backups, POST /api/backups, POST /api/backups/restore
 *   - SSE 实时推送:  GET /api/stream
 *   - 静态文件托管（index.html / admin.html / login.html 等）
 *
 * 权限：
 *   - 看板（index.html、/api/data 读、/api/stream）需「看板密码」或「后台密码」
 *   - 后台（admin.html、写接口、配置修改、改密码）需「后台密码」
 *
 * 启动: node server.js [--port=5300]
 *
 * 文件（都在 DATA_DIR）：
 *   server-data.json    运行数据（首次从 seed-data.json 初始化）
 *   server-config.json  看板配置（首次从 seed-config.json 初始化）
 *   server-auth.json    密码哈希（首次用默认密码生成）
 *   backups/            每次写入前的自动快照，可一键恢复
 *
 * ⚠️ 数据持久化（「数据被清空」的根因所在）：
 *   代码目录在每次重新部署时都会被平台替换掉。如果数据文件写在代码目录里，
 *   重新部署 → 文件消失 → 启动时又用种子重新初始化 → 看起来就是「数据被清空」。
 *   因此 DATA_DIR 的解析优先级为：
 *     1) 环境变量 DATA_DIR
 *     2) /data          —— Railway Volume 默认挂载点（存在且可写即自动采用）
 *     3) <代码目录>/data
 *     4) 代码目录本身   —— 本地开发兜底（启动日志会显著告警）
 *   同时启动时会到各个候选目录里把已有的数据/配置/密码文件「认领」回来，
 *   避免因为环境变量写错而切换到空目录、进而把数据丢掉。
 */
'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const ROOT_REAL = path.resolve(ROOT);

const APP_VERSION = '1.2.2';

// ---------------------------------------------------------------------------
// 数据目录解析：必须落在「重新部署不会被替换」的地方，数据才不会丢
// ---------------------------------------------------------------------------

function isDirWritable(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 扫描容器里「真实的挂载点」（Linux 读 /proc/mounts）：
 * 目的 —— 万一持久卷没挂在 /data 而是挂在别的路径，也能自动找到它。
 * 只认非虚拟文件系统的挂载（ext4/xfs/btrfs…），排除容器根文件系统（overlay）、
 * tmpfs、以及各种系统目录。
 */
function detectMountDirs() {
  const found = [];
  if (process.platform !== 'linux') return found;
  const SKIP_FS = new Set([
    'proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'mqueue', 'shm',
    'overlay', 'squashfs', 'nsfs', 'tracefs', 'debugfs', 'securityfs', 'pstore', 'bpf',
    'autofs', 'configfs', 'fusectl', 'ramfs', 'hugetlbfs', 'efivarfs', 'selinuxfs',
    'binfmt_misc', 'rpc_pipefs', 'fuse.lxcfs', 'fuse.gvfsd-fuse', '9p', 'nfs', 'nfs4', 'cifs',
  ]);
  const SKIP_PATH = /^\/(proc|sys|dev|etc|run|usr|bin|sbin|lib|lib64|boot|tmp)(\/|$)|^\/var\/(lib|run|cache|log|spool|tmp)(\/|$)/;
  try {
    const raw = fs.readFileSync('/proc/mounts', 'utf-8');
    for (const line of raw.split('\n')) {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const mp = parts[1].replace(/\\040/g, ' ');
      const fsType = parts[2];
      if (SKIP_FS.has(fsType)) continue;
      if (mp === '/' || SKIP_PATH.test(mp)) continue;
      if (mp === ROOT_REAL || mp.startsWith(ROOT_REAL + path.sep)) continue;
      if (mp.split('/').filter(Boolean).length > 3) continue;   // 太深的挂载点多半不是数据卷
      if (!isDirWritable(mp)) continue;
      found.push(mp);
    }
  } catch (_) {
    /* 非 Linux 或读取失败：忽略 */
  }
  return found;
}

/** 候选目录（按优先级）；最后一项是兜底，必然可用 */
const DATA_DIR_CANDIDATES = (() => {
  const list = [];
  if (process.env.DATA_DIR) list.push({ dir: path.resolve(process.env.DATA_DIR), src: 'env' });
  list.push({ dir: '/data', src: 'volume' });                       // Railway Volume 默认挂载点
  detectMountDirs().forEach(d => list.push({ dir: d, src: 'mount' })); // 挂在别处的卷
  list.push({ dir: path.join(ROOT_REAL, 'data'), src: 'app-data' });
  list.push({ dir: ROOT_REAL, src: 'app-root' });                    // 兜底：本地开发
  const seen = new Set();
  return list.filter(x => (seen.has(x.dir) ? false : (seen.add(x.dir), true)));
})();

const PICKED = DATA_DIR_CANDIDATES.find(x => isDirWritable(x.dir)) || DATA_DIR_CANDIDATES[DATA_DIR_CANDIDATES.length - 1];
const DATA_DIR = PICKED.dir;
const DATA_DIR_SOURCE = PICKED.src;

/** 数据是否写在「重新部署会被替换」的代码目录里 */
const STORAGE_PERSISTENT = !(
  DATA_DIR === ROOT_REAL || DATA_DIR.startsWith(ROOT_REAL + path.sep)
);

const DATA_FILE = path.join(DATA_DIR, 'server-data.json');
const CONFIG_FILE = path.join(DATA_DIR, 'server-config.json');
const AUTH_FILE = path.join(DATA_DIR, 'server-auth.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
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
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

/** 原子写入：先写 .tmp 再 rename，避免崩溃中途导致文件损坏 */
function writeJsonAtomic(file, obj, backupTag) {
  return writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    ensureDir();
    // 写入前先把旧版本存一份（这就是「数据被误覆盖」时的后悔药）
    if (fs.existsSync(file)) backupFile(file, backupTag);
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, file, (e2) => e2 ? reject(e2) : resolve());
    });
  }));
}

// ---------------------------------------------------------------------------
// 备份（滚动保留，可一键恢复）
// ---------------------------------------------------------------------------

const MAX_BACKUPS_PER_FILE = 40;

function timeStamp(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
}

function backupFile(file, tag) {
  try {
    if (!fs.existsSync(file)) return null;
    ensureDir();
    const base = path.basename(file, '.json');
    const name = `${base}.${timeStamp()}${tag ? '.' + tag : ''}.json`;
    const dest = path.join(BACKUP_DIR, name);
    fs.copyFileSync(file, dest);
    pruneBackups(base);
    return name;
  } catch (e) {
    console.error('[backup] 快照失败:', e.message);
    return null;
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(n => n.endsWith('.json'))
      .map(n => {
        const st = fs.statSync(path.join(BACKUP_DIR, n));
        return { name: n, size: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (_) {
    return [];
  }
}

function pruneBackups(base) {
  const mine = listBackups().filter(f => f.name.startsWith(base + '.'));
  mine.slice(MAX_BACKUPS_PER_FILE).forEach(f => {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (_) {}
  });
}

/** 备份文件名 → 它属于哪份运行文件 */
function backupKindOf(name) {
  if (String(name).startsWith('server-data.')) return 'data';
  if (String(name).startsWith('server-config.')) return 'config';
  return null;
}

// ---------------------------------------------------------------------------
// 启动引导：认领其它目录里的已有文件 + 首次从种子初始化
// ---------------------------------------------------------------------------

/** 在候选目录里找同一份文件（按修改时间取最新，跳过 data/backups） */
function findExistingElsewhere(name, primaryPath) {
  let best = null;
  let bestT = -1;
  for (const c of DATA_DIR_CANDIDATES) {
    if (c.dir === DATA_DIR) continue;
    const p = path.join(c.dir, name);
    if (p === primaryPath) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 2 && st.mtimeMs > bestT) { best = p; bestT = st.mtimeMs; }
    } catch (_) {}
  }
  return best;
}

/**
 * 确保某项运行文件在 DATA_DIR 里存在：
 *   1) 已存在 → 直接用（绝不覆盖）
 *   2) 不存在，但别的候选目录里有 → 认领回来（避免切换目录导致数据"消失"）
 *   3) 都不存在 → 从种子初始化
 */
function ensureManagedFile(target, seedFile, label) {
  if (fs.existsSync(target)) return 'existing';
  ensureDir();

  const name = path.basename(target);
  const other = findExistingElsewhere(name, target);
  if (other) {
    try {
      fs.copyFileSync(other, target);
      console.warn(`[recover] ${label}：在 ${path.dirname(other)} 找到已有文件，已认领到 ${DATA_DIR}`);
      return 'recovered';
    } catch (e) {
      console.error(`[recover] ${label} 认领失败:`, e.message);
    }
  }

  if (!seedFile) return 'missing';
  const seedObj = readJsonSafe(seedFile);
  if (!seedObj) {
    console.error(`[FATAL] 缺少 ${path.basename(seedFile)}，无法初始化${label}`);
    return 'missing';
  }
  fs.copyFileSync(seedFile, target);
  console.log(`[init] ${label}：已从 ${path.basename(seedFile)} 初始化 → ${target}`);
  return 'seeded';
}

function ensureDataFile() { return ensureManagedFile(DATA_FILE, SEED_FILE, '数据'); }
function ensureConfigFile() { return ensureManagedFile(CONFIG_FILE, CONFIG_SEED_FILE, '看板配置'); }

// ---------------------------------------------------------------------------
// 数据 / 配置
// ---------------------------------------------------------------------------

function ensureDataFile() { return ensureManagedFile(DATA_FILE, SEED_FILE, '数据'); }
function ensureConfigFile() { return ensureManagedFile(CONFIG_FILE, CONFIG_SEED_FILE, '看板配置'); }

/** 数据行数（仅统计带 rows 的表） */
function countRows(data) {
  if (!data || typeof data !== 'object') return 0;
  return Object.keys(data).reduce((s, k) => {
    const v = data[k];
    return s + (v && Array.isArray(v.rows) ? v.rows.length : 0);
  }, 0);
}

function readData() {
  const d = readJsonSafe(DATA_FILE);
  if (d) return d;
  // 主文件读不出来（被截断/写坏）→ 用最近一份备份顶上，避免"数据全空"
  const latest = listBackups().find(f => backupKindOf(f.name) === 'data');
  if (latest) {
    const b = readJsonSafe(path.join(BACKUP_DIR, latest.name));
    if (b) {
      console.error(`[readData] 主数据文件不可读，已临时启用备份 ${latest.name}`);
      return b;
    }
  }
  console.error('[readData] 数据文件读取失败');
  return null;
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

// 简单访问日志（设 LOG_REQUESTS=0 可关闭，测试时用）
app.use((req, _res, next) => {
  if (process.env.LOG_REQUESTS === '0') return next();
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
  let dataMtime = null;
  try { dataMtime = fs.statSync(DATA_FILE).mtime.toISOString(); } catch (_) {}
  res.json({
    ok: true,
    ts: Date.now(),
    clients: sseClients.size,
    version: APP_VERSION,
    // 存储是否落在「重新部署不会被替换」的目录（false = 重新部署会丢数据）
    persistent: STORAGE_PERSISTENT,
    storageMode: DATA_DIR_SOURCE,
    dataMtime,
  });
});

/**
 * 存储诊断（仅后台）：一眼看清数据到底写在哪儿、是否持久、备份多少份。
 * 「数据被清空」这类问题以后可以直接在这里看。
 */
app.get('/api/storage', requireAdmin, (_req, res) => {
  let dataMtime = null, dataSize = 0;
  try { const st = fs.statSync(DATA_FILE); dataMtime = st.mtime.toISOString(); dataSize = st.size; } catch (_) {}
  const data = readData();
  const backups = listBackups();
  res.json({
    persistent: STORAGE_PERSISTENT,
    dataDir: DATA_DIR,
    dataDirSource: DATA_DIR_SOURCE,
    candidates: DATA_DIR_CANDIDATES.map(c => `${c.dir} (${c.src})`),
    detectedMounts: detectMountDirs(),
    dataFile: DATA_FILE,
    dataExists: fs.existsSync(DATA_FILE),
    dataSize,
    dataMtime,
    rows: countRows(data),
    sheets: data ? Object.keys(data).filter(k => k !== '_meta').length : 0,
    backupDir: BACKUP_DIR,
    backupCount: backups.length,
    backupKinds: {
      data: backups.filter(b => backupKindOf(b.name) === 'data').length,
      config: backups.filter(b => backupKindOf(b.name) === 'config').length,
    },
    seedFile: SEED_FILE,
    hints: STORAGE_PERSISTENT
      ? ['数据写在持久目录里，重新部署不会丢。']
      : ['⚠️ 数据写在代码目录里，平台重新部署/重启容器后会被替换掉，届时会退回初始种子数据。',
         '修复：在部署平台挂载一个持久卷并把挂载路径设为 /data，然后设置环境变量 DATA_DIR=/data（只挂卷、不设变量也能自动识别）。'],
  });
});

// --------------------------- 备份 / 恢复 ------------------------------------

app.get('/api/backups', requireAdmin, (_req, res) => {
  const list = listBackups().map(b => {
    const kind = backupKindOf(b.name);
    let rows = null;
    if (kind === 'data') rows = countRows(readJsonSafe(path.join(BACKUP_DIR, b.name)));
    return { name: b.name, kind, size: b.size, mtime: b.mtime, rows };
  });
  res.json({ dir: BACKUP_DIR, count: list.length, limit: MAX_BACKUPS_PER_FILE, backups: list });
});

/** 手动打一份快照 */
app.post('/api/backups', requireAdmin, (req, res) => {
  const kind = (req.body && req.body.kind) || 'data';
  const file = kind === 'config' ? CONFIG_FILE : DATA_FILE;
  const name = backupFile(file, 'manual');
  if (!name) return res.status(500).json({ error: '备份失败（文件不存在或无权限）' });
  res.json({ ok: true, name });
});

/** 用某份备份覆盖回去 */
app.post('/api/backups/restore', requireAdmin, async (req, res) => {
  const name = String((req.body && req.body.name) || '');
  if (!/^[A-Za-z0-9._-]+\.json$/.test(name) || name.includes('..')) {
    return res.status(400).json({ error: '备份名不合法' });
  }
  const kind = backupKindOf(name);
  if (!kind) return res.status(400).json({ error: '无法识别的备份文件' });
  const src = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(src)) return res.status(404).json({ error: '备份不存在' });
  const parsed = readJsonSafe(src);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return res.status(400).json({ error: '备份文件内容不是合法 JSON 对象' });
  }
  try {
    const target = kind === 'config' ? CONFIG_FILE : DATA_FILE;
    await writeJsonAtomic(target, parsed, 'before-restore');
    if (kind === 'config') broadcast('config', { ts: new Date().toISOString(), restored: name });
    else broadcast('update', { ts: new Date().toISOString(), restored: name });
    console.log(`[restore] 已用备份 ${name} 覆盖 ${path.basename(target)}`);
    res.json({ ok: true, kind, name, rows: kind === 'data' ? countRows(parsed) : undefined });
  } catch (e) {
    console.error('[restore]', e);
    res.status(500).json({ error: '恢复失败', detail: e.message });
  }
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
  // 兜底防误清空：一份数据里至少要有 1 张表
  const sheetKeys = Object.keys(body).filter(k => k !== '_meta');
  if (!sheetKeys.length) {
    console.warn('[PUT /api/data] 收到空数据，已拒绝写入');
    return res.status(400).json({ error: '数据为空，已拒绝写入（防止误清空）' });
  }
  const prevRows = countRows(readData());
  const nextRows = countRows(body);
  if (prevRows > 0 && nextRows === 0) {
    console.warn(`[PUT /api/data] 写入会使总行数从 ${prevRows} 变成 0，已拒绝`);
    return res.status(400).json({ error: `本次写入会把全部 ${prevRows} 行数据清空，已拒绝（如确实要清空，请逐表删除）` });
  }
  try {
    body._meta = {
      ...(body._meta || {}),
      lastModified: new Date().toISOString(),
      modifiedBy: req.headers['x-editor'] || 'anonymous',
    };
    await writeJsonAtomic(DATA_FILE, body);
    if (prevRows > 0 && nextRows < prevRows * 0.5) {
      console.warn(`[PUT /api/data] 行数由 ${prevRows} 骤减到 ${nextRows}，已自动留一份快照可恢复`);
    }
    broadcast('update', { ts: body._meta.lastModified, editorId: req.headers['x-client-id'] || null });
    res.json({ ok: true, ts: body._meta.lastModified, clients: sseClients.size, rows: nextRows });
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

/**
 * 允许匿名访问的静态资源白名单。
 * 其余一切（server-data.json / server-config.json / server-auth.json / server.js /
 * package.json / README.md / DEPLOY_GUIDE.md / backups/…）一律 404 ——
 * 否则密码保护等于形同虚设：任何人直接 GET /server-data.json 就能把数据拿走。
 */
const PUBLIC_STATIC_FILES = new Set([
  '/login.html', '/styles.css', '/admin.css', '/favicon.ico', '/robots.txt',
]);
const PUBLIC_STATIC_PREFIXES = ['/lib/'];

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

// 静态资源白名单门禁：不在白名单里的路径直接 404，避免敏感文件被直接下载
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path;
  if (VIEW_ONLY_FILES.has(p) || ADMIN_ONLY_FILES.has(p)) return next();   // 上面已做过角色校验
  if (PUBLIC_STATIC_FILES.has(p)) return next();
  if (PUBLIC_STATIC_PREFIXES.some(pre => p.startsWith(pre))) return next();
  return res.status(404).json({ error: 'not found' });
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

const dataState = ensureDataFile();
const configState = ensureConfigFile();
ensureManagedFile(AUTH_FILE, null, '密码');
const authExisted = fs.existsSync(AUTH_FILE);
loadAuth();

/** 每天最多打一份「开机检查点」，方便回溯"某天开始数据不对了" */
(function dailyCheckpoint() {
  if (!fs.existsSync(DATA_FILE)) return;
  const newest = listBackups().find(f => f.name.includes('.startup.'));
  if (newest && Date.now() - newest.mtimeMs < 24 * 3600 * 1000) return;
  backupFile(DATA_FILE, 'startup');
})();

const bootRows = countRows(readData());

const server = app.listen(PORT, () => {
  console.log(`\n[gh-dashboard] 服务已启动  v${APP_VERSION}`);
  console.log(`  看板地址:   http://localhost:${PORT}/`);
  console.log(`  后台地址:   http://localhost:${PORT}/admin.html`);
  console.log(`  健康检查:   http://localhost:${PORT}/api/health`);
  console.log(`  ── 数据存储 ─────────────────────────────`);
  console.log(`  数据目录:   ${DATA_DIR}   (来源: ${DATA_DIR_SOURCE})`);
  if (!STORAGE_PERSISTENT) {
    console.log(`  候选目录:   ${DATA_DIR_CANDIDATES.map(c => c.dir + '(' + c.src + ')').join('  ')}`);
    const mounts = detectMountDirs();
    console.log(`  真实挂载点: ${mounts.length ? mounts.join('  ') : '（无）'}`);
  }
  console.log(`  数据文件:   ${DATA_FILE}   行数 ${bootRows}  (${dataState})`);
  console.log(`  配置文件:   ${CONFIG_FILE}  (${configState})`);
  console.log(`  密码文件:   ${AUTH_FILE}`);
  console.log(`  备份目录:   ${BACKUP_DIR}  已有 ${listBackups().length} 份`);
  if (!STORAGE_PERSISTENT) {
    console.log('');
    console.log('  ⚠️⚠️  警告：数据写在「代码目录」里，平台重新部署或重建容器后会被替换，');
    console.log('         届时数据会退回初始种子（就是"数据被清空"的现象）。');
    console.log('         修复：挂载持久卷并把挂载路径设为 /data（Railway Volume），');
    console.log('         可选再设环境变量 DATA_DIR=/data（不设也能自动识别 /data）。');
    console.log('         自检命令：GET /api/storage');
    console.log('');
  } else {
    console.log(`  ✅ 数据存储在持久目录中，重新部署不会丢失`);
  }
  console.log(`  ─────────────────────────────────────────`);
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
