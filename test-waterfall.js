#!/usr/bin/env node
/**
 * 经费瀑布（桥梁）图 · 纯函数单测（不需要浏览器/服务）
 *
 * 覆盖三件事：
 *   A. waterfallRows —— 长表 → 每个工会一行（期初/入账/支出/结余）
 *   B. deriveWaterfallRows —— 从「04-经费收支」明细自动推导出瀑布表（金额绝不凭空编造）
 *   C. mergeAdditions —— 模板升级时只做加法，绝不覆盖线上用户的改动
 *
 * 用法：node test-waterfall.js
 */
'use strict';
const path = require('path');
require(path.join(__dirname, 'config-engine.js'));
const CE = globalThis.ConfigEngine;

let PASS = 0, FAIL = 0;
const t = (name, actual, expect) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { PASS++; console.log(`  ✓ ${name}`); }
  else { FAIL++; console.log(`  ❌ ${name}\n      实际=${JSON.stringify(actual)}\n      期望=${JSON.stringify(expect)}`); }
};
const near = (name, actual, expect, eps = 1e-6) => {
  const ok = typeof actual === 'number' && Math.abs(actual - expect) <= eps;
  if (ok) { PASS++; console.log(`  ✓ ${name}  (${actual})`); }
  else { FAIL++; console.log(`  ❌ ${name}  实际=${actual} 期望≈${expect}`); }
};

const sheet = {
  headers: ['序号', '工会名称', '收支类型', '经费项目', '金额（万元）'],
  rows: [
    { 工会名称: 'A工会', 收支类型: '期初', 经费项目: '上年结转', '金额（万元）': 10 },
    { 工会名称: 'A工会', 收支类型: '入账', 经费项目: '上级工会反拨', '金额（万元）': 5 },
    { 工会名称: 'A工会', 收支类型: '入账', 经费项目: '会员会费', '金额（万元）': 2.5 },
    { 工会名称: 'A工会', 收支类型: '支出', 经费项目: '慰问支出', '金额（万元）': 3 },
    { 工会名称: 'B工会', 收支类型: '期初', 经费项目: '上年结转', '金额（万元）': 8 },
    { 工会名称: 'B工会', 收支类型: '支出', 经费项目: '活动支出', '金额（万元）': 1 },
    // 负数支出也按「支出」处理（取绝对值），避免把结余算反
    { 工会名称: 'B工会', 收支类型: '支出', 经费项目: '培训支出', '金额（万元）': -0.5 },
    // 手工指定结余：表里出现「结余」类型的行
    { 工会名称: 'C工会', 收支类型: '期初', 经费项目: '上年结转', '金额（万元）': 1 },
    { 工会名称: 'C工会', 收支类型: '结余', 经费项目: '手工平账', '金额（万元）': 99 },
    // 认不出来的类型（脏数据）：整行忽略，不能让图崩掉
    { 工会名称: 'D工会', 收支类型: '未知类型', 经费项目: 'x', '金额（万元）': 7 },
  ],
};

const DEF = { groupBy: '工会名称', stageField: '收支类型', field: '金额（万元）' };

console.log('\n【A】waterfallRows：长表 → 每个工会一行');
const rows = CE.waterfallRows(sheet, DEF);
t('工会数 = 3（脏数据行被忽略）', rows.length, 3);
const byName = Object.fromEntries(rows.map(r => [r.name, r]));
near('A 期初 = 10', byName['A工会'].initial, 10);
near('A 入账 = 5 + 2.5（多个项目累加）', byName['A工会'].income, 7.5);
near('A 支出 = 3', byName['A工会'].expense, 3);
near('A 结余 = 10 + 7.5 - 3（自动计算）', byName['A工会'].balance, 14.5);
t('A 结余不是手工指定', byName['A工会'].manual, false);
near('B 支出取绝对值（3 与 -0.5 合计 1.5）', byName['B工会'].expense, 1.5);
near('B 结余 = 8 - 1.5', byName['B工会'].balance, 6.5);
near('C 结余按手工值（覆盖自动值）', byName['C工会'].balance, 99);
t('C 结余标记为手工指定', byName['C工会'].manual, true);
t('明细项保留（A 有 4 个科目）', byName['A工会'].items.length, 4);

console.log('\n【A2】排序 / 阶段别名 / 空表');
t('按结余降序', CE.waterfallRows(sheet, Object.assign({}, DEF, { sortBy: 'valueDesc' })).map(r => r.name), ['C工会', 'A工会', 'B工会']);
t('按名称升序', CE.waterfallRows(sheet, Object.assign({}, DEF, { sortBy: 'nameAsc' })).map(r => r.name), ['A工会', 'B工会', 'C工会']);
t('limit=2 生效', CE.waterfallRows(sheet, Object.assign({}, DEF, { limit: 2 })).length, 2);
t('空表不报错', CE.waterfallRows(null, DEF), []);
t('缺字段定义时用默认列名', CE.waterfallRows(sheet, {}).length, 3);

