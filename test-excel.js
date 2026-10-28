#!/usr/bin/env node
/**
 * Excel 导入 / 导出回归测试（v1.8.0）
 *
 * A. 导出：xlsx 结构、数字类型、回读一致性
 * B. 模板：表头 + 填写说明，且不含示例数据（防止误导）
 * C. 解析：列名乱序 / 缺列 / 多列 / 未知列 / 空行 / 找不到表头
 * D. 校验：非数字、小数位、最小值、下拉值、必填、千分位、日期
 * E. 系统列：序号重排、汇入列忽略、提报人保留
 * F. HTTP：列表 / 单表导出 / 模板 / 全量导出 / 404 / 权限
 * G. HTTP：导入（预检 / 追加 / 覆盖 / 拒绝 / 快照 / 汇入重算 / 端口越权）
 *
 * 用法：node test-excel.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let PASS = 0, FAIL = 0;
function t(desc, actual, expected) {
  const ok = String(actual) === String(expected);
  ok ? PASS++ : FAIL++;
  console.log(`  ${ok ? '✅' : '❌'} ${desc.padEnd(52)} ${ok ? actual : `实际=[${actual}] 期望=[${expected}]`}`);
}
function ok(desc, cond) { t(desc, !!cond, true); }
function section(s) { console.log(`\n【${s}】`); }

const E = require(path.join(ROOT, 'excel-io.js'));
const SCHEMA = require(path.join(ROOT, 'schema.js'));
const XLSX = require(path.join(ROOT, 'lib', 'xlsx.full.min.js'));

/** 用「二维表」造一个 xlsx（模拟用户自己填的表） */
function mkWorkbook(aoa, sheetName) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName || 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const K01 = '01-组织建设';
const K02 = '02-走访慰问';
const K04 = '04-经费收支';
const C_ACCOUNT = '费用列支账户';
const C_VISIT = '慰问物品金额（元）';
const C_VISIT_IN = '慰问支出汇入（元）';
const C_TOTAL = '支出合计（元）';
const C_BAL = '当前结余（元）';
const C_REPORTER = '提报人';
const C_UNION = '工会名称';

/** 02 表的合法最小行（必填列齐全） */
const R02 = (name, acct, amt, extra) => Object.assign({
  序号: 1, 慰问类型: '其他', 员工姓名: name, 所在大区: '华北', '员工所在部门/门店': '某门店',
  慰问日期: '2026-01-05', [C_VISIT]: amt, [C_ACCOUNT]: acct, 具体事由: '', 经办人: '', [C_REPORTER]: '', 备注: '',
}, extra || {});

const H02 = Object.keys(SCHEMA[K02]).filter(h => h !== '序号');
const H02_FULL = ['序号'].concat(H02);

// ==================================================================
section('A. 导出：结构 / 类型 / 回读');

{
  const rows = [
    Object.assign(R02('张三', 'A工会', 500), { 序号: 1 }),
    Object.assign(R02('李四', 'B工会', 300.5), { 序号: 2 }),
  ];
  const buf = E.buildWorkbook([{ key: K02, headers: H02_FULL, rows, schema: SCHEMA[K02] }]);
  t('A1 导出文件是 xlsx（PK 头）', buf.slice(0, 2).toString().replace(/\x50\x4b/, 'PK') === 'PK' ? 'PK' : 'NO', 'PK');
  ok('A2 文件大小 > 3KB', buf.length > 3000);

  const back = XLSX.read(buf, { type: 'buffer' });
  t('A3 工作表名 = 表名', back.SheetNames.join(','), K02);
  const aoa = XLSX.utils.sheet_to_json(back.Sheets[K02], { header: 1, defval: null });
  t('A4 第 1 行是表头且顺序一致', aoa[0].join('|'), H02_FULL.join('|'));
  t('A5 数据行数一致', aoa.length - 1, 2);
  const amtCol = aoa[0].indexOf(C_VISIT);
  t('A6 金额列导出为数字类型', typeof aoa[1][amtCol], 'number');
  t('A7 金额值精确', aoa[2][amtCol], 300.5);
  t('A8 序号是数字', typeof aoa[1][0], 'number');
  t('A9 文本列保持文本', aoa[1][aoa[0].indexOf('员工姓名')], '张三');
}

