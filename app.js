/* ===== 数据看板交互脚本 ===== */

// 数据从 DashboardStore 加载
let DATA = null;
let charts = {}; // 全局图表实例

// 主题色
const COMMON_AXIS = {
  axisLine: { lineStyle: { color: 'rgba(77,216,255,0.3)' } },
  axisLabel: { color: '#7E93BD' },
  splitLine: { lineStyle: { color: 'rgba(77,216,255,0.08)' } },
};
const COMMON_TOOLTIP = {
  backgroundColor: 'rgba(20, 34, 74, 0.95)',
  borderColor: 'rgba(77, 216, 255, 0.4)',
  borderWidth: 1,
  textStyle: { color: '#E6EEFF' },
  extraCssText: 'box-shadow: 0 4px 18px rgba(0,0,0,0.4);',
};

// 派生指标：从数据动态计算
function computeMetrics() {
  if (!DATA) return null;
  const org = DATA['01-组织建设'].rows;
  const visit = DATA['02-走访慰问'].rows;
  const act = DATA['03-员工活动'].rows;
  const fund = DATA['04-经费收支'].rows;

  // 组织建设
  const orgTotal = org.length;
  const orgEstablished = org.filter(r => r[5] === '已组建').length;
  const orgPreparing = org.filter(r => r[5] === '筹建中').length;
  const orgByLevel = {};
  org.forEach(r => {
    const level = r[6];
    const status = r[5];
    orgByLevel[level] = orgByLevel[level] || { 已组建: 0, 筹建中: 0 };
    if (status === '已组建' || status === '筹建中') orgByLevel[level][status]++;
  });

  // 走访慰问
  const visitTypes = {};
  visit.forEach(r => {
    const t = r[1] || '其他';
    visitTypes[t] = (visitTypes[t] || 0) + 1;
  });
  const visitAreas = {};
  visit.forEach(r => {
    const a = r[3] || '其他';
    visitAreas[a] = (visitAreas[a] || 0) + 1;
  });
  const visitTotal = visit.length;
  const visitAmount = visit.reduce((s, r) => s + (Number(r[6]) || 0), 0);

  // 员工活动
  const actTotal = act.length;
  const actCoverage = act.reduce((s, r) => s + (Number(r[7]) || 0), 0);
  const actSpend = act.reduce((s, r) => s + (Number(r[8]) || 0), 0);
  const actForms = {};
  act.forEach(r => { const f = r[3] || ''; actForms[f] = (actForms[f] || 0) + 1; });
  const actTypes = {};
  act.forEach(r => { const t = r[4] || ''; actTypes[t] = (actTypes[t] || 0) + 1; });

  // 经费
  const fundInitial = fund.reduce((s, r) => s + (Number(r[6]) || 0), 0);
  const fundSpend = fund.reduce((s, r) => s + (Number(r[7]) || 0), 0);
  const fundBalance = fund.reduce((s, r) => s + (Number(r[9]) || 0), 0);
  const fundList = fund.map(r => ({
    name: r[2],
    balance: Number(r[9]) || 0,
  }));

  return {
    org: { total: orgTotal, established: orgEstablished, preparing: orgPreparing, byLevel: orgByLevel },
    visit: { total: visitTotal, amount: visitAmount, types: visitTypes, areas: visitAreas },
    act: { total: actTotal, coverage: actCoverage, spend: actSpend, forms: actForms, types: actTypes },
    fund: { initial: fundInitial / 10000, spend: fundSpend / 10000, balance: fundBalance, list: fundList },
  };
}

// 数字格式化（保留 2 位小数，去尾 0）
function fmtNum(n, digits = 2) {
  if (typeof n !== 'number') return n;
  return Number(n.toFixed(digits)).toString();
}

