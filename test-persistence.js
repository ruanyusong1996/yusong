#!/usr/bin/env node
/**
 * 数据持久化回归测试（「数据被清空」的守门测试）
 *
 * 为什么不用 bash 起后台服务：本环境沙箱会杀掉后台进程，改为「同进程内启动服务 +
 * 分阶段重启」——每个阶段是一个独立进程，天然等价于「平台重新部署后重启容器」。
 *
 * 用法：
 *   node test-persistence.js A     # 初始化 + 写入标记
 *   node test-persistence.js B     # 重启后校验标记仍在 + 防误清空 + 备份恢复
 *   node test-persistence.js C     # 主目录为空时从别的候选目录认领数据
 *   node test-persistence.js all   # 依次跑 A B C（各自独立进程）
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NODE = process.execPath;
const PORT = Number(process.env.TPORT || 5321);
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = '/tmp/hdj-persist-test';
const VOL_A = path.join(WORK, 'volA');
const VOL_B = path.join(WORK, 'volB');
const LOCAL_CANDIDATE = path.join(ROOT, 'data');   // 代码目录下的候选盘
const MARK_FILE = path.join(WORK, 'mark.txt');
const COOKIE_FILE = path.join(WORK, 'cookie.txt');

const EXPECT_ROWS = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed-data.json'), 'utf8'));
  return Object.keys(d).reduce((s, k) => s + ((d[k] && d[k].rows) ? d[k].rows.length : 0), 0);
})();

let PASS = 0, FAIL = 0, COOKIE = '';
function t(desc, actual, expected) {
  const ok = String(actual) === String(expected);
  ok ? PASS++ : FAIL++;
  console.log(`  ${ok ? '✅' : '❌'} ${desc.padEnd(44)} ${ok ? actual : `实际=[${actual}] 期望=[${expected}]`}`);
}
function section(s) { console.log(`\n【${s}】`); }

async function req(pathname, opt = {}) {
  const res = await fetch(BASE + pathname, {
    ...opt,
    headers: {
      ...(opt.body ? { 'Content-Type': 'application/json' } : {}),
      ...(COOKIE ? { Cookie: COOKIE } : {}),
      ...(opt.headers || {}),
    },
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] || []);
  for (const c of setCookie) {
    const m = /hdj_sid=([^;]+)/.exec(c);
    if (m && m[1]) COOKIE = `hdj_sid=${m[1]}`;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}
const GET = p => req(p);
const PUT = (p, body) => req(p, { method: 'PUT', body: JSON.stringify(body) });
const POST = (p, body) => req(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

async function login(role = 'admin', password = role === 'admin' ? 'admin123' : 'gonghui123') {
  const r = await POST('/api/auth/login', { role, password });
  return r.status;
}

/** 启动本进程内的服务并等待就绪 */
async function startServer(dataDir) {
  if (dataDir) process.env.DATA_DIR = dataDir;
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = '0';
  require(path.join(ROOT, 'server.js'));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('服务未能在预期时间内启动');
}