{
  const buf = E.buildWorkbook([{ key: K01, headers: ['序号', '工会名称', '职工人数'], rows: [['1', 'X', '12']], schema: SCHEMA[K01] }]);
  const aoa = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets[K01], { header: 1, defval: null });
  t('A10 数字列里的字符串 "12" 被转成数字', typeof aoa[1][2], 'number');
}

// ==================================================================
section('B. 模板：表头 + 填写说明');

{
  const buf = E.buildTemplate({ key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  const wb = XLSX.read(buf, { type: 'buffer' });
  t('B1 模板含两张表（数据 + 说明）', wb.SheetNames.join(','), `${K02},填写说明`);

  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[K02], { header: 1, defval: null });
  t('B2 模板第 1 行 = 完整表头', aoa[0].join('|'), H02_FULL.join('|'));
  t('B3 模板不含示例数据（只有 1 行）', aoa.length, 1);

  const help = XLSX.utils.sheet_to_json(wb.Sheets['填写说明'], { header: 1, defval: '' });
  const flat = help.map(r => (r || []).join(' ')).join('\n');
  ok('B4 说明表提到表名', flat.indexOf(K02) >= 0);
  ok('B5 说明表列出必填列', flat.indexOf('慰问类型') >= 0 && flat.indexOf('必填') >= 0);
  ok('B6 说明表列出下拉可选项', flat.indexOf('员工直系亲属重大疾病') >= 0);
  ok('B7 说明表标注「系统自动编号」（序号）', flat.indexOf('自动编号') >= 0);

  const buf4 = E.buildTemplate({ key: K04, headers: H02_FULL.slice(0, 0).concat(Object.keys(SCHEMA[K04])), schema: SCHEMA[K04] });
  const help4 = XLSX.utils.sheet_to_json(XLSX.read(buf4, { type: 'buffer' }).Sheets['填写说明'], { header: 1, defval: '' });
  const flat4 = help4.map(r => (r || []).join(' ')).join('\n');
  ok('B8 说明表标注汇入列为「系统自动计算」', flat4.indexOf('系统自动计算') >= 0);
  ok('B9 说明表提到 04 表只读列', flat4.indexOf(C_VISIT_IN) >= 0);
}

// ==================================================================
section('C. 解析：列匹配');

{
  // 列顺序打乱 + 夹一列不认识的 + 缺一个选填列（备注）
  const hdr = [C_ACCOUNT, '员工姓名', '未知自定义列', '慰问类型', '所在大区', '员工所在部门/门店', C_VISIT];
  const buf = mkWorkbook([
    ['一些说明文字，故意放在表头上方'],
    hdr,
    ['A工会', '王五', '随便写', '其他', '华南', '某门店', 800],
  ], '随便起的表名');
  const p = E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  t('C1 表头不在第 1 行也能认出来', p.headerRowNo, 2);
  t('C2 解析出 1 行', p.rows.length, 1);
  t('C3 列被打乱后值仍对得上（员工姓名）', p.rows[0]['员工姓名'], '王五');
  t('C4 列被打乱后值仍对得上（金额）', p.rows[0][C_VISIT], 800);
  t('C5 未知列被忽略', p.unknownColumns.join(','), '未知自定义列');
  ok('C6 未知列产生 warning', p.warnings.length > 0);
  t('C7 缺的选填列补空串', p.rows[0]['备注'], '');
  t('C8 无错误', p.errors.length, 0);
}

{
  const buf = mkWorkbook([['慰问类型', '员工姓名'], ['其他', '赵六']], 'x');
  const p = E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  ok('C9 缺必填列「所在大区」报错', p.errors.some(e => e.indexOf('缺少必填列') >= 0));
  ok('C10 缺选填列只提示、不算错误', !p.errors.some(e => e.indexOf('备注') >= 0));
}

{
  const buf = mkWorkbook([['员工姓名', '员工姓名', '慰问类型', '所在大区', '员工所在部门/门店'], ['a', 'b', '其他', 'x', 'y']], 'x');
  const p = E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  ok('C11 重复列报错', p.errors.some(e => e.indexOf('重复的列') >= 0));
}

{
  const buf = mkWorkbook([['员工姓名', '慰问类型', '所在大区', '员工所在部门/门店'], ['甲', '其他', 'x', 'y'], ['', '', '', ''], [null, null, '', '']], 'x');
  const p = E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  t('C12 空行被跳过（只解析 1 行）', p.rows.length, 1);
  t('C13 空行计数', p.skippedEmpty, 2);
}

{
  const buf = mkWorkbook([['完全不', '相干', '的列'], [1, 2, 3]], 'x');
  let code = '';
  try { E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] }); } catch (e) { code = e.code; }
  t('C14 认不出表头时报 NO_HEADER', code, 'NO_HEADER');
}

