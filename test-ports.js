#!/usr/bin/env node
/**
 * v1.7 新功能回归测试
 *
 * ① 经费汇入：走访慰问「慰问物品金额（元）」+ 员工活动「支出金额（元）」
 *    按「费用列支账户 = 工会名称」汇入 04 表的「支出合计（元）」，
 *    再由既有公式推出「当前结余（元）/（万元）」（纯函数 + HTTP 双测）
 * ② 收集端口：10 个独立账号，登录隔离、只能改自己提报的记录
 * ③ 提报人：端口写入时自动打标，后台可读
 * ④ 老数据补列：数组行 / 对象行两种形态都要能补出「提报人」与三个汇入列
 *
 * 用法：node test-ports.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let PASS = 0, FAIL = 0;
function t(desc, actual, expected) {
  const ok = String(actual) === String(expected);
  ok ? PASS++ : FAIL++;
  console.log(`  ${ok ? '✅' : '❌'} ${desc.padEnd(52)} ${ok ? actual : `实际=[${actual}] 期望=[${expected}]`}`);
}
function ok(desc, cond) { t(desc, !!cond, true); }
function section(s) { console.log(`\n【${s}】`); }

// ---------------------------------------------------------------- 引擎加载
function loadEngine() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'config-engine.js'), 'utf8'), sandbox, { filename: 'config-engine.js' });
  return sandbox.window.ConfigEngine;
}
const CE = loadEngine();

const sheet = (headers, rows) => ({ title: 'T', subtitle: '', headers, rows });

/** 把对象行/数组行统一取成对象 */
function asObj(row, headers) {
  if (row == null) return {};
  if (Array.isArray(row)) {
    const o = {};
    headers.forEach((h, i) => { o[h] = i < row.length ? row[i] : ''; });
    return o;
  }
  return Object.assign({}, row);
}

// 列名常量（含全角括号，必须用引号）
const C_ACCOUNT = '费用列支账户';
const C_VISIT = '慰问物品金额（元）';
const C_VISIT_W = '慰问物品金额（万元）';
const C_ACT = '支出金额（元）';
const C_VISIT_IN = '慰问支出汇入（元）';
const C_ACT_IN = '活动支出汇入（元）';
const C_TOTAL = '支出合计（元）';
const C_BAL = '当前结余（元）';
const C_BAL_W = '当前结余（万元）';
const C_REPORTER = '提报人';
const C_UNION = '工会名称';

// ==================================================================
section('A. 经费汇入：老数据补列（数组行 / 对象行）');

{
  const h = ['序号', C_UNION, '期初金额', '入账金额', '支出金额', '事由摘要'];
  const d = {
    '04-经费收支': sheet(h.slice(), [[1, 'A工会', 1000, 200, 0, '']]),
    '02-走访慰问': sheet(['序号', C_ACCOUNT, C_VISIT], [[1, 'A工会', 100]]),
    '03-员工活动': sheet(['序号', C_ACCOUNT, C_ACT], [[1, 'A工会', 50]]),
  };
  CE.ensureFundColumns(d);
  const H = d['04-经费收支'].headers;
  ok('A1 数组行补齐「慰问支出汇入（元）」', H.indexOf(C_VISIT_IN) >= 0);
  ok('A2 数组行补齐「活动支出汇入（元）」', H.indexOf(C_ACT_IN) >= 0);
  ok('A3 数组行补齐「支出合计（元）」', H.indexOf(C_TOTAL) >= 0);
  t('A4 数组行补列后长度与表头一致', d['04-经费收支'].rows[0].length, H.length);
}

{
  const d = {
    '04-经费收支': sheet(['序号', C_UNION, '期初金额', '入账金额', '支出金额'],
      [{ 序号: 1, 工会名称: 'B工会', 期初金额: 500 }]),
    '02-走访慰问': sheet(['序号'], []),
    '03-员工活动': sheet(['序号'], []),
  };
  CE.ensureFundColumns(d);
  const r = d['04-经费收支'].rows[0];
  ok('A5 对象行补出「慰问支出汇入（元）」键', C_VISIT_IN in (r || {}));
  ok('A6 对象行补出「支出合计（元）」键', C_TOTAL in (r || {}));
  const before = JSON.stringify(d);
  CE.ensureFundColumns(d);
  t('A7 ensureFundColumns 幂等', JSON.stringify(d), before);
}

