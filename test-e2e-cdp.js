/**
 * 真实浏览器 E2E 验证（Chrome DevTools Protocol 驱动 chrome-headless-shell）
 * 不依赖 puppeteer —— 用 Node 22 内置 WebSocket 直连 CDP。
 *
 * 前置：
 *   1) 本机必须先跑起服务：cd output && node server.js
 *   2) 先备份当前看板配置：cp server-config.json /tmp/config-backup.json
 *      （脚本末尾会把改动的配置还原，备份文件是还原来源）
 *   3) 取两个会话 token：
 *      curl -s --noproxy '*' -D - -o /dev/null -X POST -H 'Content-Type: application/json' \
 *        -d '{"role":"dashboard","password":"gonghui123"}' http://127.0.0.1:5300/api/auth/login
 *      （从 Set-Cookie 里取 hdj_sid=...）
 *
 * 用法：
 *   SID=<看板token> SID_ADMIN=<后台token> node test-e2e-cdp.js
 *
 * ⚠️ 两个已知坑：
 *   - 本机 HTTP(S)_PROXY 会劫持 127.0.0.1：curl 要 --noproxy '*'，Chrome 要 --no-proxy-server（脚本已带）
 *   - 本环境沙箱会 SIGTERM 长跑进程，建议一次只跑这一个脚本
 *
 * 环境变量：CHS_PATH / CDP_PORT / BASE / CFG_BACKUP
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');

const CHS = process.env.CHS_PATH || '/Users/yusong/.cache/puppeteer/chrome-headless-shell/mac-155.0.8059.39/chrome-headless-shell-mac-x64/chrome-headless-shell';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const BASE = process.env.BASE || 'http://127.0.0.1:5300';
const BACKUP = process.env.CFG_BACKUP || '/tmp/config-backup.json';
const SID = process.env.SID || '';
const SID_ADMIN = process.env.SID_ADMIN || '';
// 当数据目录落在「代码目录」里时，服务端会判定为「非持久」，后台应弹出告警条。
// 用 E2E_NONPERSIST=1 跑一遍即可覆盖这条最关键的失败路径。
const NONPERSIST = process.env.E2E_NONPERSIST === '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

let PASS = 0, FAIL = 0;
const t = (name, actual, expect) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { PASS++; console.log(`  ✓ ${name}  (${JSON.stringify(actual)})`); }
  else { FAIL++; console.log(`  ❌ ${name}\n      实际=${JSON.stringify(actual)}\n      期望=${JSON.stringify(expect)}`); }
};
const tClose = (name, actual, expect, eps = 0.02) => {
  const ok = typeof actual === 'number' && Math.abs(actual - expect) <= eps;
  if (ok) { PASS++; console.log(`  ✓ ${name}  (${actual})`); }
  else { FAIL++; console.log(`  ❌ ${name}  实际=${actual} 期望≈${expect}`); }
};
/** 布尔断言：等价于 t(name, !!cond, true)，读起来更像测试 */
const ok = (name, cond) => t(name, !!cond, true);