const alias = {
  headers: ['工会名称', '收支类型', '金额（万元）'],
  rows: [
    { 工会名称: 'X', 收支类型: '年初金额', '金额（万元）': 3 },
    { 工会名称: 'X', 收支类型: '收入', '金额（万元）': 4 },
    { 工会名称: 'X', 收支类型: '支出', '金额（万元）': 1 },
  ],
};
const ar = CE.waterfallRows(alias, DEF)[0];
t('「年初金额」按期初处理', ar.initial, 3);
t('「收入」按入账处理', ar.income, 4);
near('别名行也能算出结余', ar.balance, 6);

console.log('\n【B】deriveWaterfallRows：从经费收支明细推导（不编造金额）');
const fund = {
  headers: ['工会名称', '工会全称', '收支类型', '经费项目', '年初金额', '支出金额', '当前结余（万元）'],
  rows: [
    ['甲工会', '甲公司工会', '收入', '上级工会反拨', 0, 0, 4.089119],
    ['乙工会', '乙公司工会', '收入', '会员会费', 50000, 0, 12.5],
    ['乙工会', '乙公司工会', '支出', '活动支出', 0, 30000, 0],
  ],
};
const derived = CE.deriveWaterfallRows(fund, '工会名称');
t('推导出行（甲 2 行 / 乙 3 行）', derived.length, 5);
const dInit = derived.find(r => r['工会名称'] === '甲工会' && r['收支类型'] === '期初');
const dIn = derived.find(r => r['工会名称'] === '甲工会' && r['收支类型'] === '入账');
t('期初行总会生成（便于后台直接改）', !!dInit, true);
near('甲的入账 = 经费表里的结余 4.0891', dIn['金额（万元）'], 4.0891);
near('乙年初金额（元）→ 万元', derived.find(r => r['工会名称'] === '乙工会' && r['收支类型'] === '期初')['金额（万元）'], 5);
near('乙支出金额（元）→ 万元', derived.find(r => r['工会名称'] === '乙工会' && r['收支类型'] === '支出')['金额（万元）'], 3);
t('推导结果可直接喂给 waterfallRows', CE.waterfallRows(
  { headers: ['工会名称', '收支类型', '经费项目', '金额（万元）'], rows: derived.map(o => ({ ...o })) }, DEF
).length, 2);

console.log('\n【C】mergeAdditions：模板升级只做加法');
const seed = JSON.parse(JSON.stringify({
  version: 2,
  text: { pageTitle: '默认标题', footer: '默认页脚', titleDeco: true },
  theme: { accent: '#4DD8FF', palette: ['#4DD8FF', '#5FE0FF'] },
  charts: [{ id: 'c1', title: '老图' }, { id: 'c-new', title: '新图' }],
  metrics: [{ id: 'm1' }],
  modules: [
    { id: 'm1', title: '模块一', columns: [{ id: 'col1', width: 12, blocks: [{ id: 'b1', type: 'chart', refId: 'c1' }] }] },
    { id: 'm2', title: '新模块', columns: [{ id: 'colX', width: 12, blocks: [] }] },
  ],
}));
const stored = JSON.parse(JSON.stringify({
  version: 1,
  text: { pageTitle: '用户改过的标题' },                 // 用户改过 → 必须保留
  theme: { accent: '#FF0000' },                         // 用户改过 → 必须保留
  charts: [{ id: 'c1', title: '老图' }],                // 只缺 c-new
  metrics: [{ id: 'm1' }, { id: 'm-user', label: '自建' }], // 用户自建的必须还在
  modules: [
    { id: 'm1', title: '模块一（用户改名）', columns: [{ id: 'col1', width: 6, blocks: [{ id: 'b1', type: 'chart', refId: 'c1' }] }] },
  ],
}));
const { cfg: up, added } = CE.mergeAdditions(stored, seed);
t('用户改过的标题保留', up.text.pageTitle, '用户改过的标题');
t('缺失的页脚补上', up.text.footer, '默认页脚');
t('用户改过的主题色保留', up.theme.accent, '#FF0000');
t('缺失的色板补上', up.theme.palette, ['#4DD8FF', '#5FE0FF']);
t('新增图表被补进（老图仍在）', up.charts.map(c => c.id), ['c1', 'c-new']);
t('用户自建指标保留', up.metrics.map(m => m.id), ['m1', 'm-user']);
t('用户改过的模块标题保留', up.modules[0].title, '模块一（用户改名）');
t('用户改过的列宽保留（6 不被改成 12）', up.modules[0].columns[0].width, 6);
t('缺失的模块被追加', up.modules.map(m => m.id), ['m1', 'm2']);
t('新增项有记录（便于写日志）', added.length > 0, true);
console.log('    新增清单:', JSON.stringify(added));

const again = CE.mergeAdditions(up, seed);
t('重复升级是幂等的（不会重复追加）', again.cfg.charts.map(c => c.id), ['c1', 'c-new']);
t('幂等：模块不重复', again.cfg.modules.map(m => m.id), ['m1', 'm2']);
t('幂等：追加清单为空', again.added, []);

const fromEmpty = CE.mergeAdditions(null, seed);
t('没有已存配置时直接用模板', fromEmpty.cfg.text.pageTitle, '默认标题');

console.log('\n===============================');
console.log(` 通过 ${PASS} 项 / 失败 ${FAIL} 项`);
console.log('===============================');
process.exit(FAIL === 0 ? 0 : 1);