// 更新看板 DOM
function renderDashboard() {
  const m = computeMetrics();
  if (!m) return;

  // 组织建设
  document.querySelectorAll('[data-metric="org-total"]').forEach(el => el.textContent = m.org.total);
  document.querySelectorAll('[data-metric="org-established"]').forEach(el => el.textContent = m.org.established);
  document.querySelectorAll('[data-metric="org-preparing"]').forEach(el => el.textContent = m.org.preparing);

  // 走访
  document.querySelectorAll('[data-metric="visit-total"]').forEach(el => el.textContent = m.visit.total);
  document.querySelectorAll('[data-metric="visit-amount"]').forEach(el => el.textContent = fmtNum(m.visit.amount, 0));

  // 活动
  document.querySelectorAll('[data-metric="act-total"]').forEach(el => el.textContent = m.act.total);
  document.querySelectorAll('[data-metric="act-coverage"]').forEach(el => el.textContent = m.act.coverage);
  document.querySelectorAll('[data-metric="act-spend"]').forEach(el => el.textContent = fmtNum(m.act.spend, 0));

  // 经费
  document.querySelectorAll('[data-metric="fund-initial"]').forEach(el => el.textContent = fmtNum(m.fund.initial, 2));
  document.querySelectorAll('[data-metric="fund-spend"]').forEach(el => el.textContent = fmtNum(m.fund.spend, 2));
  document.querySelectorAll('[data-metric="fund-balance"]').forEach(el => el.textContent = fmtNum(m.fund.balance, 2));

  // 渲染图表
  renderOrgPie(m);
  renderVisitChart(m);
  renderActChart(m);
  renderFundChart(m);
}

// 组织建设饼图
function renderOrgPie(m) {
  const el = document.getElementById('chart-org-pie');
  if (!el) return;
  if (!charts.orgPie) charts.orgPie = echarts.init(el);
  charts.orgPie.setOption({
    tooltip: { ...COMMON_TOOLTIP, trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#E6EEFF', fontSize: 12 }, itemWidth: 14, itemHeight: 14 },
    series: [{
      type: 'pie',
      radius: ['38%', '65%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#0E1A35', borderWidth: 2 },
      label: { color: '#E6EEFF', fontSize: 13 },
      labelLine: { lineStyle: { color: '#4DD8FF' } },
      data: [
        { value: m.org.established, name: '已组建', itemStyle: { color: '#4DD8FF' } },
        { value: m.org.preparing, name: '筹建中', itemStyle: { color: '#F59E0B' } },
      ],
    }],
  }, true);
}

// 走访柱状图
const VISIT_TYPE_SHORT = {
  '员工直系亲属重大疾病': '直系亲属\n重大疾病',
  '员工本人重大疾病': '员工本人\n重大疾病',
};
function renderVisitChart(m) {
  const el = document.getElementById('chart-visit-type');
  if (!el) return;
  if (!charts.visit) charts.visit = echarts.init(el);
  const items = Object.entries(m.visit.types);
  const labelFmt = (v) => {
    if (VISIT_TYPE_SHORT[v]) return VISIT_TYPE_SHORT[v];
    if (v.length > 6) return v.slice(0, 6) + '\n' + v.slice(6);
    return v;
  };
  charts.visit.setOption({
    tooltip: { ...COMMON_TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 50, right: 30, top: 30, bottom: 55 },
    xAxis: { type: 'category', data: items.map(([k]) => k), ...COMMON_AXIS, axisLabel: { color: '#7E93BD', fontSize: 12, interval: 0, lineHeight: 15, formatter: labelFmt } },
    yAxis: { type: 'value', ...COMMON_AXIS },
    series: [{
      type: 'bar',
      data: items.map(([, v], i) => ({
        value: v,
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: ['#4DD8FF', '#5FE0FF', '#A78BFA'][i % 3] }, { offset: 1, color: '#1E40AF' }]) },
      })),
      label: { show: true, position: 'top', color: '#4DD8FF', fontWeight: 700, fontSize: 14 },
      barWidth: 50,
    }],
  }, true);
}

// 活动类型饼图
function renderActChart(m) {
  const el = document.getElementById('chart-activity-type');
  if (!el) return;
  if (!charts.act) charts.act = echarts.init(el);
  const colors = ['#4DD8FF', '#5FE0FF', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];
  const items = Object.entries(m.act.types);
  charts.act.setOption({
    tooltip: { ...COMMON_TOOLTIP, trigger: 'item', formatter: '{b}: {c} 场 ({d}%)' },
    legend: { bottom: 0, textStyle: { color: '#E6EEFF', fontSize: 11 }, itemWidth: 12, itemHeight: 12 },
    series: [{
      type: 'pie',
      radius: ['38%', '65%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#0E1A35', borderWidth: 2 },
      label: { color: '#E6EEFF', fontSize: 12 },
      data: items.map(([k, v], i) => ({ value: v, name: k, itemStyle: { color: colors[i % colors.length] } })),
    }],
  }, true);
}