{
  let code = '';
  try { E.parseSheet(Buffer.from('this is not a workbook at all'), { key: K02, headers: H02_FULL, schema: SCHEMA[K02] }); } catch (e) { code = e.code; }
  ok('C15 垃圾内容不会让进程崩溃（抛 BAD_FILE / NO_HEADER）', code === 'BAD_FILE' || code === 'NO_HEADER');
}

// ==================================================================
section('D. 校验：与后台手工录入同一口径');

const parseOne = (over) => {
  const row = Object.assign({ 慰问类型: '其他', 员工姓名: '甲', 所在大区: 'x', '员工所在部门/门店': 'y' }, over);
  const hdr = Object.keys(row);
  const buf = mkWorkbook([hdr, hdr.map(h => row[h])], 'x');
  return E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
};

{
  ok('D1 金额写成文字 → 报错', parseOne({ [C_VISIT]: '五百块' }).errors.some(e => e.indexOf('不是数字') >= 0));
  ok('D2 金额 3 位小数 → 报错（默认 2 位）', parseOne({ [C_VISIT]: 12.345 }).errors.some(e => e.indexOf('最多 2 位小数') >= 0));
  ok('D3 金额负数 → 报错（min 0）', parseOne({ [C_VISIT]: -5 }).errors.some(e => e.indexOf('不能小于 0') >= 0));
  ok('D4 下拉值写错 → 报错并列出可选项', parseOne({ 慰问类型: '大病人数' }).errors.some(e => e.indexOf('只能取') >= 0));
  ok('D5 必填留空 → 报错', parseOne({ 员工姓名: '' }).errors.some(e => e.indexOf('不能为空') >= 0));
  t('D6 金额带千分位 → 正确解析', parseOne({ [C_VISIT]: '1,234.5' }).rows[0][C_VISIT], 1234.5);
  t('D7 金额带「元」→ 正确解析', parseOne({ [C_VISIT]: '1,000元' }).rows[0][C_VISIT], 1000);
  t('D8 金额为 0 不会被当成空', parseOne({ [C_VISIT]: 0 }).rows[0][C_VISIT], 0);
  t('D9 小数 2 位刚好合规', parseOne({ [C_VISIT]: 12.34 }).rows[0][C_VISIT], 12.34);
}

{
  // 日期：Date 对象 与 Excel 序列号 两种来源都要还原成 YYYY-MM-DD
  const buf = mkWorkbook([['慰问类型', '员工姓名', '所在大区', '员工所在部门/门店', '慰问日期'], ['其他', '甲', 'x', 'y', new Date(Date.UTC(2026, 2, 9))]], 'x');
  const p = E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  t('D10 Date 单元格 → YYYY-MM-DD', p.rows[0]['慰问日期'], '2026-03-09');
  t('D11 序列号转日期', E.coerceCell(SCHEMA[K02]['慰问日期'], 46090, '慰问日期').value, '2026-03-09');
}

// ==================================================================
section('E. 系统列：序号 / 汇入列 / 提报人');

{
  const buf = mkWorkbook([
    ['序号', '慰问类型', '员工姓名', '所在大区', '员工所在部门/门店', C_VISIT, C_REPORTER],
    [99, '其他', '甲', 'x', 'y', 100, '张伟'],
  ], 'x');
  const p = E.parseSheet(buf, { key: K02, headers: H02_FULL, schema: SCHEMA[K02] });
  t('E1 序号不接受文件里的值（清空待重排）', p.rows[0]['序号'], '');
  t('E2 提报人按文件里的值保留', p.rows[0][C_REPORTER], '张伟');
}

