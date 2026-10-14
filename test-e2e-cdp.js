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

  t('模块内列宽栅格正确 (span 5/7, 6/6, 12/6/6, 12/12)',
    await cdp.evalJs(`[...document.querySelectorAll("#modules-root .mod-col")].map(c=>c.style.gridColumn)`),
    ['span 5', 'span 7', 'span 6', 'span 6', 'span 12', 'span 6', 'span 6', 'span 12', 'span 12']);

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
  t('图表块 4 个且 ECharts 已绘制 canvas',
    await cdp.evalJs('[...document.querySelectorAll("#modules-root canvas")].length'), 4);

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
    return {
      panelVisible: !document.getElementById('panel-config').classList.contains('hidden'),
      dataHidden: document.getElementById('panel-data').classList.contains('hidden'),
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
  t('看板配置面板已显示', cfgCounts.panelVisible, true);
  t('数据管理面板已隐藏', cfgCounts.dataHidden, true);
  t('配置面板 8 个分区', cfgCounts.sectionCount, 8);
  t('分区标题 = ①~⑧', cfgCounts.sectionTitles.map(s => s.slice(0, 1)),
    ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧']);
  t('指标编辑行 = 13', cfgCounts.metricRows, 13);
  t('图表编辑行 = 4', cfgCounts.chartRows, 4);
  t('统计表编辑行 = 3', cfgCounts.tableRows, 3);
  t('模块卡片 = 4', cfgCounts.modCards, 4);
  t('列卡片 = 9', cfgCounts.colCards, 9);
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
    return {
      visible: !document.getElementById('panel-security').classList.contains('hidden'),
      heads,
      pwInputs: document.querySelectorAll('#panel-security input[type="password"]').length,
      submitBtns: document.querySelectorAll('#panel-security button').length,
      bodyLen: document.getElementById('panel-security').innerHTML.length,
    };
  })()`);
  console.log('    安全面板:', JSON.stringify(secInfo, null, 1));
  t('安全设置面板已显示', secInfo.visible, true);
  t('含「当前登录状态」', secInfo.heads.some(s => /登录状态/.test(s)), true);
  t('含「修改看板密码」', secInfo.heads.some(s => /看板.*密码/.test(s)), true);
  t('含「修改后台密码」', secInfo.heads.some(s => /后台.*密码/.test(s)), true);
  t('密码输入框 ≥ 4 个', secInfo.pwInputs >= 4, true);

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

  console.log('\n【F】运行期 JS 异常');
  console.log('    捕获异常数:', consoleErrs.length, consoleErrs.slice(0, 3));
  t('无未捕获 JS 异常', consoleErrs.length, 0);

  console.log('\n===============================');
  console.log(` 通过 ${PASS} 项 / 失败 ${FAIL} 项`);
  console.log('===============================');

  chrome.kill();
  await sleep(300);
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(async e => { console.error('E2E 崩溃:', e); process.exit(2); });