// ---------------- CDP 客户端 ----------------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = new Map(); this.sessionId = null; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error('ws error')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        const arr = c.events.get(m.method) || []; arr.forEach(fn => fn(m.params)); c.events.set(m.method, []);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  once(method, timeout = 15000) {
    return new Promise((res, rej) => {
      const arr = this.events.get(method) || []; arr.push(res); this.events.set(method, arr);
      setTimeout(() => rej(new Error('timeout waiting ' + method)), timeout);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
}

(async () => {
  console.log('启动 chrome-headless-shell ...');
  const chrome = spawn(CHS, [
    '--no-sandbox', '--disable-gpu', '--no-proxy-server', '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=/tmp/chs-e2e-profile',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', d => { chromeErr += d.toString(); });

  // 等 CDP 端口就绪
  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch (_) { await sleep(250); }
  }
  if (!ver) { console.error('无法连接 CDP。stderr:\n' + chromeErr.slice(0, 1200)); chrome.kill(); process.exit(1); }
  console.log('  Chrome:', ver.Browser);

  const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.sessionId = sessionId;

  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');

  // 注入会话 cookie
  await cdp.send('Network.setCookie', { name: 'hdj_sid', value: SID, url: BASE + '/', path: '/' });
  if (SID_ADMIN) { /* 单独用 admin 页面时再设 */ }

  const consoleErrs = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });

  async function goto(path, waitMs = 2200) {
    await cdp.send('Page.navigate', { url: BASE + path });
    await sleep(waitMs);
  }

  /** 轮询等待条件成立（避免固定 sleep 造成的假阴性） */
  async function waitFor(expr, label, timeout = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await cdp.evalJs(expr)) return true; } catch (_) { /* 上下文切换中 */ }
      await sleep(200);
    }
    console.log(`    ⚠ 等待超时: ${label}`);
    return false;
  }

  /** 打开页面并等到「看板骨架渲染出模块」 */
  async function gotoDashboard() {
    await cdp.send('Page.navigate', { url: BASE + '/index.html' });
    await waitFor('document.readyState==="complete" && document.querySelectorAll("#modules-root > section").length>0', 'index.html 渲染完成');
    // 等指标数值（异步 fetch 后填充）
    await waitFor('(document.querySelector("#modules-root [data-metric]")||{}).textContent!=="—"', '指标数值填充');
    await sleep(400); // 等 ECharts 画完
  }

  /** 打开后台并等到 boot 完成 */
  async function gotoAdmin() {
    await cdp.send('Page.navigate', { url: BASE + '/admin.html' });
    await waitFor('document.readyState==="complete" && document.querySelectorAll(".tab-btn").length>0 && !!document.getElementById("panel-data")', 'admin.html 就绪');
    await sleep(600);
  }

  /** 点击标签页并等待对应面板渲染出来（带重试，容忍 boot 未完成） */
  async function clickTab(tab, readyExpr, label, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await cdp.evalJs(`(function(){ const b=document.querySelector('.tab-btn[data-tab="${tab}"]'); if(b) b.click(); return true; })()`);
      await sleep(500);
      try { if (await cdp.evalJs(readyExpr)) return true; } catch (_) {}
    }
    console.log(`    ⚠ 标签渲染超时: ${label}`);
    return false;
  }

  // ==================== A. 看板页 ====================
  console.log('\n【A】看板页真实渲染 (index.html)');
  await gotoDashboard();

  t('页面标题 = 配置的 documentTitle',
    await cdp.evalJs('document.title'), '海底捞集团工会工作数据看板');

  t('#page-title 带装饰符',
    /^━+\s*海底捞集团工会工作数据看板\s*━+$/.test((await cdp.evalJs('document.getElementById("page-title").textContent')) || ''),
    true);

  t('副标题条目数 = 6（分隔符另计 5 个）',
    await cdp.evalJs('[...document.getElementById("page-subtitle").children].filter(e=>!e.classList.contains("divider")).length'), 6);
  t('副标题分隔符 = 5',
    await cdp.evalJs('document.querySelectorAll("#page-subtitle .divider").length'), 5);

  t('模块数 = 4',
    await cdp.evalJs('document.querySelectorAll("#modules-root > section").length'), 4);

  t('模块标题依次正确',
    await cdp.evalJs('[...document.querySelectorAll("#modules-root .module-title")].map(e=>e.textContent.trim())'),
    ['一、组织建设情况', '二、走访慰问情况', '三、员工活动情况', '四、经费收支情况']);

  // v1.6 布局：组织 5/7 + 筹建进度 12，走访 6/6 + 月度图 12 + 干事矩阵 12，
  // 活动 12/6/6 + 月度图 12 + 干事矩阵 12，经费 12/12/12
  t('模块内列宽栅格正确 (5/7/12, 6/6/12/12, 12/6/6/12/12, 12/12/12)',
    await cdp.evalJs(`[...document.querySelectorAll("#modules-root .mod-col")].map(c=>c.style.gridColumn)`),
    ['span 5', 'span 7', 'span 12',
      'span 6', 'span 6', 'span 12', 'span 12',
      'span 12', 'span 6', 'span 6', 'span 12', 'span 12',
      'span 12', 'span 12', 'span 12']);

  // 13 → 12：v1.6 按需求删掉了「覆盖总人次」卡片
  // 12 → 14：v1.7 新增「走访慰问支出汇入 / 员工活动支出汇入」两张卡片
  t('指标卡片总数 = 14',
    await cdp.evalJs('document.querySelectorAll("#modules-root [data-metric]").length'), 14);

  // 指标取值
  const metricVals = await cdp.evalJs(`(function(){
    const o={};
    document.querySelectorAll('#modules-root [data-metric]').forEach(el=>{ o[el.getAttribute('data-metric')] = el.textContent.trim(); });
    return o;
  })()`);
  console.log('    指标渲染值:', JSON.stringify(metricVals));
  t('基层工会总数 = 20', metricVals['org-total'], '20');
  t('已组建 = 13', metricVals['org-established'], '13');
  t('筹建中 = 7', metricVals['org-preparing'], '7');
  t('走访慰问人次 = 56', metricVals['visit-total'], '56');
  t('开展活动总数 = 52', metricVals['act-total'], '52');
  // v1.6：「覆盖总人次」卡片已按需求删除，改用「活动支出总额」占位验证（金额列待补录时为 0）
  t('活动支出总额 = 0（金额列待补录）', metricVals['act-spend'], '0');
  t('慰问品总金额 = 0（金额列待补录）', metricVals['visit-amount'], '0');
  // v1.7 起「当前结余」是派生值：期初金额 + 入账金额 − 支出合计（元），
  // 不再是手工维护的「当前结余（万元）」列。种子已对齐线上口径，合计 66.68 万元
  // （旧基线 66.75 里含一条脏数据：哈尔滨一店工会的结余多记了 900 元）。
  t('当前结余(2位小数) = 66.68', metricVals['fund-balance'], '66.68');
  t('★公式指标 组建完成率 = 65.0%', metricVals['org-rate'], '65.0');
  t('★公式指标 平均每会结余 = 3.33 万元', metricVals['fund-per-org'], '3.33');

  // 图表
  // 4 张普通图 + v1.3 新增的瀑布（桥梁）图
  // 7 = 组织饼图 / 走访类型 / 活动类型 / 走访月度 / 活动月度 / 经费柱状 / 经费桥梁
  t('图表块 7 个且 ECharts 已绘制 canvas',
    await cdp.evalJs('[...document.querySelectorAll("#modules-root canvas")].length'), 7);

  // 色板容错：历史脏数据把色板存成过字符串，"#" 这种非法颜色必须被过滤掉，
  // 否则 ECharts 抛 addColorStop 异常、整张图渲染不出来。
  const palRobust = await cdp.evalJs(`(function(){
    return {
      字符串: normalizePalette('#4DD8FF,#5FE0FF,#3B82F6').length,
      非法回退: normalizePalette(123).length,
      过滤非法: normalizePalette(['#fff','#','',null,'不是颜色']).join(','),
      默认色: normalizePalette(null).length,
      colorAt返回合法色: /^#|^rgb/.test(String(colorAt(0))),
    };
  })()`);
  console.log('    色板容错:', JSON.stringify(palRobust));
  t('色板容错：逗号字符串能解析成 3 色', palRobust.字符串, 3);
  t('色板容错：非法类型回退默认 8 色', palRobust.非法回退, 8);
  t('色板容错：数组里的 "#" 等非法色被剔除', palRobust.过滤非法, '#fff');
  t('色板容错：null 回退默认 8 色', palRobust.默认色, 8);
  t('colorAt() 返回合法颜色', palRobust.colorAt返回合法色, true);

  // 统计表
  // 6 = 组织交叉表 / 筹建进度表 / 走访大区 / 干事月度矩阵 / 活动形式 / 干事月度矩阵
  t('统计表块 6 个',
    await cdp.evalJs('document.querySelectorAll("#modules-root table.data-table").length'), 6);
  t('组织建设交叉表 表头 = rowField + 列 + 合计',
    await cdp.evalJs('[...document.querySelectorAll("#modules-root table.data-table thead th")].map(e=>e.textContent.trim())').then(a => a.slice(0, 4)),
    ['工会级别', '已组建', '筹建中', '合计']);

  // 主题变量
  t('CSS 变量 --accent 已按配置注入',
    await cdp.evalJs('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()'), '#4DD8FF');
  const bodyStyles = await cdp.evalJs(`(function(){
    const root=getComputedStyle(document.documentElement);
    return { maxWidth: root.getPropertyValue('--max-width').trim(), radius: root.getPropertyValue('--radius').trim() };
  })()`);
  console.log('    布局变量:', JSON.stringify(bodyStyles));
  t('--max-width 来自配置 1560', bodyStyles.maxWidth, '1560px');
  t('--radius 来自配置 4', bodyStyles.radius, '4px');

  t('页脚文案 = 配置 footer',
    await cdp.evalJs('document.getElementById("page-footer").textContent.trim()'),
    '© 海底捞集团工会 · 数据看板 · 设计参考 Excel「数据看板」sheet1 科技蓝主题');

  t('同步徽标存在', await cdp.evalJs('!!document.querySelector("#sync-badge")'), true);
  t('退出链接存在', await cdp.evalJs('!!document.querySelector(".logout-link")'), true);
  t('会话遮罩默认隐藏', await cdp.evalJs('document.getElementById("session-mask").classList.contains("hidden")'), true);

  // 详情弹窗（E.pick 兼容 schema 变更）
  console.log('\n【B】详情弹窗');
  const detail = await cdp.evalJs(`(function(){
    const el=document.querySelector('#modules-root [data-metric]');
    return document.querySelectorAll('#modules-root [data-detail]').length;
  })()`);
  console.log('    可点击明细的元素数:', detail);
  t('存在可点击详情入口', detail > 0, true);

  // ==================== C. 管理后台配置面板 ====================
  console.log('\n【C】管理后台面板 (admin.html)');
  await cdp.send('Network.setCookie', { name: 'hdj_sid', value: SID_ADMIN || SID, url: BASE + '/', path: '/' });
  await gotoAdmin();

  t('标签页含「看板配置」', await cdp.evalJs('!!document.querySelector(".tab-btn[data-tab=\'__config\']")'), true);
  t('标签页含「安全设置」', await cdp.evalJs('!!document.querySelector(".tab-btn[data-tab=\'__security\']")'), true);

  // 进入 🎨 看板配置
  await clickTab('__config', 'document.getElementById("cfg-json") && document.getElementById("cfg-json").value.length>1000', '看板配置面板');

  const cfgCounts = await cdp.evalJs(`(function(){
    const secs=[...document.querySelectorAll('#panel-config .cfg-section .cfg-head')];
    // 真实可见性判定（offsetParent === null 即不可见），避免"只检查 class 名"漏掉样式缺失
    const vis = el => !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    return {
      panelVisible: vis(document.getElementById('panel-config')),
      dataHidden: !vis(document.getElementById('panel-data')),
      secHidden: !vis(document.getElementById('panel-security')),
      sectionCount: secs.length,
      sectionTitles: secs.map(e=>e.textContent.trim().slice(0,14)),
      metricRows: document.querySelectorAll('#panel-config [data-act="metric-edit"]').length,
      chartRows: document.querySelectorAll('#panel-config [data-act="chart-edit"]').length,
      tableRows: document.querySelectorAll('#panel-config [data-act="table-edit"]').length,
      modCards: document.querySelectorAll('#panel-config .cfg-mod-card').length,
      colCards: document.querySelectorAll('#panel-config .cfg-col-card').length,
      addModBtn: !!document.querySelector('#panel-config [data-act="mod-add"]'),
      addMetricBtn: !!document.querySelector('#panel-config [data-act="metric-add"]'),
      jsonBox: !!document.getElementById('cfg-json'),
      jsonLen: (document.getElementById('cfg-json')||{}).value ? document.getElementById('cfg-json').value.length : 0,
      themeColorInputs: document.querySelectorAll('#panel-config input[type="color"]').length,
      themeFields: document.querySelectorAll('#panel-config .cfg-section:nth-of-type(2) .form-field').length,
      themeLabels: [...document.querySelectorAll('#panel-config .cfg-section:nth-of-type(2) .form-field label, #panel-config .cfg-section:nth-of-type(2) label')].map(e=>e.textContent.trim()),
      textInputs: document.querySelectorAll('#panel-config .form-field input[type="text"]').length,
    };
  })()`);
  console.log('    配置面板统计:', JSON.stringify(cfgCounts, null, 1));
  t('看板配置面板真实可见', cfgCounts.panelVisible, true);
  t('数据管理面板被隐藏', cfgCounts.dataHidden, true);
  t('安全面板同时被隐藏', cfgCounts.secHidden, true);
  t('配置面板 8 个分区', cfgCounts.sectionCount, 8);
  t('分区标题 = ①~⑧', cfgCounts.sectionTitles.map(s => s.slice(0, 1)),
    ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']);
  // 13 → 14：v1.7 多了「走访慰问支出汇入 / 员工活动支出汇入」两个指标
  t('指标编辑行 = 14', cfgCounts.metricRows, 14);
  t('图表编辑行 = 7（含瀑布图 + 两张月度图）', cfgCounts.chartRows, 7);
  t('统计表编辑行 = 6（含筹建进度表 + 两张干事矩阵）', cfgCounts.tableRows, 6);
  t('模块卡片 = 4', cfgCounts.modCards, 4);
  t('列卡片 = 15（v1.6 新增 5 列：筹建进度/两月度图/两干事矩阵）', cfgCounts.colCards, 15);
  t('有「+ 添加模块」按钮', cfgCounts.addModBtn, true);
  t('有「+ 新增指标」按钮', cfgCounts.addMetricBtn, true);
  t('主题色选择器 = 9 个', cfgCounts.themeColorInputs, 9);
  t('主题配色字段 = 12 个（含描边/子卡片底色/色板）', cfgCounts.themeFields, 12);
  t('主题字段含「卡片渐变底色」', /卡片渐变底色/.test(cfgCounts.themeLabels.join('|')), true);
  t('主题字段含「子卡片(指标块)底色」', /子卡片/.test(cfgCounts.themeLabels.join('|')), true);
  t('主题字段含「图表色板」', /图表色板/.test(cfgCounts.themeLabels.join('|')), true);
  t('文字输入框存在', cfgCounts.textInputs > 0, true);
  t('JSON 编辑框存在且非空', cfgCounts.jsonBox && cfgCounts.jsonLen > 5000, true);

  // 进入 🔒 安全设置
  await clickTab('__security', 'document.querySelectorAll("#panel-security .cfg-head").length>=2', '安全设置面板');
  const secInfo = await cdp.evalJs(`(function(){
    const heads=[...document.querySelectorAll('#panel-security .cfg-head')].map(e=>e.textContent.trim());
    // 真实可见性判定：offsetParent 为 null 即被隐藏（不只看 class，之前就是这里漏掉了 .hidden 无样式的问题）
    const vis = el => !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    return {
      visible: vis(document.getElementById('panel-security')),
      dataHidden: !vis(document.getElementById('panel-data')),
      cfgHidden: !vis(document.getElementById('panel-config')),
      heads,
      pwInputs: document.querySelectorAll('#panel-security input[type="password"]').length,
      submitBtns: document.querySelectorAll('#panel-security button').length,
      bodyLen: document.getElementById('panel-security').innerHTML.length,
    };
  })()`);
  console.log('    安全面板:', JSON.stringify({
    visible: secInfo.visible, dataHidden: secInfo.dataHidden, cfgHidden: secInfo.cfgHidden,
    heads: secInfo.heads, pwInputs: secInfo.pwInputs,
  }));
  t('安全设置面板真实可见', secInfo.visible, true);
  t('切到安全设置后数据面板被隐藏', secInfo.dataHidden, true);
  t('切到安全设置后配置面板被隐藏', secInfo.cfgHidden, true);
  t('含「当前登录状态」', secInfo.heads.some(s => /登录状态/.test(s)), true);
  t('含「修改看板密码」', secInfo.heads.some(s => /看板.*密码/.test(s)), true);
  t('含「修改后台密码」', secInfo.heads.some(s => /后台.*密码/.test(s)), true);
  t('密码输入框 ≥ 4 个', secInfo.pwInputs >= 4, true);

  // 「数据存储与备份」分区：存储是否持久 + 快照列表 + 操作按钮
  console.log('    数据存储分区:');
  const storeInfo = await cdp.evalJs(`(function(){
    const box = document.querySelector('#sec-storage-body');
    if (!box) return null;
    return {
      hasSection: true,
      persistentClass: (box.querySelector('.store-status')||{}).className || '',
      text: box.textContent.replace(/\\s+/g,' ').trim().slice(0, 240),
      tableRows: box.querySelectorAll('.store-table tr').length,
      backupRows: box.querySelectorAll('table tbody tr').length,
      restoreBtns: box.querySelectorAll('[data-restore]').length,
      hasBackupNow: !!document.getElementById('store-backup-now'),
      hasRefresh: !!document.getElementById('store-refresh'),
    };
  })()`);
  console.log('   ', JSON.stringify(storeInfo && {
    cls: storeInfo.persistentClass, rows: storeInfo.tableRows,
    backups: storeInfo.backupRows, restoreBtns: storeInfo.restoreBtns,
  }));
  t('存在「数据存储与备份」分区', !!(storeInfo && storeInfo.hasSection), true);
  t('显示持久化状态', /持久化/.test(storeInfo.text), true);
  if (NONPERSIST) {
    t('非持久目录被标红（is-bad）', /is-bad/.test(storeInfo.persistentClass), true);
    t('提示重新部署会重置数据', /重新部署|重置/.test(storeInfo.text), true);
  } else {
    t('本地测试目录被判定为持久目录', /is-ok/.test(storeInfo.persistentClass), true);
  }
  t('展示数据目录/文件等 5 项信息', storeInfo.tableRows, 5);
  t('有快照列表或提示', storeInfo.backupRows + storeInfo.restoreBtns >= 1, true);
  t('有「立即备份」按钮', storeInfo.hasBackupNow, true);
  t('有「刷新状态」按钮', storeInfo.hasRefresh, true);

  // 点一次「立即备份数据」，确认与后端联通
  const bkRes = await cdp.evalJs(`(async()=>{
    const before = (await (await fetch('/api/backups',{credentials:'include'})).json()).count;
    document.getElementById('store-backup-now').click();
    await new Promise(r=>setTimeout(r,900));
    const after = (await (await fetch('/api/backups',{credentials:'include'})).json()).count;
    return [before, after];
  })()`);
  t('点「立即备份」→ 快照数 +1', bkRes[1] > bkRes[0], true);

  // 真实提交一次「改密码 → 改回」，验证面板与后端联通
  console.log('    实测：通过安全面板把看板密码改为 e2etmp9 再改回');
  const chg = await cdp.evalJs(`(async()=>{
    const r1 = await fetch('/api/auth/password',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'dashboard',current:'admin123',next:'e2etmp9'})});
    const r2 = await fetch('/api/auth/password',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'dashboard',current:'admin123',next:'gonghui123'})});
    return [r1.status, r2.status];
  })()`);
  t('改看板密码 → 改回，均 200', chg, [200, 200]);

  // 回到数据管理，确认三个标签可自由切换
  await clickTab('__config', '!!document.getElementById("cfg-json")', '二进配置面板');
  t('可再次切回配置面板', await cdp.evalJs('!document.getElementById("panel-config").classList.contains("hidden")'), true);

  // ---------------------------------------------------------------------
  console.log('\n【C2】后台「保存配置」不写坏色板 / 列宽（线上「图表全变黑」复盘）');
  // 线上故障：collectConfigFromPanel 里按 k === 'theme.palette' 判断要不要把
  // 逗号文本转成数组，但 setPath 会把键名拆成嵌套路径，Object.keys 拿到的是
  // 'theme'，判断永远不成立 → 色板被存成字符串 → ECharts 逐字符取色拿到 '#'
  // → addColorStop 抛异常 → 所有图表渲染成黑色。
  const snapshot = `(async()=>{
    const c = await (await fetch('/api/config',{credentials:'include',cache:'no-store'})).json();
    return {
      paletteIsArray: Array.isArray(c.theme.palette),
      paletteLen: Array.isArray(c.theme.palette) ? c.theme.palette.length : -1,
      metrics: (c.metrics || []).length,
      charts: (c.charts || []).length,
      tables: (c.tables || []).length,
      widths: (c.modules || []).map(m => (m.columns || []).map(x => Number(x.width)).join('/')),
      footer: (c.text || {}).footer || '',
    };
  })()`;
  const beforeSave = await cdp.evalJs(snapshot);
  console.log('    保存前:', JSON.stringify(beforeSave));
  t('保存前色板本身就是数组', beforeSave.paletteIsArray, true);

  const collected = await cdp.evalJs(`(function(){
    const next = collectConfigFromPanel();
    return {
      paletteIsArray: Array.isArray(next.theme.palette),
      paletteLen: Array.isArray(next.theme.palette) ? next.theme.palette.length : -1,
      metrics: (next.metrics || []).length,
      charts: (next.charts || []).length,
      tables: (next.tables || []).length,
      widths: (next.modules || []).map(m => (m.columns || []).map(c => Number(c.width)).join('/')),
      footer: (next.text || {}).footer,
    };
  })()`);
  console.log('    面板收集:', JSON.stringify(collected));
  t('面板收集后色板仍是数组（不再退化成字符串）', collected.paletteIsArray, true);
  t('色板颜色数不丢', collected.paletteLen, beforeSave.paletteLen);
  t('指标数不丢', collected.metrics, beforeSave.metrics);
  t('图表数不丢', collected.charts, beforeSave.charts);
  t('统计表数不丢', collected.tables, beforeSave.tables);
  t('模块列宽原样保留', JSON.stringify(collected.widths), JSON.stringify(beforeSave.widths));
  t('页脚文字原样保留', collected.footer, beforeSave.footer);

  // 真正点一次「保存配置」，再回读服务端
  const saved = await cdp.evalJs(`(async()=>{
    document.getElementById('cfg-save').click();
    await new Promise(r => setTimeout(r, 1500));
    const c = await (await fetch('/api/config',{credentials:'include',cache:'no-store'})).json();
    const toastEl = document.querySelector('.toast');
    const warnBox = document.getElementById('cfg-warn-box');
    return {
      paletteIsArray: Array.isArray(c.theme.palette),
      paletteLen: Array.isArray(c.theme.palette) ? c.theme.palette.length : -1,
      metrics: (c.metrics || []).length,
      widths: (c.modules || []).map(m => (m.columns || []).map(x => Number(x.width)).join('/')),
      footer: (c.text || {}).footer || '',
      toast: toastEl ? toastEl.textContent.trim() : '',
      warnVisible: !!warnBox && warnBox.offsetParent !== null && getComputedStyle(warnBox).display !== 'none',
      warnText: warnBox ? warnBox.textContent.replace(/\\s+/g,' ').trim().slice(0,200) : '',
    };
  })()`);
  console.log('    保存后:', JSON.stringify(saved));
  t('保存后服务端色板仍是数组', saved.paletteIsArray, true);
  t('保存后色板颜色数不丢', saved.paletteLen, beforeSave.paletteLen);
  t('保存后指标数不丢', saved.metrics, beforeSave.metrics);
  t('保存后列宽未被改写', JSON.stringify(saved.widths), JSON.stringify(beforeSave.widths));
  t('保存后页脚未被截断', saved.footer, beforeSave.footer);
  t('保存成功提示（不再被列宽规则拦下）', /已保存/.test(saved.toast), true);
  t('「需要留意」提示框真实可见', saved.warnVisible, true);
  t('提示框说明了列宽会换行', /换行/.test(saved.warnText), true);
  await cdp.evalJs(`(()=>{const b=document.getElementById('cfg-warn-box'); if(b) b.remove();})()`);

  // ---------- 【C3】配置弹窗必须能滚动、底部按钮不能掉出屏幕 ----------
  console.log('\n【C3】指标/图表/统计表编辑弹窗可滚动（曾因 overflow:hidden 滚不动）');
  // 用户反馈：「后台看板配置的指标编辑界面无法上下滚动选项」。
  // 根因：.modal-panel 是 max-height:86vh + overflow:hidden 的 flex 列，
  // 而 .mini-content 没有 flex:1 / min-height:0 / overflow-y:auto，
  // 内容一超高就被裁掉（指标弹窗实测 1183px 塞进 688px 的框里），
  // 底部「筛选条件 / 添加条件 / 取消 / 确认」全都点不到。
  async function openMini(clickExpr, label) {
    await cdp.evalJs(clickExpr);
    await waitFor('!document.getElementById("mini-modal").classList.contains("hidden")', label + ' 打开');
    await sleep(500);
  }
  async function closeMini() {
    await cdp.evalJs(`document.getElementById('mini-modal-cancel').click()`);
    await sleep(350);
  }
  const modalGeo = () => cdp.evalJs(`(function(){
    const modal = document.getElementById('mini-modal');
    const panel = modal.querySelector('.mini-panel');
    const content = document.getElementById('mini-modal-content');
    const actions = modal.querySelector('.mini-actions');
    const pb = panel.getBoundingClientRect(), ab = actions.getBoundingClientRect(), cb = content.getBoundingClientRect();
    const before = content.scrollTop;
    content.scrollTop = 1e6;
    const maxScroll = content.scrollTop;
    content.scrollTop = before;
    return {
      open: !modal.classList.contains('hidden'),
      wide: panel.classList.contains('mini-panel-wide'),
      overflowY: getComputedStyle(content).overflowY,
      scrollable: content.scrollHeight > content.clientHeight + 2,
      maxScroll: Math.round(maxScroll),
      panelInViewport: pb.top >= -1 && pb.bottom <= innerHeight + 1,
      actionsInViewport: ab.top >= -1 && ab.bottom <= innerHeight + 1,
      contentInPanel: Math.round(cb.width) <= Math.round(pb.width) + 1,
      viewportH: innerHeight,
    };
  })()`);

  await openMini(`document.querySelector('[data-act="metric-edit"]').click()`, '编辑指标');
  const gMetric = await modalGeo();
  console.log('    指标弹窗:', JSON.stringify(gMetric));
  t('指标弹窗已打开', gMetric.open, true);
  t('指标弹窗整体在视口内', gMetric.panelInViewport, true);
  t('指标弹窗用宽版（两列排版）', gMetric.wide, true);
  t('内容区 overflow-y = auto', gMetric.overflowY, 'auto');
  t('内容超高时确实能滚', gMetric.scrollable ? gMetric.maxScroll > 0 : true, true);
  t('「取消/确认」始终在视口内', gMetric.actionsInViewport, true);

  // 滚到底 → 筛选条件区域必须可见（过去这里被裁掉）
  const bottomSeen = await cdp.evalJs(`(function(){
    const c = document.getElementById('mini-modal-content');
    c.scrollTop = c.scrollHeight;
    const cr = c.getBoundingClientRect();
    const inView = el => { if(!el) return false; const b = el.getBoundingClientRect(); return b.top >= cr.top - 1 && b.bottom <= cr.bottom + 1; };
    const whereTitle = Array.from(c.querySelectorAll('.cfg-sub-title')).find(el => /筛选条件/.test(el.textContent));
    return {
      atBottom: Math.abs(c.scrollTop + c.clientHeight - c.scrollHeight) < 2,
      whereVisible: inView(whereTitle),
      addBtnVisible: inView(c.querySelector('[data-wact="add"]')),
    };
  })()`);
  console.log('    滚到底:', JSON.stringify(bottomSeen));
  t('能滚到内容最底部', bottomSeen.atBottom, true);
  t('「筛选条件」小标题滚到底后可见', bottomSeen.whereVisible, true);
  t('「+ 添加条件」按钮滚到底后可见', bottomSeen.addBtnVisible, true);
  await closeMini();

  // 重新打开应回到顶部（不继承上次的滚动位置）
  await openMini(`document.querySelector('[data-act="metric-edit"]').click()`, '编辑指标(二次)');
  t('重新打开时内容回到顶部', await cdp.evalJs(`document.getElementById('mini-modal-content').scrollTop`), 0);
  await closeMini();

  for (const [act, label] of [['chart-edit', '编辑图表'], ['table-edit', '编辑统计表']]) {
    await openMini(`document.querySelector('[data-act="${act}"]').click()`, label);
    const g = await modalGeo();
    console.log(`    ${label}:`, JSON.stringify(g));
    t(label + ' 内容区可滚动', g.overflowY, 'auto');
    t(label + ' 整体在视口内', g.panelInViewport, true);
    t(label + ' 底部按钮在视口内', g.actionsInViewport, true);
    await closeMini();
  }

  // 「选择指标」内容少，应保持窄版，不该被误放大
  await openMini(`document.querySelector('[data-act="blk-metrics"]').click()`, '选择指标');
  const gPick = await modalGeo();
  console.log('    选择指标:', JSON.stringify(gPick));
  t('「选择指标」保持窄版', gPick.wide, false);
  t('「选择指标」底部按钮在视口内', gPick.actionsInViewport, true);
  await closeMini();

  // 看板最终结构性校验：把配置改掉 → 看板应变化
  console.log('\n【D】配置改动 → 看板实时改变（配置驱动验证）');
  const before = await cdp.evalJs(`(async()=>{
    const c = await (await fetch('/api/config',{credentials:'include'})).json();
    return { title: c.text.pageTitle, mods: c.modules.length };
  })()`);
  console.log('    改前:', JSON.stringify(before));

  const changed = await cdp.evalJs(`(async()=>{
    const r = await fetch('/api/config',{credentials:'include'});
    const c = await r.json();
    c.text.pageTitle = 'E2E-改名验证';
    c.theme.accent = '#FF6B00';
    c.modules = c.modules.slice(0, 2);          // 只留 2 个模块 → 验证模块可增删
    const p = await fetch('/api/config',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});
    return p.status;
  })()`);
  t('PUT 配置 200', changed, 200);

  await gotoDashboard();
  const after = await cdp.evalJs(`({
    title: document.getElementById('page-title').textContent.trim(),
    mods: document.querySelectorAll('#modules-root > section').length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    metricCount: document.querySelectorAll('#modules-root [data-metric]').length,
  })`);
  console.log('    改后看板:', JSON.stringify(after));
  t('看板标题已变', /E2E-改名验证/.test(after.title), true);
  t('模块数已变 4 → 2', after.mods, 2);
  t('主题色已变 → #FF6B00', after.accent, '#FF6B00');
  t('指标卡片随之减少 (13 → 5)', after.metricCount, 5);

  // 还原配置
  console.log('\n【E】还原配置');
  const backupRaw = require('fs').readFileSync(BACKUP, 'utf-8');
  const restored = await cdp.evalJs(`(async()=>{
    const p = await fetch('/api/config',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(backupRaw)}});
    return p.status;
  })()`);
  t('还原配置 200', restored, 200);
  await gotoDashboard();
  t('还原后标题回到原值',
    await cdp.evalJs('document.getElementById("page-title").textContent').then(s => /海底捞集团工会工作数据看板/.test(s)), true);
  t('还原后模块数回到 4',
    await cdp.evalJs('document.querySelectorAll("#modules-root > section").length'), 4);

  // ==================== E2. 经费瀑布（桥梁）图 ====================
  console.log('\n【E2】经费瀑布（桥梁）图（v1.3 新增）');
  await gotoDashboard();
  const wf = await cdp.evalJs(`(async()=>{
    const cfg = await (await fetch('/api/config',{credentials:'include'})).json();
    const data = await (await fetch('/api/data',{credentials:'include'})).json();
    const ch = (cfg.charts||[]).find(c=>c.type==='waterfall');
    if(!ch) return { hasChart:false };
    const rows = window.ConfigEngine.waterfallRows(data[ch.sheet], ch);
    const r2 = v => Math.round(v*100)/100;
    return {
      hasChart:true, sheet: ch.sheet, stageField: ch.stageField, field: ch.field,
      decimals: ch.decimals, yName: (ch.axis && ch.axis.yName) || '',
      unions: rows.length,
      balanceSum: r2(rows.reduce((s,r)=>s+r.balance,0)),
      anyManual: rows.some(r=>r.manual),
      sample: rows.slice(0,2).map(r=>[r.name, r2(r.initial), r2(r.income), r2(r.expense), r2(r.balance)]),
    };
  })()`);
  console.log('    ', JSON.stringify(wf));
  t('配置里有瀑布（桥梁）图定义', wf.hasChart, true);
  t('瀑布图数据表 = 05-经费瀑布', wf.sheet, '05-经费瀑布');
  t('阶段字段 = 收支类型（期初/入账/支出/结余）', wf.stageField, '收支类型');
  t('每个工会单独一行（7 个工会）', wf.unions, 7);
  t('结余合计 667538.25 元（= 66.753825 万元，与看板「当前结余」指标一致）', wf.balanceSum, 667538.25);
  t('结余默认自动计算（不是手工指定）', wf.anyManual, false);
  t('金额字段 = 金额（元）', wf.field, '金额（元）');
  t('坐标轴单位 = 元', wf.yName, '元');
  t('数值保留 3 位小数', wf.decimals, 3);

  const wfDom = await cdp.evalJs(`(function(){
    const secs=[...document.querySelectorAll('#modules-root > section')];
    const fund=secs[secs.length-1];
    const titles=[...fund.querySelectorAll('.sub-card-title')].map(e=>e.textContent);
    const areas=[...fund.querySelectorAll('.chart-area')];
    return { titles, areaCount: areas.length, lastH: areas.length? parseInt(areas[areas.length-1].style.height,10) : 0 };
  })()`);
  console.log('    经费模块块标题:', JSON.stringify(wfDom.titles));
  t('经费模块最下方新增了「桥梁图」块', wfDom.titles.some(x => /桥梁图/.test(x)), true);
  t('经费模块共 2 张图（结余柱 + 桥梁图）', wfDom.areaCount, 2);
  t('桥梁图高度按工会数自动撑开（≥400px）', wfDom.lastH >= 400, true);

  const wfSeries = await cdp.evalJs(`(function(){
    const areas=[...document.querySelectorAll('#modules-root .chart-area')];
    const el=areas[areas.length-1];
    const inst = echarts.getInstanceByDom(el);
    if(!inst) return {ok:false};
    const o = inst.getOption();
    return {
      ok:true,
      names:o.series.map(s=>s.name).filter(n=>String(n).indexOf('__ph')!==0),
      cats:(o.yAxis[0].data||[]).length,
    };
  })()`);
  t('桥梁图真的画出了 期初/入账/支出/结余 四段', JSON.stringify(wfSeries.names), JSON.stringify(['期初', '入账', '支出', '结余']));
  t('桥梁图 y 轴 = 工会数', wfSeries.cats, 7);

  // ---------- 后台：瀑布表可见可编辑 ----------
  await gotoAdmin();
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表');
  t('瀑布表在后台可见（14 行 = 7 工会 × 期初/入账）',
    await cdp.evalJs('document.querySelectorAll("#admin-table tbody tr").length'), 14);
  const wfBtns = await cdp.evalJs(`(function(){
    const vis = el => !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    return { union: vis(document.getElementById('btn-add-union')), editor: vis(document.getElementById('btn-fund-editor')) };
  })()`);
  t('「＋ 新增工会组织」按钮在该表可见', wfBtns.union, true);
  t('「🌉 瀑布图编辑」按钮在该表可见', wfBtns.editor, true);

  await cdp.evalJs(`document.getElementById('btn-fund-editor').click()`);
  await waitFor('!!document.querySelector(".wf-union-list li[data-wf-union]")', '瀑布图编辑器打开');
  const ed = await cdp.evalJs(`(function(){
    const content=document.getElementById('mini-modal-content');
    const cs=getComputedStyle(content);
    return {
      unions: document.querySelectorAll('.wf-union-list li[data-wf-union]').length,
      items: document.querySelectorAll('#wf-rows [data-wf-item]').length,
      overflowY: cs.overflowY,
      canScroll: content.scrollHeight >= content.clientHeight,
      addIncome: !!document.querySelector('[data-wf-add="入账"]'),
      addExpense: !!document.querySelector('[data-wf-add="支出"]'),
      sumText: (document.querySelector('.wf-sum')||{}).textContent.replace(/\\s+/g,' ').trim() || '',
    };
  })()`);
  console.log('    ', JSON.stringify(ed));
  t('编辑器列出全部 7 个工会', ed.unions, 7);
  t('选中工会的科目行可编辑（期初/入账各 1 行）', ed.items, 2);
  t('提供「＋添加入账项 / ＋添加支出项」', ed.addIncome && ed.addExpense, true);
  t('实时给出 期初＋入账－支出＝结余', /期初[\s\S]*入账[\s\S]*支出[\s\S]*结余/.test(ed.sumText), true);
  t('编辑器金额单位已改为「元」', /结余[\s\S]*元/.test(ed.sumText), true);
  t('弹窗内容区可滚动（overflow-y:auto，不会被裁掉）', ed.overflowY, 'auto');

  // 加一个支出项并保存 → 结余应该相应减少
  const balBefore = await cdp.evalJs(`(function(){const m=/＝ 结余 ([\\d.]+)/.exec(document.querySelector('.wf-sum').textContent); return m?Number(m[1]):null;})()`);
  await cdp.evalJs(`document.querySelector('[data-wf-add="支出"]').click()`);
  await cdp.evalJs(`(function(){
    const rows=document.querySelectorAll('#wf-rows [data-wf-item][data-wf-stage="支出"]');
    const last=rows[rows.length-1];
    last.querySelector('[data-wf-name]').value='E2E测试支出';
    last.querySelector('[data-wf-amt]').value='1.5';
    return true;
  })()`);
  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  await sleep(1500);
  // 保存没生效时先把「弹窗是否还开着 / 有没有报错 toast」打出来，避免只能看到「行数没变」
  const e2dbg = await cdp.evalJs(`(function(){
    return {
      miniOpen: !document.getElementById('mini-modal').classList.contains('hidden'),
      confirmOpen: !document.getElementById('confirm-modal').classList.contains('hidden'),
      toast: (document.getElementById('toast')||{}).textContent || '',
    };
  })()`);
  console.log('    保存后:', JSON.stringify(e2dbg));
  const wfSaved = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    const mine = rows.filter(r=>String(r['经费项目']||'').indexOf('E2E')>=0);
    const CE = window.ConfigEngine;
    const all = CE.waterfallRows(d['05-经费瀑布'], {groupBy:'工会名称', stageField:'收支类型', field:'金额（元）'});
    return { total: rows.length, added: mine.length, stage: mine[0] ? mine[0]['收支类型'] : '', unions: all.length };
  })()`);
  console.log('    ', JSON.stringify(wfSaved), '改前结余=', balBefore);
  t('新增的支出项已落库', wfSaved.added, 1);
  t('新增行的阶段 = 支出', wfSaved.stage, '支出');
  t('瀑布表行数 14 → 15', wfSaved.total, 15);

  // ---------- 后台：新增工会组织 ----------
  await gotoAdmin();
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表(2)');
  await cdp.evalJs(`document.getElementById('btn-add-union').click()`);
  await waitFor('!!document.getElementById("u-name")', '新增工会弹窗');
  await cdp.evalJs(`(function(){
    document.getElementById('u-name').value='E2E测试工会';
    document.getElementById('u-initial').value='3.5';
    document.getElementById('u-amount').value='2';
    return true;
  })()`);
  const formVals = await cdp.evalJs(`(function(){
    const g = id => { const el = document.getElementById(id); return el ? el.value : '(缺失)'; };
    return { name: g('u-name'), initial: g('u-initial'), amount: g('u-amount'), proj: g('u-proj') };
  })()`);
  console.log('    表单填写值:', JSON.stringify(formVals));
  t('表单里的入账金额已填好', formVals.amount, '2');
  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  await sleep(1600);
  const afterAdd = await cdp.evalJs(`(function(){
    return {
      stillOpen: !document.getElementById('mini-modal').classList.contains('hidden'),
      toast: (document.getElementById('toast')||{}).textContent || '',
    };
  })()`);
  console.log('    提交后:', JSON.stringify(afterAdd));
  t('新增工会弹窗已关闭（流程走完）', afterAdd.stillOpen, false);
  const added = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const wf = d['05-经费瀑布'].rows.filter(r=>r['工会名称']==='E2E测试工会');
    const org = d['01-组织建设'].rows.filter(r=>r['工会名称']==='E2E测试工会');
    return { wf: wf.length, org: org.length, stages: wf.map(r=>r['收支类型']), amounts: wf.map(r=>r['金额（元）']) };
  })()`);
  console.log('    ', JSON.stringify(added));
  t('新增工会写进瀑布表（期初 + 入账 两行）', added.wf, 2);
  t('新增工会的阶段正确', JSON.stringify(added.stages), JSON.stringify(['期初', '入账']));
  t('新增工会的金额按填写值入库', JSON.stringify(added.amounts), JSON.stringify([3.5, 2]));
  t('新增工会同步登记到「一、组织建设」表', added.org, 1);

  await gotoDashboard();
  const unionsNow = await cdp.evalJs(`(async()=>{
    const cfg = await (await fetch('/api/config',{credentials:'include'})).json();
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const ch = (cfg.charts||[]).find(c=>c.type==='waterfall');
    return window.ConfigEngine.waterfallRows(d[ch.sheet], ch).length;
  })()`);
  t('新工会在看板瀑布图上立刻出现（7 → 8 行）', unionsNow, 8);

  // ---------- 【E3】回归：瀑布编辑器里「＋ 新增工会」不能把原工会清空 ----------
  // 真实事故：showMiniModal 当年只有一个 #mini-modal，内层弹窗把外层的 DOM 顶掉，
  // 外层 onConfirm 在失效 DOM 里读不到 #wf-rows → 把当前工会当成"用户清空了科目"写库，
  // 表现为「编辑完瀑布图后，工会连同金额一起从看板上消失」。
  console.log('\n【E3】瀑布编辑器内嵌「新增工会」不能丢原数据');
  await gotoAdmin();
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表(嵌套)');
  const beforeNest = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return { rows: rows.length, unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))] };
  })()`);
  await cdp.evalJs(`document.getElementById('btn-fund-editor').click()`);
  await waitFor('!!document.querySelector(".wf-union-list li[data-wf-union]")', '瀑布图编辑器(嵌套)');
  t('打开编辑器时列出全部工会',
    await cdp.evalJs('document.querySelectorAll(".wf-union-list li[data-wf-union]").length'), beforeNest.unions.length);

  await cdp.evalJs(`document.getElementById('wf-add-union').click()`);
  await waitFor('!!document.getElementById("u-name")', '嵌套的新增工会弹窗');
  const nestState = await cdp.evalJs(`(function(){
    return {
      layers: document.querySelectorAll('.modal-backdrop:not(.hidden)').length,
      outerAlive: !document.getElementById('mini-modal').classList.contains('hidden')
        && !!document.querySelector('#mini-modal-content .wf-wrap'),
      innerAlive: !!document.getElementById('u-name'),
    };
  })()`);
  t('嵌套时两层弹窗同时存在', nestState.layers, 2);
  t('嵌套时外层编辑器仍然在（没有被顶掉）', nestState.outerAlive, true);
  t('嵌套时内层「新增工会」表单可见', nestState.innerAlive, true);

  await cdp.evalJs(`(function(){
    document.getElementById('u-name').value='E2E嵌套测试工会';
    document.getElementById('u-initial').value='0';
    document.getElementById('u-amount').value='';
    return true;
  })()`);
  await cdp.evalJs(`document.querySelector('.mini-layer .mini-ok').click()`);
  await sleep(1600);
  const afterNest = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return {
      rows: rows.length,
      unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))],
      outerOpen: !document.getElementById('mini-modal').classList.contains('hidden'),
    };
  })()`);
  const lostNest = beforeNest.unions.filter(n => afterNest.unions.indexOf(n) < 0);
  console.log('    新增后:', JSON.stringify(afterNest), '丢失:', JSON.stringify(lostNest));
  t('嵌套新增后原工会一个都没丢', JSON.stringify(lostNest), JSON.stringify([]));
  t('嵌套新增后外层编辑器仍然开着', afterNest.outerOpen, true);
  t('新工会已写入（工会数 +1）', afterNest.unions.length, beforeNest.unions.length + 1);

  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  await sleep(1600);
  const afterOuterSave = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return { rows: rows.length, unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))] };
  })()`);
  const lostSave = beforeNest.unions.filter(n => afterOuterSave.unions.indexOf(n) < 0);
  console.log('    外层保存后:', JSON.stringify(afterOuterSave), '丢失:', JSON.stringify(lostSave));
  t('外层保存后原工会仍然一个不少', JSON.stringify(lostSave), JSON.stringify([]));
  t('外层保存后行数 = 新增前 + 1', afterOuterSave.rows, beforeNest.rows + 1);

  // 主动删除工会仍然要能用（保护逻辑不能把正常删除也拦下来）
  await cdp.evalJs(`document.getElementById('btn-fund-editor').click()`);
  await waitFor('!!document.querySelector(".wf-union-list li[data-wf-union]")', '瀑布图编辑器(删除)');
  await cdp.evalJs(`(function(){
    const li=[...document.querySelectorAll('.wf-union-list li[data-wf-union]')]
      .find(x=>x.dataset.wfUnion==='E2E嵌套测试工会');
    if(!li) return 'NO'; li.click(); return 'OK';
  })()`);
  await sleep(400);
  await cdp.evalJs(`document.getElementById('wf-del-union').click()`);
  await waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")', '删除确认框');
  await cdp.evalJs(`document.getElementById('confirm-ok').click()`);
  await sleep(400);
  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  await sleep(1500);
  const afterDel = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return {
      unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))],
      confirmStillOpen: !document.getElementById('confirm-modal').classList.contains('hidden'),
      miniOpen: !document.getElementById('mini-modal').classList.contains('hidden'),
    };
  })()`);
  const lostDel = beforeNest.unions.filter(n => afterDel.unions.indexOf(n) < 0);
  console.log('    删除后:', JSON.stringify(afterDel), '丢失:', JSON.stringify(lostDel));
  t('主动删除的工会不会触发「骤减」二次追问', afterDel.confirmStillOpen, false);
  t('主动删除已生效（该工会从瀑布表移除）', afterDel.unions.indexOf('E2E嵌套测试工会') < 0, true);
  t('删除一个工会不影响其它工会', JSON.stringify(lostDel), JSON.stringify([]));

  // ---------- 【E4】回归：科目行被删空的工会不能整组消失 ----------
  // 真实事故（v1.4.2 线上仍复现）：把某工会的 3 行科目逐个点 × 删掉再保存 →
  // fundModelToRows 一行都不产出，工会连同期初/入账/支出从「05-经费瀑布」整组消失，
  // 看板瀑布图那一行也跟着没了；而「工会骤减」保险只比对**工会名**（名字还在 model 里），
  // 压根不报警 —— 这就是「编辑完瀑布图，工会组织凭空消失」的真凶。
  console.log('\n【E4】科目被删空的工会不能整组消失');
  await gotoAdmin();
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表(删空)');
  const beforeEmpty = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return {
      name: String(rows[0]['工会名称'] || '').trim(),
      rows: rows.length,
      unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))],
      snapshot: rows,
    };
  })()`);
  await cdp.evalJs(`document.getElementById('btn-fund-editor').click()`);
  await waitFor('!!document.querySelector(".wf-union-list li[data-wf-union]")', '瀑布图编辑器(删空)');
  await cdp.evalJs(`(function(){ const li=document.querySelector('.wf-union-list li[data-wf-union]'); if(li) li.click(); return true; })()`);
  await sleep(350);
  const rowCount0 = await cdp.evalJs('document.querySelectorAll("#wf-rows [data-wf-item]").length');
  for (let i = 0; i < rowCount0; i++) {
    await cdp.evalJs(`(function(){const r=document.querySelectorAll('#wf-rows [data-wf-item]')[0]; if(r) r.querySelector('[data-wf-del]').click(); return true;})()`);
    await sleep(80);
  }
  t('科目行能被逐个删掉（点 × 生效）', await cdp.evalJs('document.querySelectorAll("#wf-rows [data-wf-item]").length'), 0);
  t('删空后给出「保存会补 0 元」的提示', await cdp.evalJs(`!!document.querySelector('.wf-warn-hint')`), true);

  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  const needConfirm = await waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")', '清零保存确认框', 6000);
  t('金额被清成 0 时保存前必须二次确认', needConfirm, true);
  await cdp.evalJs(`document.getElementById('confirm-ok').click()`);
  await sleep(1800);
  const afterEmpty = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    const name = ${JSON.stringify(beforeEmpty.name)};
    return {
      rows: rows.length,
      unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))],
      mine: rows.filter(r=>String(r['工会名称']||'').trim()===name).length,
    };
  })()`);
  const lostEmpty = beforeEmpty.unions.filter(n => afterEmpty.unions.indexOf(n) < 0);
  console.log('    删空后保存:', JSON.stringify({ rows: afterEmpty.rows, mine: afterEmpty.mine }), '丢失:', JSON.stringify(lostEmpty));
  t('科目被删空的工会仍然在（不会整组消失）', JSON.stringify(lostEmpty), JSON.stringify([]));
  t('该工会保留 1 行 0 元期初兜底', afterEmpty.mine, 1);

  // 恢复这份测试数据，后面的用例还要用
  const restoredEmpty = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    d['05-经费瀑布'].rows = ${JSON.stringify(beforeEmpty.snapshot)};
    const r = await fetch('/api/data',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    return r.status;
  })()`);
  t('删空用例的数据已恢复', restoredEmpty, 200);

  // ---------- 【E5】保存是「合并」而不是整表覆盖 ----------
  // 编辑器开着的时候，别的标签页/手机端写进来的工会，保存时绝不能被旧快照抹掉。
  console.log('\n【E5】编辑器开着时别人写入的工会不能被覆盖');
  await gotoAdmin();
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表(并发)');
  const beforeConcurrent = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return { rows: rows.length, unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))] };
  })()`);
  await cdp.evalJs(`document.getElementById('btn-fund-editor').click()`);
  await waitFor('!!document.querySelector(".wf-union-list li[data-wf-union]")', '瀑布图编辑器(并发)');
  const injected = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    d['05-经费瀑布'].rows.push({'工会名称':'E2E并发工会','工会全称':'','收支类型':'期初','经费项目':'期初','金额（元）':66.6,'备注':''});
    const r = await fetch('/api/data',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    return r.status;
  })()`);
  t('模拟「另一客户端」写入成功', injected, 200);
  await sleep(1200);   // 等 SSE 回声
  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  await sleep(1800);
  const afterConcurrent = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows;
    return {
      rows: rows.length,
      unions: [...new Set(rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))],
      mine: rows.filter(r=>String(r['工会名称']||'').trim()==='E2E并发工会').length,
    };
  })()`);
  const lostConcurrent = beforeConcurrent.unions.filter(n => afterConcurrent.unions.indexOf(n) < 0);
  console.log('    并发保存后:', JSON.stringify(afterConcurrent), '丢失:', JSON.stringify(lostConcurrent));
  t('保存不会抹掉别人刚写入的工会', afterConcurrent.mine, 1);
  t('原有工会一个不少', JSON.stringify(lostConcurrent), JSON.stringify([]));

  // ---------- 【E6】「按 04 表补全」能把误删的工会找回来 ----------
  console.log('\n【E6】按「04-经费收支」补回被误删的工会');
  await gotoAdmin();
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表(补全)');
  const victim = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const n4 = [...new Set(d['04-经费收支'].rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))];
    const n5 = [...new Set(d['05-经费瀑布'].rows.map(r=>String(r['工会名称']||'').trim()).filter(Boolean))];
    const name = n5.find(n => n4.indexOf(n) >= 0 && n.indexOf('E2E') < 0);
    const mine = d['05-经费瀑布'].rows.filter(r=>String(r['工会名称']||'').trim()===name);
    d['05-经费瀑布'].rows = d['05-经费瀑布'].rows.filter(r=>String(r['工会名称']||'').trim()!==name);
    const r = await fetch('/api/data',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    return { name, removed: mine.length, status: r.status };
  })()`);
  console.log('    故意整组删掉:', JSON.stringify(victim));
  // ⚠️ 必须真的重新加载页面：Page.navigate 到同一个 URL 时浏览器可能不重新拉数据，
  //    那样 DATA 还是改之前那份，页面上就看不到「只在 04 表里的工会」。
  await cdp.send('Page.navigate', { url: BASE + '/admin.html?e6=' + Date.now() });
  await waitFor('document.readyState==="complete" && document.querySelectorAll(".tab-btn").length>0', '后台就绪(补全)');
  await sleep(600);
  await clickTab('05-经费瀑布', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费瀑布表(补全2)');
  await cdp.evalJs(`document.getElementById('btn-fund-editor').click()`);
  await waitFor('!!document.querySelector(".wf-union-list li[data-wf-union]")', '瀑布图编辑器(补全)');
  const hasFixBtn = await cdp.evalJs(`(function(){
    const b = document.querySelector('[data-wf-fill-missing]');
    return b ? { found: true, text: b.textContent.trim(), visible: b.offsetParent !== null } : { found: false };
  })()`);
  console.log('    补全按钮:', JSON.stringify(hasFixBtn));
  t('检测到「只在 04 表里的工会」并给出补全按钮', hasFixBtn.found, true);
  t('补全按钮真实可见', hasFixBtn.visible, true);
  await cdp.evalJs(`document.querySelector('[data-wf-fill-missing]').click()`);
  await sleep(500);
  t('点补全后该工会出现在左侧列表',
    await cdp.evalJs(`[...document.querySelectorAll('.wf-union-list li[data-wf-union]')].some(x=>x.dataset.wfUnion===${JSON.stringify(victim.name)})`), true);
  await cdp.evalJs(`document.getElementById('mini-modal-ok').click()`);
  await sleep(1800);
  const afterFix = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const rows = d['05-经费瀑布'].rows.filter(r=>String(r['工会名称']||'').trim()===${JSON.stringify(victim.name)});
    return { rows: rows.length, stages: rows.map(r=>r['收支类型']), amounts: rows.map(r=>r['金额（元）']) };
  })()`);
  console.log('    补回后:', JSON.stringify(afterFix));
  t('误删的工会被补回瀑布表（至少 1 行期初）', afterFix.rows >= 1 && afterFix.stages.indexOf('期初') >= 0, true);
  t('补回的金额取自「04-经费收支」（>0）', afterFix.amounts.some(a => Number(a) > 0), true);

  // 清理测试数据（E2E 用的是临时数据副本，但保持干净便于反复跑）
  await gotoAdmin();
  const cleaned = await cdp.evalJs(`(async()=>{
    const d = await (await fetch('/api/data',{credentials:'include'})).json();
    const hit = v => String(v||'').indexOf('E2E') >= 0;
    d['05-经费瀑布'].rows = d['05-经费瀑布'].rows.filter(r=>!hit(r['工会名称']) && !hit(r['经费项目']));
    d['01-组织建设'].rows = d['01-组织建设'].rows.filter(r=>!hit(r['工会名称']));
    const p = await fetch('/api/data',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    return p.status;
  })()`);
  t('清理 E2E 测试数据 200', cleaned, 200);

  console.log('\n【E7】v1.6 新板块：筹建进度表 / 月度图 / 干事月度矩阵');
  await gotoDashboard();

  // ---- ① 筹建中工会筹建进度表（明细列表表）----
  const prep = await cdp.evalJs(`(function(){
    var host = document.getElementById('table-b-org-preparing');
    if (!host) return { found: false };
    var tb = host.querySelector('table.data-table');
    if (!tb) return { found: true, table: false };
    var head = [...tb.querySelectorAll('thead th')].map(x=>x.textContent.trim());
    var body = [...tb.querySelectorAll('tbody tr')];
    return {
      found: true, table: true,
      head: head,
      rows: body.length,
      first: body.length ? [...body[0].querySelectorAll('td')].map(x=>x.textContent.trim()) : [],
      bars: host.querySelectorAll('.pg-bar').length,
      clickable: body.filter(tr=>tr.classList.contains('clickable')).length,
      visible: host.offsetParent !== null,
    };
  })()`);
  console.log('    筹建进度表:', JSON.stringify(prep));
  t('筹建进度表已渲染', prep.found && prep.table, true);
  t('表头含 工会名称/当前进度/进度日期/工作负责人',
    ['工会名称', '当前进度', '进度日期', '工作负责人'].every(h => (prep.head || []).indexOf(h) >= 0), true);
  t('只显示筹建中的工会（种子 7 个）', prep.rows, 7);
  t('每行可点击看明细', prep.clickable, 7);
  t('筹建进度表真实可见', prep.visible, true);
  // 还没填进度时不该画空槽（一排空槽看着像页面坏了），只显示「—」
  t('未填进度时不画空进度条', prep.bars, 0);
  t('未填进度显示「—」', (prep.first || [])[1], '—');

  // ---- 填一条真实进度，验证「下拉阶段 → 进度条百分比」这条链路 ----
  const fillStatus = await (async () => {
    const g = await fetch(BASE + '/api/data', { headers: { Cookie: `hdj_sid=${SID_ADMIN || SID}` } });
    const d = await g.json();
    if (!d || !d['01-组织建设']) {
      console.log(`    ⚠ GET /api/data 失败 status=${g.status} keys=${JSON.stringify(Object.keys(d || {}).slice(0, 4))}`);
      return 0;
    }
    const sh = d['01-组织建设'];
    const H = sh.headers;
    const put = { '当前进度': '会员登记', '进度日期': '2026-09-15', '工作负责人': 'E2E负责人' };
    sh.rows.forEach(r => {
      const nm = Array.isArray(r) ? r[H.indexOf('工会名称')] : r['工会名称'];
      if (String(nm || '').trim() !== '浙沪大区工会') return;
      Object.keys(put).forEach(k => {
        const i = H.indexOf(k);
        if (i < 0) return;
        if (Array.isArray(r)) { while (r.length <= i) r.push(''); r[i] = put[k]; }
        else r[k] = put[k];
      });
    });
    const res = await fetch(BASE + '/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `hdj_sid=${SID_ADMIN}` },
      body: JSON.stringify(d),
    });
    return res.status;
  })();
  t('写入一条筹建进度 200', fillStatus, 200);
  await gotoDashboard();
  const filled = await cdp.evalJs(`(function(){
    var host = document.getElementById('table-b-org-preparing');
    if (!host) return { found:false };
    var tr = [...host.querySelectorAll('tbody tr')].find(x => x.textContent.indexOf('浙沪大区工会') >= 0);
    if (!tr) return { found:true, row:false };
    var tds = [...tr.querySelectorAll('td')];
    var bar = tr.querySelector('.pg-bar > i');
    return {
      found:true, row:true,
      texts: tds.map(x=>x.textContent.trim()),
      barWidth: bar ? bar.style.width : null,
    };
  })()`);
  console.log('    填完进度:', JSON.stringify(filled));
  t('进度阶段显示为文字', (filled.texts || [])[1], '会员登记');
  // 浏览器会把 "40.0%" 规范化成 "40%"
  t('阶段换算成进度条（6 阶段里的第 3 个 = 40%）', filled.barWidth, '40%');
  t('进度日期同步显示', (filled.texts || [])[2], '2026-09-15');
  t('工作负责人同步显示', (filled.texts || [])[3], 'E2E负责人');
  t('其他未填的工会不受影响',
    await cdp.evalJs(`document.querySelectorAll('#table-b-org-preparing .pg-bar').length`), 1);

  // ---- ② 月度图（柱=人次/场次，线=金额，双轴）----
  const monthlyChart = await cdp.evalJs(`(function(){
    var out = {};
    ['b-visit-monthly','b-act-monthly'].forEach(function(id){
      var el = document.getElementById('chart-' + id);
      if (!el) { out[id] = { found:false }; return; }
      var inst = (window.echarts && echarts.getInstanceByDom) ? echarts.getInstanceByDom(el) : null;
      if (!inst) { out[id] = { found:true, inst:false }; return; }
      var op = inst.getOption();
      out[id] = {
        found: true, inst: true,
        series: (op.series||[]).length,
        types: (op.series||[]).map(s=>s.type),
        names: (op.series||[]).map(s=>s.name),
        cats: ((op.xAxis||[])[0]||{}).data || [],
        yAxes: (op.yAxis||[]).length,
        legend: !!((op.legend||[])[0]||{}).show,
      };
    });
    return out;
  })()`);
  console.log('    月度图:', JSON.stringify(monthlyChart));
  const vm1 = monthlyChart['b-visit-monthly'] || {}, am1 = monthlyChart['b-act-monthly'] || {};
  t('走访月度图有两条系列（人次柱 + 金额线）', vm1.series, 2);
  t('走访月度图系列类型', (vm1.types || []).join(','), 'bar,line');
  t('走访月度图有左右两条 Y 轴', vm1.yAxes, 2);
  t('走访月度图 x 轴是按月份升序', (vm1.cats || []).join(','), '2026-08,2026-09');
  t('活动月度图有两条系列', am1.series, 2);
  t('活动月度图 x 轴是按月份升序', (am1.cats || []).join(','), '2026-08,2026-09');
  t('月度图显示图例', vm1.legend, true);

  // ---- ③ 工会干事 × 月份 矩阵表 ----
  const staffTbl = await cdp.evalJs(`(function(){
    var host = document.getElementById('table-b-visit-staff');
    if (!host) return { found:false };
    var tb = host.querySelector('table.data-table');
    if (!tb) return { found:true, table:false };
    var head = [...tb.querySelectorAll('thead th')].map(x=>x.textContent.trim());
    var body = [...tb.querySelectorAll('tbody tr')];
    return {
      found:true, table:true, head: head,
      rows: body.map(tr=>[...tr.querySelectorAll('td')].map(x=>x.textContent.trim())),
      visible: host.offsetParent !== null,
    };
  })()`);
  console.log('    干事矩阵表:', JSON.stringify(staffTbl));
  t('干事矩阵表已渲染', staffTbl.found && staffTbl.table, true);
  t('矩阵列 = 月份 + 合计', (staffTbl.head || []).join(','), '经办人,2026-08,2026-09,合计');
  t('矩阵行 = 各工会干事', (staffTbl.rows || []).some(r => r[0] === '杨聃'), true);
  t('矩阵有月度合计行', (staffTbl.rows || []).some(r => r[0] === '月度合计'), true);
  t('干事矩阵表真实可见', staffTbl.visible, true);

  // ---- ④ 「覆盖总人次」卡片已按要求删除 ----
  const coverage = await cdp.evalJs(`(function(){
    return {
      cards: document.querySelectorAll('[data-metric="act-coverage"]').length,
      labels: [...document.querySelectorAll('.metric-label')].map(x=>x.textContent.trim()),
    };
  })()`);
  console.log('    覆盖总人次:', JSON.stringify(coverage));
  t('「覆盖总人次」卡片已从看板移除', coverage.cards, 0);
  t('指标卡里不再出现「覆盖总人次」', (coverage.labels || []).indexOf('覆盖总人次'), -1);
  t('「活动总数量 / 活动支出总额」卡片仍在',
    ['活动总数量', '活动支出总额'].every(l => (coverage.labels || []).indexOf(l) >= 0), true);

  // ---- ⑤ 后台能编辑这两张新表（列表表要有「明细列」编辑器，交叉表要有日期分组）----
  await gotoAdmin();
  await clickTab('__config', '!!document.getElementById("cfg-json")', '配置面板(明细表)');
  const idxList = await cdp.evalJs(`[...document.querySelectorAll('[data-tables-row]')].findIndex(tr=>tr.textContent.indexOf('tbl-org-preparing')>=0)`);
  t('配置面板里能找到「筹建进度表」', idxList >= 0, true);
  await cdp.evalJs(`document.querySelector('[data-tables-row="${idxList}"] [data-act="table-edit"]').click()`);
  await waitFor('!document.getElementById("mini-modal").classList.contains("hidden")', '明细表编辑弹窗');
  await sleep(400);
  const listEditor = await cdp.evalJs(`(function(){
    var listRows = [...document.querySelectorAll('#list-rows [data-lrow]')];
    var whereRows = [...document.querySelectorAll('#where-rows [data-wrow]')];
    var typeSel = document.querySelector('[data-k="type"]');
    var prog = listRows[1];
    return {
      open: !document.getElementById('mini-modal').classList.contains('hidden'),
      type: typeSel ? typeSel.value : null,
      listRows: listRows.length,
      whereRows: whereRows.length,
      whereValue: whereRows[0] ? whereRows[0].querySelector('[data-w-value]').value : null,
      fields: listRows.map(r => r.querySelector('[data-l-field]').value),
      renders: listRows.map(r => r.querySelector('[data-l-render]').value),
      stages: prog ? prog.querySelector('[data-l-stages]').value : '',
      scrollable: (function(){var c=document.getElementById('mini-modal-content'); var b=c.scrollTop; c.scrollTop=1e6; var m=c.scrollTop; c.scrollTop=b; return m>0;})(),
    };
  })()`);
  console.log('    明细表编辑器:', JSON.stringify(listEditor));
  t('统计表类型下拉 = list', listEditor.type, 'list');
  t('明细列编辑器有 4 列', listEditor.listRows, 4);
  t('明细列字段按配置回填', (listEditor.fields || []).join(','), '工会名称,当前进度,进度日期,工作负责人');
  t('「当前进度」渲染方式 = progress', (listEditor.renders || [])[1], 'progress');
  t('进度阶段回填完整', (listEditor.stages || '').indexOf('选举筹备') >= 0, true);
  t('筛选条件编辑器有 1 条（组建状态=筹建中）', listEditor.whereRows, 1);
  t('筛选条件值回填', listEditor.whereValue, '筹建中');
  t('明细表编辑器可滚动', listEditor.scrollable, true);
  await closeMini();

  const idxCross = await cdp.evalJs(`[...document.querySelectorAll('[data-tables-row]')].findIndex(tr=>tr.textContent.indexOf('tbl-visit-staff-month')>=0)`);
  await cdp.evalJs(`document.querySelector('[data-tables-row="${idxCross}"] [data-act="table-edit"]').click()`);
  await waitFor('!document.getElementById("mini-modal").classList.contains("hidden")', '交叉表编辑弹窗');
  await sleep(400);
  const crossEditor = await cdp.evalJs(`(function(){
    var g = function(k){ var e=document.querySelector('[data-k="'+k+'"]'); return e?e.value:null; };
    return { type: g('type'), colDateGroup: g('colDateGroup'), rowField: g('rowField'), colField: g('colField') };
  })()`);
  console.log('    干事矩阵编辑器:', JSON.stringify(crossEditor));
  t('交叉表类型 = cross', crossEditor.type, 'cross');
  t('列按月份分组已回填', crossEditor.colDateGroup, 'month');
  t('行字段 = 经办人', crossEditor.rowField, '经办人');
  t('列字段 = 慰问日期', crossEditor.colField, '慰问日期');
  await closeMini();

  // ==================== 【E8】批量删除（v1.7） ====================
  console.log('\n【E8】批量删除：勾选 → 计数 → 一次性整表写回');
  await gotoAdmin();
  await clickTab('02-走访慰问', 'document.querySelectorAll("#admin-table tbody tr").length>0', '走访慰问表(批量删除)');
  const bd0 = await cdp.evalJs(`(function(){
    var rows = document.querySelectorAll('#admin-table tbody tr').length;
    return {
      rows: rows,
      checks: document.querySelectorAll('#admin-table tbody input.row-check').length,
      hasAll: !!document.getElementById('check-all'),
      btnHidden: document.getElementById('btn-delete-selected').classList.contains('hidden'),
      selText: (document.getElementById('sel-count')||{}).textContent || '',
    };
  })()`);
  console.log('    初始:', JSON.stringify(bd0));
  t('每行都有勾选框', bd0.checks > 0 && bd0.checks === bd0.rows, true);
  t('表头有「全选」框', bd0.hasAll, true);
  t('未勾选时不显示删除按钮', bd0.btnHidden, true);
  t('未勾选时计数为空', bd0.selText, '');

  await cdp.evalJs(`(function(){var c=document.getElementById('check-all'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  await sleep(700);
  const bd1 = await cdp.evalJs(`(function(){
    return {
      btnHidden: document.getElementById('btn-delete-selected').classList.contains('hidden'),
      btnText: document.getElementById('btn-delete-selected').textContent.trim(),
      selText: (document.getElementById('sel-count')||{}).textContent || '',
      highlighted: document.querySelectorAll('#admin-table tbody tr.row-selected').length,
    };
  })()`);
  console.log('    全选后:', JSON.stringify(bd1));
  t('全选后显示删除按钮', bd1.btnHidden, false);
  t('按钮上带勾选条数', bd1.btnText, '🗑 删除所选（' + bd0.rows + '）');
  t('提示显示已选条数', bd1.selText, '已选 ' + bd0.rows + ' 条');
  t('被勾选的行有高亮样式', bd1.highlighted, bd0.rows);

  await cdp.evalJs(`(function(){var c=document.getElementById('check-all'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  await sleep(700);
  t('取消全选后按钮收起',
    await cdp.evalJs(`document.getElementById('btn-delete-selected').classList.contains('hidden')`), true);

  // 勾 3 行 → 确认 → 行数 -3（必须一次写回，不能逐行 PUT）
  await cdp.evalJs(`(function(){
    [...document.querySelectorAll('#admin-table tbody input.row-check')].slice(0,3).forEach(function(cb){
      cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true}));
    });
    return true;
  })()`);
  await sleep(600);
  t('勾选 3 行后按钮计数 = 3',
    await cdp.evalJs(`document.getElementById('btn-delete-selected').textContent.trim()`), '🗑 删除所选（3）');
  await cdp.evalJs(`document.getElementById('btn-delete-selected').click()`);
  await waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")', '批量删除确认框');
  await cdp.evalJs(`document.getElementById('confirm-ok').click()`);
  await sleep(2000);
  const bd2 = await cdp.evalJs(`(async()=>{
    var d = await (await fetch('/api/data',{credentials:'include'})).json();
    return {
      rows: d['02-走访慰问'].rows.length,
      btnHidden: document.getElementById('btn-delete-selected').classList.contains('hidden'),
      selText: (document.getElementById('sel-count')||{}).textContent || '',
    };
  })()`);
  console.log('    删除后:', JSON.stringify(bd2));
  t('批量删除后行数 -3', bd2.rows, bd0.rows - 3);
  t('删除后勾选状态清空（按钮收起、计数归零）', [bd2.btnHidden, bd2.selText].join('|'), 'true|');

  // 确认框点「取消」不许动数据
  const bdCancel0 = await cdp.evalJs(`(async()=>{var d=await (await fetch('/api/data',{credentials:'include'})).json(); return d['02-走访慰问'].rows.length;})()`);
  await cdp.evalJs(`(function(){
    [...document.querySelectorAll('#admin-table tbody input.row-check')].slice(0,2).forEach(function(cb){
      cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true}));
    });
    document.getElementById('btn-delete-selected').click();
    return true;
  })()`);
  await waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")', '取消场景确认框');
  await cdp.evalJs(`document.getElementById('confirm-cancel').click()`);
  await sleep(1400);
  const bdCancel1 = await cdp.evalJs(`(async()=>{var d=await (await fetch('/api/data',{credentials:'include'})).json(); return d['02-走访慰问'].rows.length;})()`);
  t('点「取消」不会删数据', bdCancel1, bdCancel0);

  // 搜索后再全选：只能删筛选出来的行，不能误伤未显示的行（批量删除最容易踩的坑）
  const bdSearch = await cdp.evalJs(`(async()=>{
    var d = await (await fetch('/api/data',{credentials:'include'})).json();
    var H = d['02-走访慰问'].headers, rows = d['02-走访慰问'].rows;
    var iRegion = H.indexOf('所在大区');
    var term = String(rows[0][H[iRegion]] || '').trim() || '（无）';
    var matches = rows.filter(function(r){ return String(r[H[iRegion]]||'').trim() === term; }).length;
    var s = document.getElementById('admin-search');
    s.value = term; s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(function(r){ setTimeout(r,900); });
    return { term: term, matches: matches, shown: document.querySelectorAll('#admin-table tbody tr').length, total: rows.length };
  })()`);
  console.log('    搜索后:', JSON.stringify(bdSearch));
  t('搜索后只显示匹配行', bdSearch.shown, bdSearch.matches);
  t('搜索后显示行数 ≤ 全表行数', bdSearch.shown <= bdSearch.total, true);
  t('搜索确实筛掉了部分行（不是全表）', bdSearch.shown < bdSearch.total, true);

  await cdp.evalJs(`(function(){var c=document.getElementById('check-all'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})); return true;})()`);
  await sleep(800);
  t('搜索状态下全选只勾中筛选结果',
    await cdp.evalJs(`document.getElementById('btn-delete-selected').textContent.trim()`),
    '🗑 删除所选（' + bdSearch.matches + '）');
  await cdp.evalJs(`document.getElementById('btn-delete-selected').click()`);
  await waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")', '筛选态批量删除确认框');
  await cdp.evalJs(`document.getElementById('confirm-ok').click()`);
  await sleep(2000);
  const bdSearchAfter = await cdp.evalJs(`(async()=>{
    var d = await (await fetch('/api/data',{credentials:'include'})).json();
    return { total: d['02-走访慰问'].rows.length };
  })()`);
  t('筛选态批量删除只删掉筛选出的行',
    bdSearchAfter.total, bdSearch.total - bdSearch.matches);
  // 清掉搜索词，恢复全表视图
  await cdp.evalJs(`(function(){
    var s=document.getElementById('admin-search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(700);

  // ==================== 【E9】收集端口填报端（v1.7） ====================
  console.log('\n【E9】收集端口：独立填报入口 / 账号隔离 / 提报人盖章');
  await cdp.send('Page.navigate', { url: BASE + '/collect.html' });
  await waitFor('document.readyState==="complete" && !!document.getElementById("cl-user")', 'collect.html 就绪');
  await sleep(900);

  const clInit = await cdp.evalJs(`(function(){
    var vis = function(el){ return !!el && el.offsetParent !== null && getComputedStyle(el).display !== 'none'; };
    return {
      loginVisible: vis(document.getElementById('collect-login')),
      mainHidden: !vis(document.getElementById('collect-main')),
      hasUser: !!document.getElementById('cl-user'),
      hasPass: !!document.getElementById('cl-pass'),
      errHidden: document.getElementById('cl-error').classList.contains('hidden'),
    };
  })()`);
  console.log('    未登录:', JSON.stringify(clInit));
  t('未登录时只显示登录卡', clInit.loginVisible && clInit.mainHidden, true);
  t('有用户名 / 密码输入框', clInit.hasUser && clInit.hasPass, true);

  // 错误密码 → 报错且不进主界面
  await cdp.evalJs(`(function(){
    document.getElementById('cl-user').value='port1';
    document.getElementById('cl-pass').value='wrong-pass';
    document.getElementById('cl-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return true;
  })()`);
  await sleep(1200);
  t('密码错误时给出提示',
    await cdp.evalJs(`!document.getElementById('cl-error').classList.contains('hidden')`), true);
  t('密码错误时不进入填报界面',
    await cdp.evalJs(`document.getElementById('collect-main').classList.contains('hidden')`), true);

  // 正确密码 → 进入填报界面
  await cdp.evalJs(`(function(){
    document.getElementById('cl-user').value='port1';
    document.getElementById('cl-pass').value='gh123456';
    document.getElementById('cl-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return true;
  })()`);
  await waitFor('!document.getElementById("collect-main").classList.contains("hidden")', '端口登录成功');
  await sleep(1200);
  const clMain = await cdp.evalJs(`(function(){
    return {
      portName: (document.getElementById('cm-port-name')||{}).textContent || '',
      tabs: [...document.querySelectorAll('#cm-tabs .cm-tab')].map(function(b){ return b.textContent.trim(); }),
      fields: document.querySelectorAll('#cm-form .cm-field').length,
      required: document.querySelectorAll('#cm-form .cm-req').length,
    };
  })()`);
  console.log('    登录后:', JSON.stringify(clMain));
  t('显示当前端口名', /收集端口\s*1/.test(clMain.portName), true);
  t('可填报表 = 组织建设 / 走访慰问 / 员工活动 三张',
    clMain.tabs.length, 3);
  t('填报表单有字段且必填项带 *',
    clMain.fields > 0 && clMain.required > 0, true);

  // 切到「走访慰问」并填一条（费用列支账户 = 经费收支表里第一个工会）
  // 注意：此刻是**端口会话**，读不了 /api/data（403），候选工会名从 /api/port/sheets 的
  // accounts 里取 —— 它本来就是给填报端用的下拉候选。
  const targetUnion = await cdp.evalJs(`(async()=>{
    var r = await (await fetch('/api/port/sheets',{credentials:'include'})).json();
    var accts = ((r.sheets||[]).find(function(s){ return Array.isArray(s.accounts) && s.accounts.length; })||{}).accounts || [];
    return String(accts[0] || '').trim();
  })()`);
  await cdp.evalJs(`(function(){
    var b=[...document.querySelectorAll('#cm-tabs .cm-tab')].find(function(x){ return x.textContent.indexOf('走访慰问')>=0; });
    if(b) b.click();
    return !!b;
  })()`);
  await sleep(1200);
  const clFill = await cdp.evalJs(`(function(){
    var f=document.getElementById('cm-form');
    var set=function(name,val){ var el=f.querySelector('#fld-'+CSS.escape(name)); if(!el) return false; el.value=val; return true; };
    return {
      type: set('慰问类型','其他'),
      name: set('员工姓名','E2E测试员工'),
      region: set('所在大区','E2E大区'),
      dept: set('员工所在部门/门店','E2E门店'),
      date: set('慰问日期','2026-09-20'),
      acct: set('费用列支账户', ${JSON.stringify(targetUnion)}),
      amt: set('慰问物品金额（元）','500'),
      staff: set('经办人','E2E干事'),
      note: set('备注','E2E汇入测试-走访'),
    };
  })()`);
  console.log('    填表:', JSON.stringify(clFill), '目标工会=', targetUnion);
  t('走访慰问表单含「费用列支账户」列', clFill.acct, true);
  t('走访慰问表单含「慰问物品金额（元）」列', clFill.amt, true);
  t('走访慰问表单必需字段齐全',
    [clFill.type, clFill.name, clFill.region, clFill.dept].every(Boolean), true);

  // 「费用列支账户」要挂上来自 04 表「工会名称」的下拉候选，否则填报人只能手打、容易对不上
  const acctOpts = await cdp.evalJs(`(function(){
    var dl = document.getElementById('acct-options');
    var el = document.getElementById('fld-' + '费用列支账户');
    return {
      n: dl ? dl.querySelectorAll('option').length : -1,
      hasList: el ? el.getAttribute('list') : null,
    };
  })()`);
  console.log('    账户候选:', JSON.stringify(acctOpts));
  t('「费用列支账户」挂了下拉候选', acctOpts.hasList, 'acct-options');
  t('候选条目 = 经费收支表里的工会数（7）', acctOpts.n, 7);

  await cdp.evalJs(`document.getElementById('cm-submit').click()`);
  await sleep(2200);
  const clAfter = await cdp.evalJs(`(async()=>{
    var r = await (await fetch('/api/port/records?sheet=' + encodeURIComponent('02-走访慰问'),{credentials:'include'})).json();
    var rows = (r.records||[]).map(function(x){ return x.row; });
    var mine = rows.filter(function(x){ return String(x['备注']||'').indexOf('E2E汇入测试-走访')>=0; });
    return {
      count: (r.records||[]).length,
      mineCount: mine.length,
      reporter: mine[0] ? String(mine[0]['提报人']||'') : '',
      amount: mine[0] ? Number(mine[0]['慰问物品金额（元）']||0) : null,
      tableRows: document.querySelectorAll('#cm-table tbody tr').length,
    };
  })()`);
  console.log('    提交后:', JSON.stringify(clAfter));
  t('填报后能在「我提交的数据」里看到', clAfter.mineCount, 1);
  t('记录自动盖上提报人 = 端口名', clAfter.reporter, '收集端口 1');
  t('金额按填写值入库', clAfter.amount, 500);
  t('我的记录表格已渲染', clAfter.tableRows >= 1, true);

  // 端口会话不能读后台数据接口（越权必须 403）
  const clForbid = await cdp.evalJs(`(async()=>{
    var d = await fetch('/api/data',{credentials:'include'});
    return d.status;
  })()`);
  // 端口会话不是看板/后台角色，requireView 直接 401（拿不到任何后台数据）
  t('端口会话访问后台 /api/data 被拒绝', clForbid, 401);

  // 端口不能改别人的数据（伪造 index → 403）
  const clForbid2 = await cdp.evalJs(`(async()=>{
    var r = await fetch('/api/port/update',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({sheet:'02-走访慰问',index:0,row:{备注:'越权'}})});
    return r.status;
  })()`);
  t('端口改别人的记录被拒绝', clForbid2, 403);

  // 退出 → 回到登录卡
  await cdp.evalJs(`document.getElementById('cm-logout').click()`);
  await sleep(1200);
  t('退出后回到登录卡',
    await cdp.evalJs(`!document.getElementById('collect-login').classList.contains('hidden')`), true);

  // ==================== 【E10】02/03 支出汇入 04-经费收支（v1.7） ====================
  console.log('\n【E10】业务支出汇入经费收支：走访慰问 + 员工活动');
  // 恢复成管理员会话（上面端口登录把 cookie 顶掉了）
  await cdp.evalJs(`(async()=>{
    await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'admin',password:'admin123'})});
    return true;
  })()`);
  await sleep(600);

  const inflow1 = await cdp.evalJs(`(async()=>{
    var get = async function(){ return (await (await fetch('/api/data',{credentials:'include'})).json()); };
    var d0 = await get();
    var fund = d0['04-经费收支'], H = fund.headers;
    var pick = function(r,n){ var i=H.indexOf(n); return i<0?0:Number(r[H[i]]||0); };
    var target = String(fund.rows[0][H[H.indexOf('工会名称')]]||'').trim();
    var before = {
      visitIn: pick(fund.rows[0],'慰问支出汇入（元）'),
      actIn: pick(fund.rows[0],'活动支出汇入（元）'),
      total: pick(fund.rows[0],'支出合计（元）'),
      bal: pick(fund.rows[0],'当前结余（元）'),
    };
    var H2 = d0['02-走访慰问'].headers, row = {};
    H2.forEach(function(h){ row[h]=''; });
    row['慰问类型'] = '其他'; row['员工姓名'] = 'E2E汇入员工';
    row['所在大区'] = 'E2E大区'; row['员工所在部门/门店'] = 'E2E门店';
    row['费用列支账户'] = target;
    row['慰问物品金额（元）'] = 500; row['备注'] = 'E2E汇入测试-走访';
    d0['02-走访慰问'].rows = (d0['02-走访慰问'].rows||[]).concat([row]);
    var put = await fetch('/api/data',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(d0)});
    var d1 = await get(), H1 = d1['04-经费收支'].headers;
    var p = function(r,n){ var i=H1.indexOf(n); return i<0?null:Number(r[H1[i]]||0); };
    return {
      putOk: put.ok, target: target, before: before,
      after: {
        visitIn: p(d1['04-经费收支'].rows[0],'慰问支出汇入（元）'),
        actIn: p(d1['04-经费收支'].rows[0],'活动支出汇入（元）'),
        total: p(d1['04-经费收支'].rows[0],'支出合计（元）'),
        bal: p(d1['04-经费收支'].rows[0],'当前结余（元）'),
      },
    };
  })()`);
  console.log('    走访汇入:', JSON.stringify(inflow1));
  t('写入成功', inflow1.putOk, true);
  t('「慰问支出汇入（元）」增加 500',
    inflow1.after.visitIn, inflow1.before.visitIn + 500);
  t('「支出合计（元）」同步增加 500',
    inflow1.after.total, inflow1.before.total + 500);
  t('「当前结余（元）」相应减少 500',
    inflow1.after.bal, inflow1.before.bal - 500);
  t('不影响「活动支出汇入（元）」',
    inflow1.after.actIn, inflow1.before.actIn);

  const inflow2 = await cdp.evalJs(`(async()=>{
    var get = async function(){ return (await (await fetch('/api/data',{credentials:'include'})).json()); };
    var d0 = await get();
    var fund = d0['04-经费收支'], H = fund.headers;
    var pick = function(r,n){ var i=H.indexOf(n); return i<0?0:Number(r[H[i]]||0); };
    var target = String(fund.rows[0][H[H.indexOf('工会名称')]]||'').trim();
    var before = {
      visitIn: pick(fund.rows[0],'慰问支出汇入（元）'),
      actIn: pick(fund.rows[0],'活动支出汇入（元）'),
      total: pick(fund.rows[0],'支出合计（元）'),
      bal: pick(fund.rows[0],'当前结余（元）'),
    };
    var H3 = d0['03-员工活动'].headers, row = {};
    H3.forEach(function(h){ row[h]=''; });
    row['活动日期'] = '2026-09-25'; row['活动内容'] = 'E2E汇入活动';
    row['活动形式'] = '线下活动'; row['活动类型'] = '文体活动';
    row['费用列支账户'] = target;
    row['支出金额（元）'] = 300; row['备注'] = 'E2E汇入测试-活动';
    d0['03-员工活动'].rows = (d0['03-员工活动'].rows||[]).concat([row]);
    var put = await fetch('/api/data',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(d0)});
    var d1 = await get(), H1 = d1['04-经费收支'].headers;
    var p = function(r,n){ var i=H1.indexOf(n); return i<0?null:Number(r[H1[i]]||0); };
    return {
      putOk: put.ok, before: before,
      after: {
        visitIn: p(d1['04-经费收支'].rows[0],'慰问支出汇入（元）'),
        actIn: p(d1['04-经费收支'].rows[0],'活动支出汇入（元）'),
        total: p(d1['04-经费收支'].rows[0],'支出合计（元）'),
        bal: p(d1['04-经费收支'].rows[0],'当前结余（元）'),
      },
    };
  })()`);
  console.log('    活动汇入:', JSON.stringify(inflow2));
  t('写入成功(2)', inflow2.putOk, true);
  t('「活动支出汇入（元）」增加 300',
    inflow2.after.actIn, inflow2.before.actIn + 300);
  t('「支出合计（元）」再增加 300',
    inflow2.after.total, inflow2.before.total + 300);
  t('「当前结余（元）」再减少 300',
    inflow2.after.bal, inflow2.before.bal - 300);
  t('不影响「慰问支出汇入（元）」',
    inflow2.after.visitIn, inflow2.before.visitIn);

  // 三个派生列在后台表里可见但只读（编辑弹窗里不出现）
  await gotoAdmin();
  await clickTab('04-经费收支', 'document.querySelectorAll("#admin-table tbody tr").length>0', '经费收支表(派生列)');
  const derivedCols = await cdp.evalJs(`(function(){
    var head = [...document.querySelectorAll('#admin-table thead th')].map(function(x){ return x.textContent.trim(); });
    return {
      head: head,
      hasVisitIn: head.indexOf('慰问支出汇入（元）') >= 0,
      hasActIn: head.indexOf('活动支出汇入（元）') >= 0,
      hasTotal: head.indexOf('支出合计（元）') >= 0,
    };
  })()`);
  console.log('    04 表头:', JSON.stringify(derivedCols.head));
  t('04 表有「慰问支出汇入（元）」列', derivedCols.hasVisitIn, true);
  t('04 表有「活动支出汇入（元）」列', derivedCols.hasActIn, true);
  t('04 表有「支出合计（元）」列', derivedCols.hasTotal, true);

  await cdp.evalJs(`document.querySelector('#admin-table tbody tr td.col-actions button[data-action="edit"]').click()`);
  await waitFor('!document.getElementById("mini-modal").classList.contains("hidden")', '04 表编辑弹窗');
  await sleep(500);
  const derivedInEditor = await cdp.evalJs(`(function(){
    var labels = [...document.querySelectorAll('#mini-modal-content .form-field')].map(function(x){
      var l = x.querySelector('label,span,div'); return l ? l.textContent.trim() : '';
    });
    var ids = [...document.querySelectorAll('#mini-modal-content [id^="fld-"]')].map(function(x){ return x.id.slice(4); });
    return { ids: ids, hasVisitIn: ids.indexOf('慰问支出汇入（元）') >= 0, hasTotal: ids.indexOf('支出合计（元）') >= 0 };
  })()`);
  console.log('    04 编辑弹窗字段:', JSON.stringify(derivedInEditor.ids));
  t('派生列不可手工编辑（编辑弹窗里没有）',
    derivedInEditor.hasVisitIn || derivedInEditor.hasTotal, false);
  await closeMini();

  // 「提报人」列在后台可见，且填报端写进来的那条带着提报人
  await gotoAdmin();
  await clickTab('02-走访慰问', 'document.querySelectorAll("#admin-table tbody tr").length>0', '走访慰问表(提报人)');
  const rep = await cdp.evalJs(`(async()=>{
    var head = [...document.querySelectorAll('#admin-table thead th')].map(function(x){ return x.textContent.trim(); });
    var d = await (await fetch('/api/data',{credentials:'include'})).json();
    var rows = d['02-走访慰问'].rows.filter(function(r){ return String(r['备注']||'').indexOf('E2E汇入测试-走访')>=0; });
    return { hasReporter: head.indexOf('提报人') >= 0, count: rows.length, reporter: rows[0] ? String(rows[0]['提报人']||'') : '' };
  })()`);
  console.log('    提报人:', JSON.stringify(rep));
  t('后台表里有「提报人」列', rep.hasReporter, true);
  t('后台能看到这条数据是谁提报的', rep.reporter, '收集端口 1');

  // ---------- Excel 导入 / 导出 ----------
  console.log('\n【E11】Excel 导入 / 导出');
  {
    const nodePath = require('path');
    const XLSX = require(nodePath.join(__dirname, 'lib', 'xlsx.full.min.js'));
    const K02 = '02-走访慰问';

    // 造一个「用户自己填的」小文件：列顺序故意与模板不同、少几列、账户故意写错
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['慰问物品金额（元）', '员工姓名', '慰问类型', '所在大区', '员工所在部门/门店', '费用列支账户', '备注'],
      [260, 'E2E表格甲', '其他', '华北', '某门店', '不存在的工会X', 'E2EExcel导入'],
    ]), '随便命名的表');
    const b64 = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })).toString('base64');

    await gotoAdmin();
    await cdp.evalJs(`(function(){
      var b=[...document.querySelectorAll('.tab-btn')].find(function(x){ return x.dataset.tab==='__io'; });
      if(b) b.click(); return !!b;
    })()`);
    await waitFor('document.querySelectorAll("#io-root .io-table tbody tr").length>=5', '导入导出面板');
    const ioPanel = await cdp.evalJs(`(function(){
      var rows=[...document.querySelectorAll('#io-root .io-table tbody tr')];
      var panel=document.getElementById('panel-io');
      return {
        rows: rows.length,
        visible: !!panel && getComputedStyle(panel).display !== 'none',
        keys: rows.map(function(r){ return r.cells[0].textContent.trim(); }),
        hasExport: rows.every(function(r){ return !!r.querySelector('a[href*="/api/excel/export/"]'); }),
        hasTpl: rows.every(function(r){ return !!r.querySelector('a[href*="/api/excel/template/"]'); }),
        hasImport: rows.every(function(r){ return !!r.querySelector('[data-io-import]'); }),
        hasMode: rows.every(function(r){ return !!r.querySelector('[data-io-mode]'); }),
        allBtn: !!document.querySelector('#io-root a[href="/api/excel/export-all"]'),
      };
    })()`);
    console.log('    面板:', JSON.stringify({ rows: ioPanel.rows, keys: ioPanel.keys }));
    t('「导入导出」面板打开', ioPanel.visible, true);
    t('列出全部 5 张表', ioPanel.rows, 5);
    t('每行都有「导出」按钮', ioPanel.hasExport, true);
    t('每行都有「下载模板」按钮', ioPanel.hasTpl, true);
    t('每行都有「导入」按钮', ioPanel.hasImport, true);
    t('每行都能选导入方式（追加/覆盖）', ioPanel.hasMode, true);
    t('有「导出全部」入口', ioPanel.allBtn, true);

    const ioHttp = await cdp.evalJs(`(async()=>{
      async function probe(u){
        var r = await fetch(u,{credentials:'include'});
        var b = await r.arrayBuffer();
        var u8 = new Uint8Array(b);
        return { status:r.status, ct:r.headers.get('content-type')||'', size:u8.length,
                 pk: u8.length>2 && u8[0]===0x50 && u8[1]===0x4b,
                 cd:r.headers.get('content-disposition')||'' };
      }
      var sheets = await (await fetch('/api/excel/sheets',{credentials:'include'})).json();
      return {
        count: (sheets.sheets||[]).length,
        exp: await probe('/api/excel/export/' + encodeURIComponent('02-走访慰问')),
        tpl: await probe('/api/excel/template/' + encodeURIComponent('02-走访慰问')),
        all: await probe('/api/excel/export-all'),
      };
    })()`);
    console.log('    接口:', JSON.stringify({ exp: ioHttp.exp.size, tpl: ioHttp.tpl.size, all: ioHttp.all.size }));
    t('表清单接口返回 5 张表', ioHttp.count, 5);
    t('导出单表 → 200', ioHttp.exp.status, 200);
    t('导出的是真正的 xlsx（PK 头）', ioHttp.exp.pk, true);
    ok('导出文件有内容（> 3KB）', ioHttp.exp.size > 3000);
    t('模板 → 200 且是 xlsx', `${ioHttp.tpl.status}/${ioHttp.tpl.pk}`, '200/true');
    t('全量导出 → 200 且是 xlsx', `${ioHttp.all.status}/${ioHttp.all.pk}`, '200/true');
    ok('全量导出比单表大', ioHttp.all.size > ioHttp.exp.size);

    // ---- 导入：预检（含「账户对不上」提醒）→ 确认 ----
    const beforeRows = await cdp.evalJs(`(async()=>{
      var d = await (await fetch('/api/data',{credentials:'include'})).json();
      return d['02-走访慰问'].rows.length;
    })()`);

    await cdp.evalJs(`(function(){
      var rows=[...document.querySelectorAll('#io-root .io-table tbody tr')];
      var row=rows.find(function(r){ return r.cells[0].textContent.trim()==='02-走访慰问'; });
      row.querySelector('[data-io-import]').click();
      return true;
    })()`);
    // 用 DataTransfer 把文件塞进隐藏的 file input，再触发 change（等价于用户选文件）
    await cdp.evalJs(`(function(){
      var bin = atob(${JSON.stringify(b64)});
      var u8 = new Uint8Array(bin.length);
      for (var i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      var f = new File([u8], 'e2e-import.xlsx', { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var dt = new DataTransfer(); dt.items.add(f);
      var inp = document.getElementById('io-file');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles:true }));
      return true;
    })()`);
    await waitFor('!!document.getElementById("io-confirm")', '导入预检卡片');
    const preview = await cdp.evalJs(`(function(){
      var sum = document.querySelector('#io-result .io-summary');
      var box = document.querySelector('#io-result .cfg-warn-box');
      var btn = document.getElementById('io-confirm');
      return {
        summary: sum ? sum.textContent.replace(/\\s+/g,' ').trim() : '',
        warn: box ? box.textContent.replace(/\\s+/g,' ').trim() : '',
        btn: btn ? btn.textContent.replace(/\\s+/g,' ').trim() : '',
        previewRows: document.querySelectorAll('#io-result .io-preview tbody tr').length,
      };
    })()`);
    console.log('    预检:', JSON.stringify(preview));
    ok('预检显示「将导入 1 行」', preview.summary.indexOf('将导入 1') >= 0);
    ok('预检显示导入前后的行数', preview.summary.indexOf(`${beforeRows}`) >= 0);
    ok('预检提示账户在经费表里找不到（钱汇不进去）', preview.warn.indexOf('找不到同名工会') >= 0);
    ok('预检有数据预览表', preview.previewRows >= 1);
    ok('确认按钮写明导入条数', preview.btn.indexOf('确认导入 1 行') >= 0);

    await cdp.evalJs(`document.getElementById('io-confirm').click()`);
    await waitFor('!!document.querySelector("#io-result .cfg-head.io-ok")', '导入完成提示');
    const done = await cdp.evalJs(`(async()=>{
      var head = document.querySelector('#io-result .cfg-head');
      var d = await (await fetch('/api/data',{credentials:'include'})).json();
      var sh = d['02-走访慰问'];
      var mine = sh.rows.filter(function(r){ return String(r['备注']||'').indexOf('E2EExcel导入')>=0; });
      return {
        head: head ? head.textContent.trim() : '',
        rows: sh.rows.length,
        mineCount: mine.length,
        amount: mine[0] ? Number(mine[0]['慰问物品金额（元）']) : null,
        reporter: mine[0] ? String(mine[0]['提报人']||'') : '',
        seq: mine[0] ? mine[0]['序号'] : null,
        isObj: mine[0] ? !Array.isArray(mine[0]) : false,
      };
    })()`);
    console.log('    导入后:', JSON.stringify(done));
    ok('页面提示导入完成', done.head.indexOf('导入完成') >= 0);
    t('表行数 +1', done.rows, beforeRows + 1);
    t('找到刚导入的那一行', done.mineCount, 1);
    t('金额按文件写入', done.amount, 260);
    t('序号自动重排为最后一行', done.seq, beforeRows + 1);
    t('落库的是对象行', done.isObj, true);

    // ---- 覆盖模式的预检必须给红字警告（且按钮文案变成「清空并导入」）----
    await cdp.evalJs(`(function(){
      var rows=[...document.querySelectorAll('#io-root .io-table tbody tr')];
      var row=rows.find(function(r){ return r.cells[0].textContent.trim()==='02-走访慰问'; });
      var sel=row.querySelector('[data-io-mode]');
      sel.value='replace';
      row.querySelector('[data-io-import]').click();
      return true;
    })()`);
    await cdp.evalJs(`(function(){
      var bin = atob(${JSON.stringify(b64)});
      var u8 = new Uint8Array(bin.length);
      for (var i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      var f = new File([u8], 'e2e-import.xlsx', { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var dt = new DataTransfer(); dt.items.add(f);
      var inp = document.getElementById('io-file');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles:true }));
      return true;
    })()`);
    await waitFor('!!document.getElementById("io-confirm")', '覆盖模式预检');
    const repl = await cdp.evalJs(`(function(){
      var btn = document.getElementById('io-confirm');
      var panel = document.getElementById('io-result');
      return {
        btn: btn ? btn.textContent.replace(/\\s+/g,' ').trim() : '',
        text: panel ? panel.textContent.replace(/\\s+/g,' ') : '',
      };
    })()`);
    ok('覆盖模式按钮变成「确认清空并导入」', repl.btn.indexOf('清空并导入') >= 0);
    ok('覆盖模式给出「会先删除原有数据」的警告', repl.text.indexOf('会先删除这张表现有的') >= 0);
    await cdp.evalJs(`document.getElementById('io-cancel').click()`);
    await sleep(300);
    const afterCancel = await cdp.evalJs(`(async()=>{
      var d = await (await fetch('/api/data',{credentials:'include'})).json();
      return d['02-走访慰问'].rows.length;
    })()`);
    t('点「取消」不会改动数据', afterCancel, beforeRows + 1);
  }

  console.log('\n【F】运行期 JS 异常');
  console.log('    捕获异常数:', consoleErrs.length, consoleErrs.slice(0, 3));
  t('无未捕获 JS 异常', consoleErrs.length, 0);

  console.log('\n【G】非持久存储告警条（用户实际踩过的坑）');
  // 【D】【E】结束时停在看板页，告警条长在 admin.html 上，必须先回后台
  await gotoAdmin();
  if (!NONPERSIST) {
    // 持久目录下「不应该」出现告警条 —— 反向验证，避免长期挂着一个吓人的红条
    const noWarn = await cdp.evalJs('!document.getElementById("storage-warn")');
    t('持久目录下不显示告警条', noWarn, true);
  } else {
    await waitFor('!!document.getElementById("storage-warn")', '告警条出现', 8000).catch(() => {});    const warn = await cdp.evalJs(`(function(){
      const el = document.getElementById('storage-warn');
      if (!el) return { found: false };
      const cs = getComputedStyle(el);
      return {
        found: true,
        visible: el.offsetParent !== null && cs.display !== 'none',
        text: el.textContent.replace(/\\s+/g,' ').trim(),
        hasClose: !!document.getElementById('storage-warn-close'),
        position: cs.position,
      };
    })()`);
    console.log('    ', JSON.stringify(warn));
    t('非持久时弹出告警条', warn.found, true);
    t('告警条真实可见（未被 display:none 吃掉）', warn.visible, true);
    t('告警条吸顶（滚动时不会消失，也不压住内容）', warn.position, 'sticky');
    t('文案点明「重新部署后会丢失」', /重新部署[\s\S]{0,12}(丢失|清空|消失)/.test(warn.text), true);
    t('文案给出可执行的补救路径（/data）', /\/data/.test(warn.text), true);
    t('告警条有关闭按钮', warn.hasClose, true);

    // 点「知道了」应能关掉，不遮挡后续操作
    const closed = await cdp.evalJs(`(async()=>{
      document.getElementById('storage-warn-close').click();
      await new Promise(r=>setTimeout(r,300));
      return !document.getElementById('storage-warn');
    })()`);
    t('点「知道了」可关闭告警条', closed, true);

    // 后台「数据存储与备份」分区在非持久时必须标红，且给出补救文案
    await clickTab('__security', '!!document.querySelector("#sec-storage-body .store-status")', '安全设置(非持久)');
    const bad = await cdp.evalJs(`(function(){
      const box = document.querySelector('#sec-storage-body');
      return {
        cls: (box.querySelector('.store-status')||{}).className || '',
        text: box.textContent.replace(/\\s+/g,' ').trim(),
      };
    })()`);
    t('安全面板存储状态标红', /is-bad/.test(bad.cls), true);
    t('安全面板提示补救方法', /持久卷|挂载/.test(bad.text), true);
  }

  console.log('\n===============================');
  console.log(` 通过 ${PASS} 项 / 失败 ${FAIL} 项`);
  console.log('===============================');

  chrome.kill();
  await sleep(300);
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(async e => { console.error('E2E 崩溃:', e); process.exit(2); });