{
  const H04 = Object.keys(SCHEMA[K04]);
  const buf = mkWorkbook([
    [C_UNION, '收支类型', '经费项目', C_VISIT_IN, C_TOTAL, C_BAL],
    ['测试工会', '收入', '会员会费', 99999, 88888, 77777],
  ], 'x');
  const p = E.parseSheet(buf, { key: K04, headers: H04, schema: SCHEMA[K04] });
  t('E3 汇入列被忽略（慰问支出汇入）', p.rows[0][C_VISIT_IN], '');
  t('E4 汇入列被忽略（支出合计）', p.rows[0][C_TOTAL], '');
  t('E5 汇入列被忽略（当前结余）', p.rows[0][C_BAL], '');
  t('E6 填了汇入列也不报错', p.errors.length, 0);
}

// ==================================================================
section('F. HTTP：列表 / 导出 / 模板');

const WORK = process.env.EXCEL_TEST_DATA_DIR || '/tmp/hdj-excel-data';
const PORT = process.env.EXCEL_TEST_PORT || '5377';

(async () => {
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

  const jar = new Map();
  const portJar = new Map();
  let cur = jar;
  const cookieHeader = () => [...cur.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  function absorb(res) {
    const raw = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
    raw.forEach(c => {
      const first = c.split(';')[0] || '';
      const i = first.indexOf('=');
      if (i <= 0) return;
      const k = first.slice(0, i).trim(), v = first.slice(i + 1).trim();
      if (v === '') cur.delete(k); else cur.set(k, v);
    });
  }
  async function req(method, url, body, opt) {
    const o = opt || {};
    const headers = Object.assign({}, cur.size ? { Cookie: cookieHeader() } : {}, o.headers || {});
    let payload;
    // 注意：SheetJS 的 write({type:'buffer'}) 返回的是 Uint8Array，不是 Buffer，
    // 只用 Buffer.isBuffer 判断会把它当普通对象 JSON.stringify 掉（发出去变成数字数组）。
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    absorb(res);
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.indexOf('json') >= 0) { try { data = await res.json(); } catch (_) {} }
    else data = { __bin: true };
    return { status: res.status, data, headers: res.headers, buf: ct.indexOf('json') < 0 ? Buffer.from(await res.arrayBuffer()) : null };
  }
  const get = u => req('GET', u);
  const post = (u, b, o) => req('POST', u, b, o);
  const adminData = async () => (await get('/api/data')).data;
  const rowsOf = (d, k) => (d[k] && d[k].rows ? d[k].rows.length : 0);

  let r = await get('/api/excel/sheets');
  t('F1 未登录访问导出接口 → 401', r.status, 401);

  await post('/api/auth/login', { role: 'admin', password: 'admin123' });

  r = await get('/api/excel/sheets');
  t('F2 表清单 → 200', r.status, 200);
  t('F3 有 5 张表', (r.data.sheets || []).length, 5);
  ok('F4 每张表带行数与列数', (r.data.sheets || []).every(s => typeof s.rows === 'number' && typeof s.cols === 'number'));

  const d0 = await adminData();
  r = await get('/api/excel/export/' + encodeURIComponent(K02));
  t('F5 导出单表 → 200', r.status, 200);
  ok('F6 返回的是 xlsx（PK 头）', r.buf && r.buf[0] === 0x50 && r.buf[1] === 0x4b);
  ok('F7 Content-Type 正确', (r.headers.get('content-type') || '').indexOf('spreadsheetml') >= 0);
  ok('F8 文件名是 attachment 且带中文编码', (r.headers.get('content-disposition') || '').indexOf("filename*=UTF-8''") >= 0);

  {
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
    t('F9 导出文件数据行数 = 表里行数', aoa.length - 1, rowsOf(d0, K02));
    t('F10 导出文件表头 = 表头', aoa[0].join('|'), d0[K02].headers.join('|'));
  }

  r = await get('/api/excel/template/' + encodeURIComponent(K02));
  t('F11 下载模板 → 200', r.status, 200);
  {
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    ok('F12 模板含「填写说明」表', wb.SheetNames.indexOf('填写说明') >= 0);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
    t('F13 模板只有表头没有数据', aoa.length, 1);
  }

  r = await get('/api/excel/export-all');
  t('F14 全量导出 → 200', r.status, 200);
  {
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    t('F15 全量导出含 5 张表', wb.SheetNames.length, 5);
    ok('F16 全量导出含 04 表', wb.SheetNames.indexOf(K04) >= 0);
  }

  r = await get('/api/excel/export/' + encodeURIComponent('99-不存在的表'));
  t('F17 导出不存在的表 → 404', r.status, 404);
  r = await get('/api/excel/template/' + encodeURIComponent('99-不存在的表'));
  t('F18 模板不存在的表 → 404', r.status, 404);

  // ================================================================
  section('G. HTTP：导入');

  /** 造一个 02 表导入文件 */
  function visitFile(list, extraHeader) {
    const hdr = ['慰问类型', '员工姓名', '所在大区', '员工所在部门/门店', '慰问日期', C_VISIT, C_ACCOUNT].concat(extraHeader || []);
    const aoa = [hdr].concat(list.map(x => [
      x.type || '其他', x.name, '华北', '某门店', x.date || '2026-03-01', x.amt, x.acct,
    ].concat((extraHeader || []).map(() => ''))));
    return mkWorkbook(aoa, K02);
  }
  const impUrl = (mode, q) => `/api/excel/import/${encodeURIComponent(K02)}?mode=${mode}${q || ''}`;
  const OCT = { headers: { 'Content-Type': 'application/octet-stream' } };

  const before02 = rowsOf(await adminData(), K02);

  r = await post(impUrl('append', '&dryRun=1'), visitFile([{ name: '预检甲', amt: 100, acct: '某工会' }]), OCT);
  t('G1 预检 → 200', r.status, 200);
  if (r.status !== 200) console.log('    ↳ 预检返回：', JSON.stringify(r.data).slice(0, 400));
  t('G2 预检识别出 1 行', r.data.incoming, 1);
  ok('G3 预检返回预览数据', Array.isArray(r.data.preview) && r.data.preview[0]['员工姓名'] === '预检甲');
  t('G4 预检不写库（行数不变）', rowsOf(await adminData(), K02), before02);

  r = await post(impUrl('append'), visitFile([{ name: '追加甲', amt: 100, acct: '某工会' }]), OCT);
  t('G5 追加导入 → 200', r.status, 200);
  t('G6 追加 1 行', r.data.added, 1);
  t('G7 表行数 +1', rowsOf(await adminData(), K02), before02 + 1);

  {
    const d = await adminData();
    const sh = d[K02];
    ok('G8 导入的行是对象行（不是数组）', !Array.isArray(sh.rows[sh.rows.length - 1]));
    const last = sh.rows[sh.rows.length - 1];
    t('G9 序号重排为最后一行行号', last['序号'], before02 + 1);
    t('G10 金额正确落库', Number(last[C_VISIT]), 100);
    t('G11 中文列名落库正确', last['员工姓名'], '追加甲');
  }

  r = await post(impUrl('append'), visitFile([{ name: '追加乙', amt: 200, acct: '某工会' }]), OCT);
  t('G12 再追加 1 行', rowsOf(await adminData(), K02), before02 + 2);

  r = await post(impUrl('append'), visitFile([{ name: '', amt: 100, acct: '' }]), OCT);
  t('G13 有必填留空 → 400', r.status, 400);
  ok('G14 返回逐行错误说明', Array.isArray(r.data.errors) && r.data.errors.length > 0);
  t('G15 被拦下时数据不变', rowsOf(await adminData(), K02), before02 + 2);

  r = await post(impUrl('append'), visitFile([{ name: '金额错', amt: '一千', acct: '' }]), OCT);
  t('G16 金额非数字 → 400', r.status, 400);
  ok('G17 错误信息指明是数字问题', JSON.stringify(r.data.errors).indexOf('不是数字') >= 0);

  r = await post(impUrl('append'), Buffer.from('这不是表格'), OCT);
  t('G18 垃圾文件 → 400', r.status, 400);
  t('G19 垃圾文件不动数据', rowsOf(await adminData(), K02), before02 + 2);

  r = await post(impUrl('append'), Buffer.alloc(0), OCT);
  ok('G20 空文件 → 400', r.status === 400 || r.status === 411);

  r = await post(impUrl('replace'), visitFile([{ name: '覆盖甲', amt: 50, acct: '' }]), OCT);
  t('G21 覆盖模式不带 confirm → 400', r.status, 400);
  t('G22 未确认时不写库', rowsOf(await adminData(), K02), before02 + 2);

  r = await post(impUrl('replace', '&confirm=1'), visitFile([{ name: '覆盖甲', amt: 50, acct: '' }, { name: '覆盖乙', amt: 60, acct: '' }]), OCT);
  t('G23 覆盖导入（带 confirm）→ 200', r.status, 200);
  t('G24 覆盖后行数 = 文件行数', rowsOf(await adminData(), K02), 2);
  {
    const d = await adminData();
    const first = d[K02].rows[0];
    t('G25 覆盖后第 1 行是文件第 1 行', first['员工姓名'], '覆盖甲');
    t('G26 覆盖后序号从 1 开始', first['序号'], 1);
  }

  // 覆盖导入后要能找回（自动快照）
  r = await get('/api/backups');
  const snap = (r.data.backups || []).filter(b => b.kind === 'data' && b.name.indexOf('before-import') >= 0);
  ok('G27 导入前自动留了快照（before-import）', snap.length > 0);

  // ================================================================
  section('H. HTTP：导入后经费汇入重算');

  {
    const d = await adminData();
    const union = String(d[K04].rows.map(x => {
      const H = d[K04].headers;
      return Array.isArray(x) ? x[H.indexOf(C_UNION)] : x[C_UNION];
    }).filter(Boolean)[0] || '').trim();
    console.log(`  · 目标工会：${union}`);

    const fundSnap = async () => {
      const dd = await adminData();
      const H = dd[K04].headers;
      const row = dd[K04].rows.map(x => (Array.isArray(x) ? H.reduce((o, h, i) => (o[h] = x[i], o), {}) : x))
        .find(x => String(x[C_UNION] || '').trim() === union) || {};
      const n = v => Number(String(v === undefined || v === null ? '' : v).replace(/,/g, '')) || 0;
      return { visitIn: n(row[C_VISIT_IN]), total: n(row[C_TOTAL]), bal: n(row[C_BAL]) };
    };
    const base = await fundSnap();
    console.log(`  · 基线：慰问汇入=${base.visitIn} 支出合计=${base.total} 结余=${base.bal}`);

    r = await post(impUrl('append'), visitFile([{ name: '汇入测试', amt: 700, acct: union }]), OCT);
    t('H1 导入一条带「费用列支账户」的走访 → 200', r.status, 200);
    const after = await fundSnap();
    t('H2 慰问支出汇入 +700', after.visitIn, base.visitIn + 700);
    t('H3 支出合计 +700', after.total, base.total + 700);
    t('H4 结余 -700', after.bal, base.bal - 700);
  }

  // ================================================================
  section('I. 权限：收集端口不能碰 Excel 接口');

  portJar.clear();
  cur = portJar;
  // 端口用户名/密码是后台配置出来的，不写死；先按后台视角取第一个端口的用户名
  const firstPort = (await (async () => { cur = jar; const rr = await get('/api/ports'); return (rr.data.ports || [])[0]; })()) || {};
  cur = portJar;
  r = await post('/api/port/login', { username: firstPort.username, password: 'gh123456' });
  t('I1 端口登录成功', r.status, 200);
  r = await get('/api/excel/sheets');
  t('I2 端口会话读表清单被拒（401 needLogin）', `${r.status}/${r.data && r.data.needLogin}`, '401/true');
  r = await get('/api/excel/export/' + encodeURIComponent(K02));
  t('I3 端口会话导出被拒（401 needLogin）', `${r.status}/${r.data && r.data.needLogin}`, '401/true');
  ok('I3b 没有返回任何文件字节', !(r.buf && r.buf.length));
  r = await post(impUrl('append'), visitFile([{ name: '越权', amt: 1, acct: '' }]), OCT);
  t('I4 端口会话导入被拒（401 needLogin）', `${r.status}/${r.data && r.data.needLogin}`, '401/true');
  cur = jar;
  r = await get('/api/data');
  ok('I5 越权尝试后数据未被改动（端口那条没写进去）',
    !JSON.stringify((r.data || {})[K02] || {}).includes('越权'));

  // ================================================================
  console.log(`\n${FAIL === 0 ? '✅ 全部通过' : '❌ 有失败项'}：${PASS} 通过 / ${FAIL} 失败`);
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n测试崩溃:', e);
  process.exit(2);
});
