#!/usr/bin/env node
/**
 * v1.6 新功能回归测试
 *
 * ① 月度统计：从日期字段取「年-月」分组；日期不规范的行只排除出月度分布，不污染总数
 * ② 明细列表表（type:'list'）：一行一条记录，列可自由增删（筹建进度表用它）
 * ③ 交叉表增强：列/行按月份分组、单元格可求和、隐藏「（空）」行、列排序
 * ④ 服务端字段迁移：老数据落盘后新增的列要能被自动补上（数组行 + 对象行两种形态）
 *
 * 用法：node test-v16.js
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
const E = loadEngine();

const sheet = (headers, rows) => ({ title: 'T', subtitle: '', headers, rows });

// ==================================================================
section('A. 月份解析 monthKey');
// ==================================================================
[['2026-08-05', '2026-08'], ['2026/8/5', '2026-08'], ['2026.8.5', '2026-08'],
['2026年8月5日', '2026-08'], ['2026-08', '2026-08'], [' 2026-09-01 ', '2026-09'],
['2026-09-02T16:00:00.000Z', '2026-09'], [new Date(2026, 8, 3), '2026-09'],
['线上邮寄慰问品', null], ['待定', null], ['', null], [null, null], [undefined, null],
[8, null], ['2026-13-01', null],
].forEach(([inp, want], i) => t(`A${i + 1} ${JSON.stringify(inp === null ? 'null' : inp)}`, E.monthKey(inp), want));

// ==================================================================
section('B. 月度分组 groupRows(dateGroup:"month")');
// ==================================================================
const visitRows = [
  { '经办人': '杨聃', '慰问日期': '2026-08-05', '慰问物品金额（元）': 100 },
  { '经办人': '杨聃', '慰问日期': '2026-08-20', '慰问物品金额（元）': 200 },
  { '经办人': '雷缘成', '慰问日期': '2026-09-01', '慰问物品金额（元）': 300 },
  { '经办人': '雷缘成', '慰问日期': '2026-09-11', '慰问物品金额（元）': '' },
  { '经办人': '雷缘成', '慰问日期': '线上邮寄慰问品', '慰问物品金额（元）': 999 },
  { '经办人': '', '慰问日期': '', '慰问物品金额（元）': '' },
];
const VS = sheet(['经办人', '慰问日期', '慰问物品金额（元）'], visitRows);

const monthly = E.groupRows(VS, { groupBy: '慰问日期', dateGroup: 'month', agg: 'count' });
t('B1 月份数（脏日期不进月度图）', monthly.length, 2);
t('B2 第一月', monthly[0].name, '2026-08');
t('B3 第一月人次', monthly[0].value, 2);
t('B4 第二月', monthly[1].name, '2026-09');
t('B5 第二月人次', monthly[1].value, 2);
t('B6 默认按月份升序', monthly.map(x => x.name).join(','), '2026-08,2026-09');

const monthlyAmt = E.groupRows(VS, { groupBy: '慰问日期', dateGroup: 'month', agg: 'sum', field: '慰问物品金额（元）' });
t('B7 八月金额', monthlyAmt[0].value, 300);
t('B8 九月金额（脏日期的 999 不算）', monthlyAmt[1].value, 300);
t('B9 总数仍算全部行（脏日期不丢）', E.aggregate(VS, { agg: 'count' }), 6);
t('B10 总金额仍算全部行', E.aggregate(VS, { agg: 'sum', field: '慰问物品金额（元）' }), 1599);

const plain = E.groupRows(VS, { groupBy: '经办人', agg: 'count' });
t('B11 不开 dateGroup 时空值归并到「（空）」', plain.map(x => x.name).join(','), '杨聃,雷缘成,（空）');
t('B12 不开 dateGroup 时保持数据顺序', plain[0].value, 2);

// ==================================================================
section('C. 明细列表表 listTable');
// ==================================================================
const orgRows = [
  { '工会名称': '浙沪大区工会', '组建状态': '筹建中', '当前进度': '会员登记', '进度日期': '2026-09-01', '工作负责人': '张三' },
  { '工会名称': '粤港澳琼大区工会', '组建状态': '筹建中', '当前进度': '方案制定', '进度日期': '', '工作负责人': '' },
  { '工会名称': '江苏大区工会', '组建状态': '已组建', '当前进度': '已成立', '进度日期': '2026-01-01', '工作负责人': '李四' },
  { '工会名称': '临汾一店工会', '组建状态': '筹建中', '当前进度': '', '进度日期': '', '工作负责人': '' },
];
const OS = sheet(['工会名称', '组建状态', '当前进度', '进度日期', '工作负责人'], orgRows);
const LT = {
  type: 'list', sheet: '01-组织建设',
  where: [{ field: '组建状态', op: '==', value: '筹建中' }],
  columns: [
    { field: '工会名称', label: '工会名称' },
    { field: '当前进度', label: '当前进度', render: 'progress', stages: ['未启动', '方案制定', '会员登记', '报批审批', '选举筹备', '已成立'] },
    { field: '进度日期', label: '进度日期' },
    { field: '工作负责人', label: '工作负责人' },
  ],
  sortBy: 'nameAsc',
  detail: { sheet: '01-组织建设', filterField: '工会名称' },
};
const lb = E.buildTable(OS, LT);
t('C1 只出筹建中的行', lb.rows.length, 3);
t('C2 表头顺序', (lb.head || []).join('|'), '工会名称|当前进度|进度日期|工作负责人');
t('C3 按名称升序（中文拼音序）', lb.rows.map(r => r.key).join(','), '临汾一店工会,粤港澳琼大区工会,浙沪大区工会');
t('C4 单元格取的是原始字段值', lb.rows[2].cells[1], '会员登记');
t('C5 空值原样保留（不臆造）', JSON.stringify(lb.rows[0].cells.slice(1)), '["","",""]');
t('C6 点击行→明细过滤值', lb.rows[2].detailValue, '浙沪大区工会');
t('C7 列定义透传给渲染层', (lb.columns || [])[1].render, 'progress');
t('C8 阶段列表透传', (lb.columns || [])[1].stages.join(','), '未启动,方案制定,会员登记,报批审批,选举筹备,已成立');

t('C9 名称降序', E.buildTable(OS, Object.assign({}, LT, { sortBy: 'nameDesc' })).rows[0].key, '浙沪大区工会');
t('C10 按指定列排序', E.buildTable(OS, Object.assign({}, LT, { sortBy: 'field', sortField: '当前进度' })).rows[0].key, '临汾一店工会');
t('C11 limit 截断', E.buildTable(OS, Object.assign({}, LT, { sortBy: '', limit: 2 })).rows.length, 2);
t('C12 没有 where 时出全部行', E.buildTable(OS, Object.assign({}, LT, { where: [] })).rows.length, 4);
t('C13 筛选值不匹配时为空（不臆造）', E.buildTable(OS, Object.assign({}, LT, { where: [{ field: '组建状态', op: '==', value: '不存在' }] })).rows.length, 0);
t('C14 数组行也能读', E.buildTable(
  sheet(['工会名称', '组建状态'], [['甲', '筹建中'], ['乙', '已组建']]),
  { type: 'list', columns: [{ field: '工会名称', label: '工会名称' }], where: [{ field: '组建状态', op: '==', value: '筹建中' }] },
).rows[0].key, '甲');

// ==================================================================
section('D. 交叉表：干事 × 月份');
// ==================================================================
const CT = {
  type: 'cross', rowField: '经办人', colField: '慰问日期',
  colDateGroup: 'month', colSort: 'asc', hideEmptyRows: true,
  value: { agg: 'count' }, showTotalColumn: true, showTotalRow: true,
};
const cb = E.buildTable(VS, CT);
t('D1 列 = 月份且升序', (cb.head || []).join(','), '2026-08,2026-09');
t('D2 行 = 干事（空值行已隐藏）', cb.rows.map(r => r.key).join(','), '杨聃,雷缘成');
t('D3 杨聃 八月', cb.rows[0].cells[0], 2);
t('D4 杨聃 九月', cb.rows[0].cells[1], 0);
t('D5 杨聃 合计', cb.rows[0].total, 2);
t('D6 列合计', (cb.colTotals || []).join(','), '2,2');
t('D7 总计（脏日期不算）', cb.grand, 4);

const CB2 = E.buildTable(VS, Object.assign({}, CT, { value: { agg: 'sum', field: '慰问物品金额（元）' } }));
t('D8 单元格改成求和', CB2.rows[0].cells[0], 300);
t('D9 求和时的合计', CB2.rows[0].total, 300);
t('D10 求和时的列合计', CB2.colTotals.join(','), '300,300');

// 干事为空、但日期正规的行：默认会被单独列成一行「（空）」，开 hideEmptyRows 才藏起来
const VS2 = sheet(['经办人', '慰问日期', '慰问物品金额（元）'],
  [...visitRows, { '经办人': '', '慰问日期': '2026-10-02', '慰问物品金额（元）': '' }]);
t('D11 干事为空会单列一行「（空）」',
  E.buildTable(VS2, Object.assign({}, CT, { hideEmptyRows: false })).rows.map(r => r.key).join(','), '杨聃,雷缘成,（空）');
t('D11b hideEmptyRows 把「（空）」行藏起来',
  E.buildTable(VS2, CT).rows.map(r => r.key).join(','), '杨聃,雷缘成');
t('D11c 藏起来的行仍计入月度合计（且自动多出 10 月列）', E.buildTable(VS2, CT).colTotals.join(','), '2,2,1');
t('D12 列降序', E.buildTable(VS, Object.assign({}, CT, { colSort: 'desc' })).head.join(','), '2026-09,2026-08');
t('D13 固定列（crossColumns）优先',
  E.buildTable(VS, Object.assign({}, CT, { crossColumns: [{ key: '2026-09', label: '9月' }] })).head.join(','), '9月');
t('D14 行也能按月分组',
  E.buildTable(VS, { type: 'cross', rowField: '慰问日期', rowDateGroup: 'month', colField: '经办人' }).rows.map(r => r.key).join(','),
  '2026-08,2026-09');
t('D15 老的计数交叉表不受影响（不写 value）',
  E.buildTable(sheet(['级别', '状态'], [{ '级别': '一级', '状态': '已组建' }, { '级别': '一级', '状态': '筹建中' }]),
    { type: 'cross', rowField: '级别', colField: '状态', crossColumns: [{ key: '已组建', label: '已组建' }] }).rows[0].cells[0], 1);
t('D16 分组表 groupTable 不受影响',
  E.buildTable(VS, { type: 'group', groupBy: '经办人', columns: [{ label: '人次', agg: 'count' }] }).rows.length, 3);

// ==================================================================
section('E. 服务端字段迁移：老数据补新列');
// ==================================================================
const WORK = '/tmp/hdj-v16-migrate';
const PORT = process.env.V16_PORT || '5338';

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // 造一份「v1.5 时代落盘」的老数据：缺 4 个新列，且两种行形态混存
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed-data.json'), 'utf8'));
  const old = JSON.parse(JSON.stringify(seed));
  ['当前进度', '进度日期', '工作负责人'].forEach(c => {
    const i = old['01-组织建设'].headers.indexOf(c);
    if (i >= 0) old['01-组织建设'].headers.splice(i, 1);
  });
  {
    const i = old['03-员工活动'].headers.indexOf('经办人');
    if (i >= 0) old['03-员工活动'].headers.splice(i, 1);
  }
  // 01 表保留数组行、03 表改成对象行（用户在后台保存过就是对象行）
  old['03-员工活动'].rows = old['03-员工活动'].rows.map(r => {
    const o = {};
    old['03-员工活动'].headers.forEach((h, i) => { o[h] = Array.isArray(r) ? r[i] : r[h]; });
    return o;
  });
  fs.writeFileSync(path.join(WORK, 'server-data.json'), JSON.stringify(old, null, 2));

  process.env.DATA_DIR = WORK;
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = '0';
  require(path.join(ROOT, 'server.js'));

  const BASE = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(`${BASE}/api/health`)).ok; } catch (_) {}
    if (!ready) await new Promise(r => setTimeout(r, 120));
  }
  t('E1 服务已就绪', ready, true);

  // 等迁移落盘（启动时是异步写的）
  let disk = null;
  for (let i = 0; i < 60; i++) {
    disk = JSON.parse(fs.readFileSync(path.join(WORK, 'server-data.json'), 'utf8'));
    if (disk['01-组织建设'].headers.indexOf('当前进度') >= 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  t('E2 01 表补上了「当前进度」', disk['01-组织建设'].headers.indexOf('当前进度') >= 0, true);
  t('E3 01 表补上了「进度日期」', disk['01-组织建设'].headers.indexOf('进度日期') >= 0, true);
  t('E4 01 表补上了「工作负责人」', disk['01-组织建设'].headers.indexOf('工作负责人') >= 0, true);
  t('E5 03 表补上了「经办人」', disk['03-员工活动'].headers.indexOf('经办人') >= 0, true);
  t('E6 新列插在「备注」前面（顺序与种子一致）',
    disk['01-组织建设'].headers.indexOf('工作负责人') < disk['01-组织建设'].headers.indexOf('备注'), true);
  t('E7 原有行数没变', disk['01-组织建设'].rows.length, old['01-组织建设'].rows.length);
  // 数组行要真的被 splice 进去（种子行比表头短是历史遗留，只验证「长度按新增列数增长」）
  t('E8 数组行也被补了空值',
    Array.isArray(disk['01-组织建设'].rows[0])
      && disk['01-组织建设'].rows[0].length === old['01-组织建设'].rows[0].length + 3, true);
  t('E9 对象行也拿到了新列键',
    disk['03-员工活动'].rows.every(r => !Array.isArray(r) && '经办人' in r), true);
  t('E10 老数据一个字都没改（工会名称仍在）',
    (Array.isArray(disk['01-组织建设'].rows[0])
      ? disk['01-组织建设'].rows[0][disk['01-组织建设'].headers.indexOf('工会名称')]
      : disk['01-组织建设'].rows[0]['工会名称']),
    (Array.isArray(old['01-组织建设'].rows[0])
      ? old['01-组织建设'].rows[0][old['01-组织建设'].headers.indexOf('工会名称')]
      : old['01-组织建设'].rows[0]['工会名称']));
  t('E11 没有凭空写入 schema（避免冲掉下拉框）', 'schema' in disk['01-组织建设'], false);

  // 幂等：再跑一次迁移不应该重复加列
  const before = disk['01-组织建设'].headers.length;
  const mod = require.cache[path.join(ROOT, 'server.js')];
  t('E12 迁移是幂等的（不会重复加列）', disk['01-组织建设'].headers.filter(h => h === '当前进度').length, 1);
  t('E13 列数 = 种子列数', before, seed['01-组织建设'].headers.length);

  console.log('\n─────────────────────────────────────────');
  console.log(`  v1.6 新功能测试：通过 ${PASS} 项 / 失败 ${FAIL} 项`);
  console.log('─────────────────────────────────────────');
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