// ==================================================================
section('B. 经费汇入：按账户汇入并重算结余');

function fundData(over) {
  const d = {
    '04-经费收支': sheet(
      ['序号', C_UNION, '期初金额', '入账金额', '支出金额', C_VISIT_IN, C_ACT_IN, C_TOTAL, C_BAL, C_BAL_W],
      [{ 序号: 1, 工会名称: 'A工会', 期初金额: 10000, 入账金额: 2000, 支出金额: 500 },
       { 序号: 2, 工会名称: 'B工会', 期初金额: 8000, 入账金额: 0, 支出金额: 0 }]
    ),
    '02-走访慰问': sheet(['序号', C_ACCOUNT, C_VISIT], [
      { 序号: 1, [C_ACCOUNT]: 'A工会', [C_VISIT]: 1000 },
      { 序号: 2, [C_ACCOUNT]: 'A工会', [C_VISIT]: 250.5 },
      { 序号: 3, [C_ACCOUNT]: 'B工会', [C_VISIT]: 300 },
    ]),
    '03-员工活动': sheet(['序号', C_ACCOUNT, C_ACT], [
      { 序号: 1, [C_ACCOUNT]: 'A工会', [C_ACT]: 700 },
      { 序号: 2, [C_ACCOUNT]: '不存在的账户', [C_ACT]: 999 },
    ]),
  };
  return over ? Object.assign(d, over) : d;
}

{
  const d = fundData();
  const warns = [];
  const out = CE.rollupFundExpense(d, warns);
  const A = d['04-经费收支'].rows[0];
  const B = d['04-经费收支'].rows[1];
  t('B1 A工会 慰问支出汇入 = 1000+250.5', A[C_VISIT_IN], 1250.5);
  t('B2 A工会 活动支出汇入 = 700', A[C_ACT_IN], 700);
  t('B3 A工会 支出合计 = 500+1250.5+700', A[C_TOTAL], 2450.5);
  t('B4 A工会 结余 = 10000+2000-2450.5', A[C_BAL], 9549.5);
  t('B5 A工会 结余(万元) 保留 2 位', A[C_BAL_W], 0.95);
  t('B6 B工会 慰问支出汇入 = 300', B[C_VISIT_IN], 300);
  t('B7 B工会 结余 = 8000-300', B[C_BAL], 7700);
  ok('B8 返回重算后的 data', out && out['04-经费收支']);
  t('B9 全部与公式一致时无警告', warns.length, 0);
}

{
  // 账户名对不上：不打进任何工会，但能被 findUnmatchedExpense 找到
  const d = fundData();
  CE.rollupFundExpense(d, []);
  const un = CE.findUnmatchedExpense(d) || [];
  const hit = un.filter(x => Number(x.amount) === 999);
  t('C1 未匹配支出能被识别', hit.length, 1);
  t('C2 未匹配支出来自 03-员工活动', (hit[0] || {}).sheet, '03-员工活动');
  t('C3 未匹配账户名', (hit[0] || {}).account, '不存在的账户');
}

{
  // 金额为空 / 非数字 不参与汇入
  const d = fundData({
    '02-走访慰问': sheet(['序号', C_ACCOUNT, C_VISIT], [
      { 序号: 1, [C_ACCOUNT]: 'A工会', [C_VISIT]: '' },
      { 序号: 2, [C_ACCOUNT]: 'A工会', [C_VISIT]: 'abc' },
      { 序号: 3, [C_ACCOUNT]: 'A工会' },
    ]),
    '03-员工活动': sheet(['序号', C_ACCOUNT, C_ACT], []),
  });
  CE.rollupFundExpense(d, []);
  t('D1 空/非法金额按 0 汇入', d['04-经费收支'].rows[0][C_VISIT_IN], 0);
}