function summary(name) {
  console.log(`\n── ${name}: 通过 ${PASS} 项，失败 ${FAIL} 项 ──`);
  process.exit(FAIL === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

async function phaseA() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(VOL_A, { recursive: true });
  fs.mkdirSync(VOL_B, { recursive: true });
  fs.rmSync(LOCAL_CANDIDATE, { recursive: true, force: true });
  fs.mkdirSync(LOCAL_CANDIDATE, { recursive: true });

  await startServer(VOL_A);
  section(`A 数据目录解析与启动自检（期望行数 ${EXPECT_ROWS}）`);
  const h = (await GET('/api/health')).json;
  t('health.persistent = true', h.persistent, 'true');
  t('health.storageMode = env', h.storageMode, 'env');

  t('后台登录成功', await login('admin', 'admin123'), 200);
  t('未登录读 /api/storage → 401', (await fetch(`${BASE}/api/storage`)).status, 401);
  const s = (await GET('/api/storage')).json;
  t('storage.persistent = true', s.persistent, 'true');
  t('storage.dataDir 指向 DATA_DIR', s.dataDir, VOL_A);
  t(`storage.rows = ${EXPECT_ROWS}`, s.rows, EXPECT_ROWS);
  t('数据文件已落盘', fs.existsSync(path.join(VOL_A, 'server-data.json')), 'true');
  t('配置/密码文件同目录', fs.existsSync(path.join(VOL_A, 'server-config.json')) && fs.existsSync(path.join(VOL_A, 'server-auth.json')), 'true');

  const mark = 'PERSIST_' + Date.now();
  const data = (await GET('/api/data')).json;
  data._meta = { ...(data._meta || {}), PERSIST_PROBE: mark };
  t('写入带标记的数据 → 200', (await PUT('/api/data', data)).status, 200);
  fs.writeFileSync(MARK_FILE, mark);
  t('写后立刻读回标记', (await GET('/api/data')).json._meta.PERSIST_PROBE, mark);
  summary('阶段 A');
}

async function phaseB() {
  const mark = fs.readFileSync(MARK_FILE, 'utf8').trim();
  await startServer(VOL_A);
  section('B 重启后（模拟重新部署）标记仍在');
  t('后台登录成功', await login('admin', 'admin123'), 200);
  t('重启后标记仍在', (await GET('/api/data')).json._meta.PERSIST_PROBE, mark);
  t('重启后行数不变', (await GET('/api/storage')).json.rows, EXPECT_ROWS);
  const adminCookie = COOKIE;                        // 下面换成看板身份，测完要换回来
  t('重启后看板密码仍可用', await login('dashboard', 'gonghui123'), 200);
  t('看板身份不能写数据/看存储', (await PUT('/api/data', { x: { rows: [] } })).status === 401 && (await GET('/api/storage')).status === 401, 'true');
  COOKIE = adminCookie;

  section('D 防误清空：空数据写入被服务端拒绝');
  t('PUT {} → 400', (await PUT('/api/data', {})).status, 400);
  t('PUT 仅 _meta → 400', (await PUT('/api/data', { _meta: { a: 1 } })).status, 400);
  const onlyMeta = (await PUT('/api/data', { _meta: {} })).json;
  t('返回了可读的错误说明', !!(onlyMeta && onlyMeta.error), 'true');
  t('行数未被破坏', (await GET('/api/storage')).json.rows, EXPECT_ROWS);

  section('E 备份与一键恢复');
  const bk = await POST('/api/backups', { kind: 'data' });
  t('手动备份 → 200', bk.status, 200);
  const list = (await GET('/api/backups')).json;
  t('备份列表可读且非空', list.backups.length >= 1, 'true');
  t(`备份记录行数 = ${EXPECT_ROWS}`, list.backups.find(b => b.name === bk.json.name).rows, EXPECT_ROWS);
  t('非法备份名 → 400', (await POST('/api/backups/restore', { name: '../etc/passwd' })).status, 400);
  t('不存在的备份 → 404', (await POST('/api/backups/restore', { name: 'server-data.19700101-000000.json' })).status, 404);
  const dup = JSON.parse(fs.readFileSync(path.join(VOL_A, 'server-data.json'), 'utf8'));
  dup['01-组织建设'].rows = [];   // 人为破坏：清掉一张表
  await PUT('/api/data', dup);
  t('人为破坏后行数下降', (await GET('/api/storage')).json.rows, EXPECT_ROWS - 20);
  t('恢复备份 → 200', (await POST('/api/backups/restore', { name: bk.json.name })).status, 200);
  t('恢复后数据完好', (await GET('/api/storage')).json.rows, EXPECT_ROWS);
  t('恢复前那一版也留了快照', (await GET('/api/backups')).json.backups.length >= 2, 'true');
  summary('阶段 B');
}

async function phaseC() {
  // 只在「代码目录/data」放一份带标记的数据，目标盘 volB 保持为空
  fs.rmSync(VOL_B, { recursive: true, force: true });
  fs.mkdirSync(VOL_B, { recursive: true });
  const src = JSON.parse(fs.readFileSync(path.join(VOL_A, 'server-data.json'), 'utf8'));
  src._meta = { ...(src._meta || {}), FROM_OTHER_DIR: 'yes' };
  fs.mkdirSync(LOCAL_CANDIDATE, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_CANDIDATE, 'server-data.json'), JSON.stringify(src, null, 2));
  fs.copyFileSync(path.join(VOL_A, 'server-config.json'), path.join(LOCAL_CANDIDATE, 'server-config.json'));

  await startServer(VOL_B);
  section('C 主目录为空时，从其它候选目录把数据认领回来（不退回种子）');
  t('空目录也能启动', (await GET('/api/health')).status, 200);
  t('数据被认领进空目录', fs.existsSync(path.join(VOL_B, 'server-data.json')), 'true');
  t('配置也被认领', fs.existsSync(path.join(VOL_B, 'server-config.json')), 'true');
  t('后台登录成功', await login('admin', 'admin123'), 200);
  const s = (await GET('/api/storage')).json;
  t('storage.dataDir = 空目录 B', s.dataDir, VOL_B);
  t('认领内容不是裸种子（含 _meta）', (await GET('/api/data')).json._meta.FROM_OTHER_DIR, 'yes');
  t('被认领的是真实数据行数', s.rows, EXPECT_ROWS);

  fs.rmSync(LOCAL_CANDIDATE, { recursive: true, force: true });
  summary('阶段 C');
}

// ---------------------------------------------------------------------------

(async () => {
  const phase = (process.argv[2] || 'all').toUpperCase();
  if (phase === 'ALL') {
    for (const p of ['A', 'B', 'C']) {
      const r = spawnSync(NODE, [__filename, p], { stdio: 'inherit', cwd: ROOT });
      if (r.status !== 0) { console.log(`\n❌ 阶段 ${p} 失败`); process.exit(1); }
    }
    fs.rmSync(LOCAL_CANDIDATE, { recursive: true, force: true });
    console.log('\n════════ 全部阶段通过 ════════');
    process.exit(0);
  }
  if (phase === 'A') await phaseA();
  else if (phase === 'B') await phaseB();
  else if (phase === 'C') await phaseC();
  else { console.error('用法: node test-persistence.js [A|B|C|all]'); process.exit(2); }
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