// 经费柱状图
function renderFundChart(m) {
  const el = document.getElementById('chart-fund-bar');
  if (!el) return;
  if (!charts.fund) charts.fund = echarts.init(el);
  charts.fund.setOption({
    tooltip: { ...COMMON_TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p) => `${p[0].name}<br/>结余：${p[0].value} 万元` },
    grid: { left: 40, right: 30, top: 30, bottom: 80 },
    xAxis: { type: 'category', data: m.fund.list.map(l => l.name), ...COMMON_AXIS, axisLabel: { color: '#7E93BD', fontSize: 11, rotate: 20 } },
    yAxis: { type: 'value', name: '万元', nameTextStyle: { color: '#7E93BD' }, ...COMMON_AXIS },
    series: [{
      type: 'bar',
      data: m.fund.list.map(l => ({
        value: l.balance,
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#4DD8FF' }, { offset: 1, color: '#1E40AF' }]) },
      })),
      label: { show: true, position: 'top', color: '#4DD8FF', fontWeight: 700, fontSize: 12, formatter: (p) => Number(p.value.toFixed(2)) },
      barWidth: 36,
    }],
  }, true);
}

// 渲染表格（用于模块二的走访负责人表格 + 模块三的活动形式表格）
function renderTables() {
  const m = computeMetrics();
  if (!m) return;

  // 走访负责人表格
  const visitTbody = document.querySelector('#visit-areas-tbody');
  if (visitTbody) {
    visitTbody.innerHTML = '';
    Object.entries(m.visit.areas)
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, count]) => {
        const tr = document.createElement('tr');
        tr.className = 'clickable';
        tr.dataset.detail = '02-走访慰问';
        tr.dataset.filter = JSON.stringify({ key: '所在大区', value: name });
        tr.innerHTML = `
          <td>${escapeHtml(name)}</td>
          <td class="cell-value">${count}</td>
          <td class="cell-value">0</td>`;
        visitTbody.appendChild(tr);
      });
  }

  // 活动形式表格
  const actFormTbody = document.querySelector('#act-forms-tbody');
  if (actFormTbody) {
    actFormTbody.innerHTML = '';
    Object.entries(m.act.forms).forEach(([name, count]) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.detail = '03-员工活动';
      tr.dataset.filter = JSON.stringify({ key: '活动形式', value: name });
      tr.innerHTML = `
        <td>${escapeHtml(name)}</td>
        <td class="cell-value">${count}</td>`;
      actFormTbody.appendChild(tr);
    });
  }

  // 工会级别 × 组建状态表格
  const orgTbody = document.querySelector('#org-level-tbody');
  if (orgTbody) {
    orgTbody.innerHTML = '';
    const levels = ['一级工会', '二级工会', '三级工会'];
    levels.forEach(level => {
      const stat = m.org.byLevel[level] || { 已组建: 0, 筹建中: 0 };
      const total = stat.已组建 + stat.筹建中;
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.dataset.detail = '01-组织建设';
      tr.dataset.filter = JSON.stringify({ key: '工会级别', value: level });
      tr.innerHTML = `
        <td>${escapeHtml(level)}</td>
        <td class="cell-value">${stat.已组建}</td>
        <td class="cell-value">${stat.筹建中}</td>
        <td class="cell-value">${total}</td>`;
      orgTbody.appendChild(tr);
    });
    // 合计行
    const totalTr = document.createElement('tr');
    totalTr.className = 'row-total';
    totalTr.innerHTML = `
      <td>合计</td>
      <td class="cell-value">${m.org.established}</td>
      <td class="cell-value">${m.org.preparing}</td>
      <td class="cell-value">${m.org.total}</td>`;
    orgTbody.appendChild(totalTr);
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 4. 模态层
function openDetail(sheetKey, filterRaw) {
  if (!DATA) return;
  const data = DATA[sheetKey];
  if (!data) return;
  let filter = null;
  try { filter = filterRaw ? JSON.parse(filterRaw) : null; } catch (e) {}

  const modal = document.getElementById('detail-modal');
  const title = document.getElementById('modal-title');
  const subtitle = document.getElementById('modal-subtitle');
  const body = document.getElementById('modal-body');
  const search = document.getElementById('modal-search');

  title.textContent = data.title;
  subtitle.innerHTML = escapeHtml(data.subtitle) + (filter ? `<span class="filter-tag">筛选：${escapeHtml(filter.key)} = "${escapeHtml(filter.value)}"</span>` : '');

  const rows = data.rows.slice();
  const colCount = data.headers.length;

  function renderTable(filteredRows) {
    const html = ['<table class="detail-table"><thead><tr>'];
    data.headers.forEach(h => html.push(`<th>${escapeHtml(h)}</th>`));
    html.push('</tr></thead><tbody>');
    filteredRows.forEach(r => {
      html.push('<tr>');
      for (let i = 0; i < colCount; i++) {
        const v = r[i];
        const isEmpty = v === '' || v === null || v === undefined;
        const isNum = typeof v === 'number';
        const isLongText = typeof v === 'string' && v.length > 30;
        const cls = isEmpty ? 'empty-cell' : isNum ? 'cell-number' : isLongText ? 'cell-text' : '';
        const display = isEmpty ? '—' : escapeHtml(v);
        html.push(`<td class="${cls}">${display}</td>`);
      }
      html.push('</tr>');
    });
    if (filteredRows.length === 0) {
      html.push(`<tr><td colspan="${colCount}" style="text-align:center; padding:32px; color:#7E93BD">暂无数据</td></tr>`);
    }
    html.push('</tbody></table>');
    body.innerHTML = html.join('');
  }

  function applyFilters() {
    let result = rows;
    if (filter) {
      const keyIdx = data.headers.indexOf(filter.key);
      if (keyIdx >= 0) result = result.filter(r => String(r[keyIdx]) === filter.value);
    }
    const q = (search.value || '').trim().toLowerCase();
    if (q) {
      result = result.filter(r => r.some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q)));
    }
    renderTable(result);
  }

  applyFilters();
  search.value = '';
  search.oninput = applyFilters;
  modal.classList.remove('hidden');
}