{
  // 万元列（历史表头）要 ×10000
  const d = fundData({
    '02-走访慰问': sheet(['序号', C_ACCOUNT, C_VISIT_W], [
      { 序号: 1, [C_ACCOUNT]: 'A工会', [C_VISIT_W]: 1.5 },
    ]),
    '03-员工活动': sheet(['序号', C_ACCOUNT, C_ACT], []),
  });
  CE.rollupFundExpense(d, []);
  t('D2 万元列名自动换算成元', d['04-经费收支'].rows[0][C_VISIT_IN], 15000);
}

{
  // 缺表 / 空表不炸
  const d1 = { '02-走访慰问': sheet(['序号'], []) };
  CE.rollupFundExpense(d1, []);
  ok('D3 缺 04 表不抛异常', true);
  const d2 = { '04-经费收支': sheet(['序号', C_UNION], [{ 序号: 1, 工会名称: 'X' }]) };
  CE.rollupFundExpense(d2, []);
  ok('D4 缺业务表不抛异常', true);
  const d3 = { '04-经费收支': sheet(['序号', C_UNION], []) };
  CE.rollupFundExpense(d3, []);
  ok('D5 04 表空行不抛异常', true);
}

// ==================================================================
section('E. 提报人列补齐');

{
  const d = {
    '01-组织建设': sheet(['序号', C_UNION, '备注'], [[1, 'X', '']]),
    '02-走访慰问': sheet(['序号', '备注'], [{ 序号: 1, 备注: '' }]),
    '03-员工活动': sheet(['序号', '备注'], [[1, '']]),
    '04-经费收支': sheet(['序号'], []),
  };
  CE.ensureReporterColumns(d);
  ok('E1 01 数组行补出「提报人」', d['01-组织建设'].headers.indexOf(C_REPORTER) >= 0);
  t('E2 01 数组行长度对齐表头', d['01-组织建设'].rows[0].length, d['01-组织建设'].headers.length);
  ok('E3 02 对象行补出「提报人」', C_REPORTER in d['02-走访慰问'].rows[0]);
  ok('E4 03 数组行补出「提报人」', d['03-员工活动'].headers.indexOf(C_REPORTER) >= 0);
  ok('E5 04 表不加「提报人」', d['04-经费收支'].headers.indexOf(C_REPORTER) < 0);
  const before = JSON.stringify(d);
  CE.ensureReporterColumns(d);
  t('E6 ensureReporterColumns 幂等', JSON.stringify(d), before);
  t('E7 REPORTER_FIELD 常量', CE.REPORTER_FIELD || '提报人', '提报人');
}

// ==================================================================
section('F. addMissingColumn：插到指定列之后');

{
  const sh = sheet(['序号', 'A', 'B'], [{ 序号: 1, A: 1, B: 2 }]);
  CE.addMissingColumn(sh, 'C', '', 'A');
  t('F1 新列插在 A 之后', sh.headers.join(','), '序号,A,C,B');
  t('F2 对象行补了 key', C_REPORTER in sh.rows[0] === false && 'C' in sh.rows[0], true);

  const sh2 = sheet(['序号', 'A', 'B'], [[1, 1, 2]]);
  CE.addMissingColumn(sh2, 'C', '', 'A');
  t('F3 数组行同步加格', sh2.rows[0].length, 4);
  CE.addMissingColumn(sh2, 'C', '', 'A');
  t('F4 重复调用幂等', sh2.headers.join(','), '序号,A,C,B');
}

// ==================================================================
section('G. 常量自洽');

{
  t('G1 FUND_SHEET_KEY', CE.FUND_SHEET_KEY, '04-经费收支');
  t('G2 FUND_COL.union', CE.FUND_COL.union, '工会名称');
  t('G3 FUND_COL.total', CE.FUND_COL.total, '支出合计（元）');
  t('G4 汇入来源 2 个', CE.FUND_ROLLUP_SOURCES.length, 2);
  t('G5 来源1 = 02-走访慰问', CE.FUND_ROLLUP_SOURCES[0].sheet, '02-走访慰问');
  t('G6 来源1 账户列', CE.FUND_ROLLUP_SOURCES[0].account, '费用列支账户');
  t('G7 来源2 = 03-员工活动', CE.FUND_ROLLUP_SOURCES[1].sheet, '03-员工活动');
  t('G8 派生列 5 个', (CE.FUND_DERIVED_COLS || []).length, 5);
}

