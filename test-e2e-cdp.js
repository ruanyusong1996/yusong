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

  t('模块内列宽栅格正确 (span 5/7, 6/6, 12/6/6, 12/12/12)',
    await cdp.evalJs(`[...document.querySelectorAll("#modules-root .mod-col")].map(c=>c.style.gridColumn)`),
    ['span 5', 'span 7', 'span 6', 'span 6', 'span 12', 'span 6', 'span 6', 'span 12', 'span 12', 'span 12']);

  t('指标卡片总数 = 13',
    await cdp.evalJs('document.querySelectorAll("#modules-root [data-metric]").length'), 13);

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
  t('活动覆盖人次 = 2138', metricVals['act-coverage'], '2138');
  t('当前结余(2位小数) = 66.75', metricVals['fund-balance'], '66.75');
  t('★公式指标 组建完成率 = 65.0%', metricVals['org-rate'], '65.0');
  t('★公式指标 平均每会结余 = 3.34 万元', metricVals['fund-per-org'], '3.34');

  // 图表
  // 4 张普通图 + v1.3 新增的瀑布（桥梁）图
  t('图表块 5 个且 ECharts 已绘制 canvas',
    await cdp.evalJs('[...document.querySelectorAll("#modules-root canvas")].length'), 5);

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
  t('统计表块 3 个',
    await cdp.evalJs('document.querySelectorAll("#modules-root table.data-table").length'), 3);
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
  t('指标编辑行 = 13', cfgCounts.metricRows, 13);
  t('图表编辑行 = 5（含新增的瀑布图）', cfgCounts.chartRows, 5);
  t('统计表编辑行 = 3', cfgCounts.tableRows, 3);
  t('模块卡片 = 4', cfgCounts.modCards, 4);
  t('列卡片 = 10（经费模块新增了桥梁图那一列）', cfgCounts.colCards, 10);
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