function closeDetail() {
  document.getElementById('detail-modal').classList.add('hidden');
}

// 5. 事件绑定
function bindEvents() {
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-detail]');
    if (!target) {
      if (e.target.id === 'detail-modal') closeDetail();
      return;
    }
    openDetail(target.dataset.detail, target.dataset.filter);
  });
  document.getElementById('modal-close').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });
}

// 6. 启动
async function boot() {
  await DashboardStore.load();
  DATA = DashboardStore.getData();
  bindEvents();
  renderDashboard();
  renderTables();
  refreshSyncBadge();

  // 监听 store 更新（自己改、SSE 推送、跨 tab 都会触发）
  DashboardStore.subscribe((_d, info) => {
    // 仅状态变化（SSE 连上/断开）时只刷新徽章，避免无谓重绘
    if (info && info.statusOnly) { refreshSyncBadge(); return; }
    DATA = DashboardStore.getData();
    renderDashboard();
    renderTables();
    refreshSyncBadge();
    if (info && info.source === 'remote') {
      flashHint('已收到云端最新数据，自动刷新');
    }
  });

  // 定时刷新连接状态指示器
  setInterval(refreshSyncBadge, 5000);

  // 响应式
  window.addEventListener('resize', () => {
    Object.values(charts).forEach(c => c && c.resize());
  });
}

function refreshSyncBadge() {
  const el = document.getElementById('sync-badge');
  if (!el || !window.DashboardStore) return;
  const status = DashboardStore.getStatus();
  el.classList.toggle('api', status.mode === 'api');
  el.classList.toggle('local', status.mode === 'local');
  el.classList.toggle('disconnected', status.mode === 'api' && !status.connected);
  const tag = el.querySelector('.sync-tag');
  if (tag) tag.textContent = status.mode === 'api' ? '云端共享' : '本地存储';
  const txt = el.querySelector('.sync-text');
  if (txt) {
    if (status.mode === 'api' && !status.connected) txt.textContent = '已断线，正在重连…';
    else if (status.lastSync) {
      const t = new Date(status.lastSync);
      const pad = n => String(n).padStart(2, '0');
      txt.textContent = `已同步 · ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    } else {
      txt.textContent = '已就绪';
    }
  }
}

let _hintTimer = null;
function flashHint(text) {
  const el = document.getElementById('sync-badge');
  if (!el) return;
  const hint = document.createElement('div');
  hint.className = 'sync-flash';
  hint.textContent = text;
  el.appendChild(hint);
  setTimeout(() => hint.classList.add('show'), 10);
  clearTimeout(_hintTimer);
  _hintTimer = setTimeout(() => {
    hint.classList.remove('show');
    setTimeout(() => hint.remove(), 400);
  }, 2400);
}

document.addEventListener('DOMContentLoaded', boot);