// ==================================================================
// HTTP 端到端：同进程起服务（本环境不允许后台常驻）
// ==================================================================
const WORK = process.env.PORTS_TEST_DATA_DIR || '/tmp/hdj-ports-data';
const PORT = process.env.PORTS_TEST_PORT || '5366';

(async () => {
  section('H. 收集端口：初始化与后台管理');

  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  process.env.DATA_DIR = WORK;
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = '0';
  process.env.FORCE_INSECURE_COOKIE = '1';
  require(path.join(ROOT, 'server.js'));

  const BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 120));
  }

  /* ---- 极简 cookie jar（Node 22 的 fetch 不会自动带 cookie） ----
   * 端口会话只有 /api/port/* 的权限，读不了 /api/data；
   * 所以后台（admin）和端口（port）各存一份 jar，需要哪边就切过去。
   */
  const adminJar = new Map();
  const portJar = new Map();
  let jar = adminJar;
  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  function absorb(res) {
    const raw = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
    raw.forEach(c => {
      const first = c.split(';')[0] || '';
      const i = first.indexOf('=');
      if (i <= 0) return;
      const k = first.slice(0, i).trim();
      const v = first.slice(i + 1).trim();
      if (v === '') jar.delete(k); else jar.set(k, v);
    });
  }
  async function call(method, url, body) {
    const res = await fetch(BASE + url, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        jar.size ? { Cookie: cookieHeader() } : {}
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    absorb(res);
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.indexOf('application/json') >= 0) {
      try { data = await res.json(); } catch (_) {}
    } else {
      data = { __html: true, __text: (await res.text()).slice(0, 60) };
    }
    return { status: res.status, data };
  }
  const get = u => call('GET', u);
  const post = (u, b) => call('POST', u, b || {});
  const put = (u, b) => call('PUT', u, b || {});
  const useAdmin = () => { jar = adminJar; };
  const usePort = () => { jar = portJar; };
  /** 以后台身份读一份全量数据（端口会话没有 /api/data 权限） */
  const adminData = async () => { useAdmin(); return (await get('/api/data')).data; };

  /* H1 未登录访问端口管理 */
  let r = await get('/api/ports');
  t('H1 未登录 GET /api/ports → 401', r.status, 401);
  ok('H1b 返回 needLogin 标记', r.data && r.data.needLogin === true);
  ok('H1c 返回的是 JSON 不是 HTML', !(r.data && r.data.__html));

  /* H2 后台登录 */
  r = await post('/api/auth/login', { role: 'admin', password: 'admin123' });
  t('H2 后台登录成功', r.status, 200);

  /* H3 端口列表 */
  r = await get('/api/ports');
  t('H3 GET /api/ports → 200', r.status, 200);
  t('H4 端口数量 = 10', (r.data.ports || []).length, 10);
  t('H5 默认用户名', (r.data.ports || []).map(p => p.username).join(','),
    'port1,port2,port3,port4,port5,port6,port7,port8,port9,port10');
  const p1 = (r.data.ports || [])[0];
  ok('H6 不含 salt', p1 && p1.salt === undefined);
  ok('H7 不含 hash', p1 && p1.hash === undefined);
  t('H8 默认启用', p1 && p1.enabled, true);
  t('H9 默认授权 3 张表', p1 && (p1.sheets || []).length, 3);

  /* H10 改端口名与用户名 */
  r = await put('/api/ports', {
    ports: (r.data.ports || []).map(p => p.id === 'p1'
      ? Object.assign({}, p, { name: '张三端口', username: 'zhangsan' })
      : p),
  });
  t('H10 保存端口配置 → 200', r.status, 200);
  r = await get('/api/ports');
  const saved1 = (r.data.ports || []).find(p => p.id === 'p1');
  t('H11 端口名已落盘', saved1 && saved1.name, '张三端口');
  t('H12 用户名已落盘', saved1 && saved1.username, 'zhangsan');

  /* H13 用户名撞车 → 400 */
  r = await put('/api/ports', {
    ports: (r.data.ports || []).map(p => p.id === 'p2'
      ? Object.assign({}, p, { username: 'zhangsan' }) : p),
  });
  t('H13 用户名重复 → 400', r.status, 400);
  ok('H13b 提示里点名重复用户名', r.data && /用户名重复/.test(r.data.error || ''));
  r = await get('/api/ports');
  t('H13c 失败后 p2 用户名未被改坏', (r.data.ports.find(p => p.id === 'p2') || {}).username, 'port2');

  /* H14 改授权表 + 重置密码 */
  r = await put('/api/ports', {
    ports: (r.data.ports || []).map(p => p.id === 'p1'
      ? Object.assign({}, p, { password: 'newpass123', sheets: ['01-组织建设'] })
      : p),
  });
  t('H14 改授权 + 重置密码 → 200', r.status, 200);
  let portsNow = (await get('/api/ports')).data.ports;
  t('H15 端口数仍为 10', portsNow.length, 10);
  t('H16 端口1 授权表收窄为 1 张', ((portsNow.find(p => p.id === 'p1') || {}).sheets || []).length, 1);

  /* H17 合并语义：只传 1 个端口，其余 9 个必须原样保留 */
  r = await put('/api/ports', { ports: [{ id: 'p3', name: '李四端口' }] });
  t('H17 只传 1 个端口 → 200（合并更新）', r.status, 200);
  portsNow = (await get('/api/ports')).data.ports;
  t('H18 合并后端口数仍为 10', portsNow.length, 10);
  t('H19 p3 已改名', (portsNow.find(p => p.id === 'p3') || {}).name, '李四端口');
  t('H20 p2 未被误删且用户名不变', (portsNow.find(p => p.id === 'p2') || {}).username, 'port2');

  /* H21 未知端口 id → 400，且不影响现有端口 */
  r = await put('/api/ports', { ports: [{ id: 'p99', name: '幽灵' }] });
  t('H21 未知端口 id → 400', r.status, 400);
  t('H22 失败后端口数仍为 10', (await get('/api/ports')).data.ports.length, 10);

  /* ==============================================================
     端口会话：先登出后台，改用端口登录
     ============================================================== */
  section('I. 端口登录与会话隔离');

  portJar.clear();
  usePort();
  r = await post('/api/port/login', { username: 'zhangsan', password: 'gh123456' });
  t('I1 旧密码失效 → 401', r.status, 401);

  r = await post('/api/port/login', { username: 'zhangsan', password: 'newpass123' });
  t('I2 新密码登录 → 200', r.status, 200);
  t('I3 角色 = port', r.data && r.data.role, 'port');
  t('I4 端口 id', r.data && r.data.portId, 'p1');

  r = await get('/api/port/me');
  t('I5 me → 200', r.status, 200);
  t('I6 me 端口名', r.data && r.data.name, '张三端口');
  t('I7 me 授权表只剩 1 张', r.data && (r.data.sheets || []).length, 1);

  r = await get('/api/port/records');
  t('I8 新端口初始 0 条', (r.data.records || []).length, 0);

  /* I9 未授权的表不能提交 */
  r = await post('/api/port/submit', { sheet: '02-走访慰问', row: { 员工姓名: '李四' } });
  t('I9 未授权表提交 → 400', r.status, 400);

  /* I10 必填校验 */
  r = await post('/api/port/submit', { sheet: '01-组织建设', row: { [C_UNION]: '' } });
  t('I10 必填为空 → 400', r.status, 400);

  /* I11 正常提交 */
  r = await post('/api/port/submit', {
    sheet: '01-组织建设',
    row: { [C_UNION]: '新筹建工会A', 依托公司: '测试公司', 组建状态: '筹建中', 工会级别: '二级工会', 工作负责人: '王五' },
  });
  t('I11 正常提交 → 200', r.status, 200);
  r = await get('/api/port/records');
  t('I12 记录数 = 1', (r.data.records || []).length, 1);
  t('I13 自动写入提报人', (r.data.records[0] || {}).row[C_REPORTER], '张三端口');

  /* I14 端口2 看不到 */
  portJar.clear();
  usePort();
  r = await post('/api/port/login', { username: 'port2', password: 'gh123456' });
  t('I14 端口2 默认密码登录 → 200', r.status, 200);
  r = await get('/api/port/records');
  t('I15 端口2 看不到端口1 的记录', (r.data.records || []).length, 0);

  /* I16 端口2 越权改端口1 的记录 */
  r = await post('/api/port/update', { sheet: '01-组织建设', index: 0, row: { [C_UNION]: '被篡改' } });
  t('I16 越权修改 → 403', r.status, 403);
  r = await post('/api/port/delete', { sheet: '01-组织建设', index: 0 });
  t('I17 越权删除 → 403', r.status, 403);

  /* I18 端口会话不能碰后台接口 */
  r = await get('/api/ports');
  t('I18 端口会话访问后台端口管理 → 401', r.status, 401);

  /* I19 端口不能篡改「提报人」列 */
  portJar.clear();
  usePort();
  await post('/api/port/login', { username: 'zhangsan', password: 'newpass123' });
  r = await post('/api/port/submit', {
    sheet: '01-组织建设',
    row: { [C_UNION]: 'B工会2', 依托公司: '测试公司', 组建状态: '已组建', 工会级别: '一级工会', [C_REPORTER]: '冒充管理员' },
  });
  t('I19 携带伪造提报人也能提交', r.status, 200);
  r = await get('/api/port/records');
  const forged = (r.data.records || []).find(x => x.row[C_UNION] === 'B工会2');
  t('I20 伪造的提报人被覆盖为真实端口名', forged && forged.row[C_REPORTER], '张三端口');

  /* ==============================================================
     经费汇入 HTTP 全链路
     ============================================================== */
  section('J. 经费汇入：提报后 04 表自动重算');

  /* 恢复后台登录，给 p1 授权 02/03 两张表并重置一个已知密码 */
  adminJar.clear();
  useAdmin();
  await post('/api/auth/login', { role: 'admin', password: 'admin123' });
  r = await get('/api/ports');
  r = await put('/api/ports', {
    ports: (r.data.ports || []).map(p => p.id === 'p1'
      ? Object.assign({}, p, { password: 'newpass123', sheets: ['02-走访慰问', '03-员工活动'] })
      : p),
  });
  t('J0 给端口1 授权 02/03 表', r.status, 200);

  /* 取 04 表基线 */
  let d = await adminData();
  const fund = d['04-经费收支'];
  const tName = String(asObj(fund.rows.find(rr => String(asObj(rr, fund.headers)[C_UNION] || '').trim()), fund.headers)[C_UNION] || '').trim();
  console.log(`  · 基线工会：${tName}`);

  const fundOf = (data, name) => {
    const sh = data['04-经费收支'];
    const row = (sh.rows || []).find(rr => String(asObj(rr, sh.headers)[C_UNION] || '').trim() === name);
    return { sh, row: row ? asObj(row, sh.headers) : {} };
  };
  const num = v => Number(String(v === undefined || v === null ? '' : v).replace(/,/g, '')) || 0;
  const snap = (data) => {
    const { row } = fundOf(data, tName);
    return {
      visitIn: num(row[C_VISIT_IN]),
      actIn: num(row[C_ACT_IN]),
      total: num(row[C_TOTAL]),
      bal: num(row[C_BAL]),
      balW: num(row[C_BAL_W]),
    };
  };

  const base = snap(d);
  console.log(`  · 基线：慰问汇入=${base.visitIn} 活动汇入=${base.actIn} 支出合计=${base.total} 结余=${base.bal}`);

  /* 端口1 报一笔 1000 元走访慰问 */
  portJar.clear();
  usePort();
  await post('/api/port/login', { username: 'zhangsan', password: 'newpass123' });
  r = await post('/api/port/submit', {
    sheet: '02-走访慰问',
    row: {
      慰问类型: '其他', 员工姓名: '测试员工', 所在大区: '测试大区',
      '员工所在部门/门店': '测试门店', 慰问日期: '2026-10-01',
      [C_VISIT]: 1000, [C_ACCOUNT]: tName,
    },
  });
  t('J1 提交走访慰问 → 200', r.status, 200);

  d = await adminData();
  let s = snap(d);
  t('J2 慰问支出汇入 +1000', s.visitIn, base.visitIn + 1000);
  t('J3 支出合计 +1000', s.total, base.total + 1000);
  t('J4 结余 -1000', s.bal, base.bal - 1000);

  /* 端口1 再报一笔 500 元员工活动 */
  usePort();
  r = await post('/api/port/submit', {
    sheet: '03-员工活动',
    row: {
      活动日期: '2026-10-02', 活动内容: '测试活动', 活动形式: '线下活动',
      活动类型: '文体活动', 覆盖人数: 10, [C_ACT]: 500, [C_ACCOUNT]: tName,
    },
  });
  t('J5 提交员工活动 → 200', r.status, 200);

  d = await adminData();
  s = snap(d);
  t('J6 活动支出汇入 +500', s.actIn, base.actIn + 500);
  t('J7 支出合计 +1500', s.total, base.total + 1500);
  t('J8 结余 -1500', s.bal, base.bal - 1500);

  /* 删掉走访那条 → 汇入回退 */
  d = await adminData();
  const vs = d['02-走访慰问'];
  let vIdx = -1;
  (vs.rows || []).forEach((rr, i) => {
    if (String(asObj(rr, vs.headers)[C_REPORTER] || '').trim() === '张三端口') vIdx = i;
  });
  ok('J9 找到端口1 提报的走访记录', vIdx >= 0);
  usePort();
  r = await post('/api/port/delete', { sheet: '02-走访慰问', index: vIdx });
  t('J10 删除自己提报的记录 → 200', r.status, 200);

  d = await adminData();
  s = snap(d);
  t('J11 删除后慰问汇入回到基线', s.visitIn, base.visitIn);
  t('J12 活动汇入不受影响', s.actIn, base.actIn + 500);
  t('J13 结余回到基线-500', s.bal, base.bal - 500);

  /* 账户名对不上 → 不计入 */
  usePort();
  r = await post('/api/port/submit', {
    sheet: '02-走访慰问',
    row: {
      慰问类型: '其他', 员工姓名: '无归属', 所在大区: 'X', '员工所在部门/门店': 'X',
      [C_VISIT]: 777, [C_ACCOUNT]: '查无此工会',
    },
  });
  t('J14 对不上账户也能保存（不拦业务）', r.status, 200);
  d = await adminData();
  s = snap(d);
  t('J15 对不上的金额不计入该工会', s.visitIn, base.visitIn);

  /* 清空端口 */
  jar.clear();
  await post('/api/auth/login', { role: 'admin', password: 'admin123' });
  r = await post('/api/ports/clear', { id: 'p1' });
  t('J16 清空端口1 → 200', r.status, 200);
  ok('J17 清掉了 2 条以上', r.data && r.data.removed >= 2);

  /* 清空后 04 表汇入应回到基线 */
  d = await adminData();
  s = snap(d);
  t('J18 清空后活动汇入回到基线', s.actIn, base.actIn);
  t('J19 清空后结余回到基线', s.bal, base.bal);

  /* 禁用端口后不能登录 */
  r = await put('/api/ports', {
    ports: ((await (await get('/api/ports'))).data.ports || [])
      .map(p => (p.id === 'p1' ? Object.assign({}, p, { enabled: false }) : p)),
  });
  t('J20 禁用端口 → 200', r.status, 200);
  jar.clear();
  r = await post('/api/port/login', { username: 'zhangsan', password: 'newpass123' });
  t('J21 已禁用端口无法登录 → 401', r.status, 401);

  /* ============================================================== */
  section('K. 静态资源白名单（匿名）');
  jar.clear();
  for (const f of ['/collect.html', '/login.html']) {
    const rr = await get(f);
    ok(`K1 匿名可访问 ${f}`, rr.status === 200);
  }
  for (const f of ['/server.js', '/admin.js', '/app.js', '/server-config.js']) {
    const rr = await get(f);
    ok(`K2 匿名拒绝访问 ${f}`, rr.status !== 200);
  }

  console.log(`\n${'='.repeat(62)}`);
  console.log(`  通过 ${PASS} 项，失败 ${FAIL} 项`);
  console.log('='.repeat(62));
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('[test-ports] 运行失败:', e); process.exit(2); });
