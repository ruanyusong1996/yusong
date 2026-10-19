/* ===== 数据看板交互脚本（配置驱动） =====
 * 看板长什么样 = 后台「看板配置」里的 config：
 *   文字/标题 · 主题配色 · 模块与栅格布局 · 指标卡片(数据链接+公式) · 图表 · 统计表
 * 数据变化 / 配置变化 → 自动重绘。
 */
'use strict';

let DATA = null;
let CFG = null;
const charts = {};        // blockId -> echarts 实例
let METRICS = {};         // 指标 id -> 数值

const E = window.ConfigEngine;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const theme = () => (CFG && CFG.theme) || {};

const DEFAULT_PALETTE = ['#4DD8FF', '#5FE0FF', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

/**
 * 合法的 CSS 颜色。ECharts 拿到非法颜色会抛
 * "Failed to execute 'addColorStop' on 'CanvasGradient'" 并让整张图渲染不出来，
 * 所以这里必须先把脏值过滤掉。
 */
function isColor(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)
    || /^(rgb|rgba|hsl|hsla)\(\s*[\d.%,\s/]+\)$/i.test(s)
    || /^[a-z]{3,20}$/i.test(s);   // 具名颜色：red / steelblue …
}

/**
 * 把任意来源的色板收敛成「合法颜色数组」。
 * 兼容历史脏数据：曾被后台存成过逗号字符串（"#a,#b"），
 * 直接当数组用会逐字符取色（'#' 不是颜色）→ 全部图表崩掉。
 */
function normalizePalette(raw) {
  let list = raw;
  if (typeof list === 'string') list = list.split(/[,，;；\s]+/);
  if (!Array.isArray(list)) return DEFAULT_PALETTE.slice();
  const clean = list.map(x => (typeof x === 'string' ? x.trim() : x)).filter(isColor);
  return clean.length ? clean : DEFAULT_PALETTE.slice();
}

const palette = () => normalizePalette(theme().palette);
const colorAt = (i) => {
  const p = palette();
  return p[((i % p.length) + p.length) % p.length];
};

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tooltipStyle() {
  const t = theme();
  return {
    backgroundColor: 'rgba(20, 34, 74, 0.95)',
    borderColor: t.accent || '#4DD8FF',
    borderWidth: 1,
    textStyle: { color: t.text || '#E6EEFF' },
    extraCssText: 'box-shadow: 0 4px 18px rgba(0,0,0,0.4);',
  };
}

function axisStyle(rotate) {
  const t = theme();
  return {
    axisLine: { lineStyle: { color: 'rgba(77,216,255,0.3)' } },
    axisLabel: { color: t.muted || '#7E93BD', rotate: rotate || 0 },
    splitLine: { lineStyle: { color: 'rgba(77,216,255,0.08)' } },
  };
}

/** 长标签折行（如「员工直系亲属重大疾病」） */
function wrapLabel(name, max) {
  const s = String(name == null ? '' : name);
  if (!max || s.length <= max) return s;
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 主题注入
// ---------------------------------------------------------------------------
function applyTheme() {
  const t = theme();
  const r = document.documentElement.style;
  const map = {
    '--accent': t.accent, '--accent2': t.accent2, '--bg': t.bg,
    '--card-bg': t.cardBg, '--card-bg2': t.cardBg2, '--card-border': t.cardBorder,
    '--sub-card-bg': t.subCardBg, '--title-bar': t.titleBar,
    '--text': t.text, '--muted': t.muted, '--danger': t.danger,
  };
  Object.keys(map).forEach(k => { if (map[k]) r.setProperty(k, map[k]); });
  const L = (CFG && CFG.layout) || {};
  if (L.maxWidth) r.setProperty('--max-width', L.maxWidth + 'px');
  if (L.moduleGap) r.setProperty('--module-gap', L.moduleGap + 'px');
  if (L.columnGap) r.setProperty('--column-gap', L.columnGap + 'px');
  if (L.cardRadius) r.setProperty('--radius', L.cardRadius + 'px');
}

// ---------------------------------------------------------------------------
// 顶部标题
// ---------------------------------------------------------------------------
function renderHeader() {
  const T = (CFG && CFG.text) || {};
  document.title = T.documentTitle || T.pageTitle || '数据看板';

  const deco = T.titleDeco !== false;
  document.getElementById('header-deco-left').style.display = deco ? '' : 'none';
  document.getElementById('header-deco-right').style.display = deco ? '' : 'none';

  const title = T.pageTitle || '';
  document.getElementById('page-title').textContent = deco ? `━━━━━━\u00a0\u00a0\u00a0${title}\u00a0\u00a0\u00a0━━━━━━` : title;

  const wrap = document.getElementById('page-subtitle');
  wrap.innerHTML = '';
  const items = T.subtitleItems || [];
  items.forEach((it, i) => {
    if (i > 0) {
      const d = document.createElement('span');
      d.className = 'divider';
      d.textContent = '|';
      wrap.appendChild(d);
    }
    let el;
    switch (it.type) {
      case 'adminLink':
        el = document.createElement('a');
        el.className = 'admin-link';
        el.href = './admin.html';
        el.target = '_blank';
        el.textContent = it.text || '后台管理 »';
        break;
      case 'syncBadge':
        el = document.createElement('span');
        el.id = 'sync-badge';
        el.className = 'sync-badge';
        el.innerHTML = '<span class="sync-tag">本地存储</span><span class="sync-text">已就绪</span>';
        break;
      case 'logout':
        el = document.createElement('a');
        el.className = 'logout-link';
        el.href = '#';
        el.textContent = it.text || '退出';
        el.addEventListener('click', async (ev) => {
          ev.preventDefault();
          await DashboardStore.authLogout();
          location.replace('/login.html?role=dashboard');
        });
        break;
      case 'hint':
        el = document.createElement('span');
        el.className = 'highlight';
        el.textContent = it.text || '';
        break;
      default: {
        el = document.createElement('span');
        const txt = String(it.text || '');
        const now = new Date();
        el.textContent = txt.replace(/\{date\}/g, `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`)
          .replace(/\{time\}/g, now.toLocaleTimeString('zh-CN', { hour12: false }));
      }
    }
    wrap.appendChild(el);
  });

  document.getElementById('page-footer').innerHTML = `<p>${escapeHtml((CFG.text || {}).footer || '')}</p>`;
}

// ---------------------------------------------------------------------------
// 结构渲染（模块 → 列 → 块）
// ---------------------------------------------------------------------------
function findChart(id) { return ((CFG && CFG.charts) || []).find(c => c.id === id); }
function findTable(id) { return ((CFG && CFG.tables) || []).find(t => t.id === id); }
function findMetric(id) { return ((CFG && CFG.metrics) || []).find(m => m.id === id); }

function buildMetricsBlock(block) {
  const card = document.createElement('div');
  card.className = 'sub-card';
  if (block.title) {
    const t = document.createElement('div');
    t.className = 'sub-card-title';
    t.textContent = block.title;
    card.appendChild(t);
  }
  const ids = (block.metricIds || []).filter(id => findMetric(id));
  const row = document.createElement('div');
  const isLast = true;
  row.className = 'metric-row ' + (ids.length <= 2 ? 'metric-row-2' : ids.length === 3 ? 'metric-row-3' : ids.length === 4 ? 'metric-row-4' : 'metric-row-auto');
  ids.forEach(id => {
    const m = findMetric(id);
    if (!m || m.visible === false) return;
    const c = document.createElement('div');
    const detail = m.detail && m.detail.sheet;
    c.className = 'metric-card' + (detail ? ' clickable' : '');
    if (detail) {
      c.dataset.detail = m.detail.sheet;
      if (m.detail.filterField) {
        c.dataset.filter = JSON.stringify({ key: m.detail.filterField, value: m.detail.filterValue });
      }
    }
    c.innerHTML = `
      <div class="metric-label">${escapeHtml(m.label || id)}</div>
      <div class="metric-value" data-metric="${escapeHtml(id)}">—</div>
      <div class="metric-unit">${escapeHtml(m.unit || '')}</div>`;
    row.appendChild(c);
  });
  if (row.children.length) card.appendChild(row);
  if (!isLast && row.children.length) row.style.marginBottom = '14px';
  return card;
}

function buildChartBlock(block) {
  const card = document.createElement('div');
  card.className = 'sub-card';
  const def = findChart(block.refId);
  const title = block.title !== undefined && block.title !== '' ? block.title : (def && def.title) || '';
  if (title) {
    const t = document.createElement('div');
    t.className = 'sub-card-title';
    t.textContent = title;
    card.appendChild(t);
  }
  const area = document.createElement('div');
  area.className = 'chart-area';
  area.id = 'chart-' + block.id;
  area.style.height = ((def && def.height) || 220) + 'px';
  card.appendChild(area);
  return card;
}

function buildTableBlock(block) {
  const card = document.createElement('div');
  card.className = 'sub-card';
  const def = findTable(block.refId);
  const title = block.title !== undefined && block.title !== '' ? block.title : (def && def.title) || '';
  if (title) {
    const t = document.createElement('div');
    t.className = 'sub-card-title';
    t.textContent = title;
    card.appendChild(t);
  }
  const wrap = document.createElement('div');
  wrap.id = 'table-' + block.id;
  card.appendChild(wrap);
  return card;
}

function buildNoteBlock(block) {
  const card = document.createElement('div');
  card.className = 'sub-card';
  if (block.title) {
    const t = document.createElement('div');
    t.className = 'sub-card-title';
    t.textContent = block.title;
    card.appendChild(t);
  }
  const p = document.createElement('div');
  p.className = 'note-block';
  p.textContent = block.text || '';
  card.appendChild(p);
  return card;
}

function buildBlock(block) {
  switch (block.type) {
    case 'metrics': return buildMetricsBlock(block);
    case 'chart': return buildChartBlock(block);
    case 'table': return buildTableBlock(block);
    case 'note': return buildNoteBlock(block);
    default: {
      const d = document.createElement('div');
      return d;
    }
  }
}

/** 销毁所有图表实例（结构重建前） */
function disposeCharts() {
  Object.keys(charts).forEach(k => { try { charts[k] && charts[k].dispose(); } catch (_) {} delete charts[k]; });
}

function renderStructure() {
  applyTheme();
  renderHeader();
  disposeCharts();

  const root = document.getElementById('modules-root');
  root.innerHTML = '';

  (CFG.modules || []).filter(m => m.visible !== false).forEach(mod => {
    const sec = document.createElement('section');
    sec.className = 'module';

    const head = document.createElement('div');
    head.className = 'module-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'module-title';
    titleSpan.textContent = mod.title || '';
    head.appendChild(titleSpan);
    if (mod.showDetail !== false && mod.sheet) {
      const btn = document.createElement('button');
      btn.className = 'module-action';
      btn.dataset.detail = mod.sheet;
      btn.textContent = ((CFG.text || {}).detailButtonText) || '查看明细 »';
      head.appendChild(btn);
    }
    sec.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'mod-grid';
    (mod.columns || []).forEach(col => {
      const c = document.createElement('div');
      c.className = 'mod-col';
      c.style.gridColumn = `span ${Math.min(12, Math.max(1, col.width || 12))}`;
      (col.blocks || []).filter(b => b.visible !== false).forEach(b => c.appendChild(buildBlock(b)));
      grid.appendChild(c);
    });
    sec.appendChild(grid);
    root.appendChild(sec);
  });
}

// ---------------------------------------------------------------------------
// 数值渲染
// ---------------------------------------------------------------------------
function fmtByMetric(m, v) {
  if (!m) return String(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const d = typeof m.decimals === 'number' ? m.decimals : 2;
  return d === 0 ? String(Math.round(v)) : v.toFixed(d);
}

function renderValues() {
  if (!DATA || !CFG) return;
  METRICS = E.computeMetrics(DATA, CFG);

  // 指标卡
  document.querySelectorAll('[data-metric]').forEach(el => {
    const id = el.dataset.metric;
    const m = findMetric(id);
    el.textContent = m ? fmtByMetric(m, METRICS[id]) : '—';
  });

  // 图表 / 表格
  (CFG.modules || []).filter(m => m.visible !== false).forEach(mod => {
    (mod.columns || []).forEach(col => {
      (col.blocks || []).filter(b => b.visible !== false).forEach(b => {
        if (b.type === 'chart') renderChartBlock(b);
        else if (b.type === 'table') renderTableBlock(b);
      });
    });
  });
}

function renderChartBlock(block) {
  const def = findChart(block.refId);
  const el = document.getElementById('chart-' + block.id);
  if (!def || !el) return;
  const sheet = DATA[def.sheet];
  if (!sheet) return;

  let inst = charts[block.id];
  if (!inst) { inst = charts[block.id] = echarts.init(el); }

  // 瀑布（桥梁）图：每个工会占一行，行内依次是 期初 → 入账 → 支出 → 结余
  if (def.type === 'waterfall') {
    const list = E.waterfallRows(sheet, def);
    const barWidth = Number(def.barWidth) || 10;
    // 每个工会 4 根柱并排，行高必须容得下 4 根柱 + 间距，否则柱子会挤在一起看不出「桥」
    const need = Math.max(Number(def.height) || 320, list.length * (barWidth * 4 + 26) + 90);
    if (Math.abs(parseFloat(el.style.height || 0) - need) > 2) {
      el.style.height = need + 'px';
      inst.resize();
    }
    inst.setOption(buildWaterfallOption(def, list), true);
    return;
  }

  const list = E.groupRows(sheet, def);
  inst.setOption(buildChartOption(def, list), true);
}

/** 瀑布（桥梁）图的配色：期初 / 入账 / 支出 / 结余 */
function waterfallColors(def) {
  const p = palette();
  const custom = Array.isArray(def.colors) ? def.colors.filter(isColor) : [];
  if (custom.length >= 4) return custom.slice(0, 4);
  return [
    custom[0] || p[0] || '#4DD8FF',   // 期初
    custom[1] || '#10B981',           // 入账（增）
    custom[2] || '#EF4444',           // 支出（减）
    custom[3] || '#8B5CF6',           // 结余
  ];
}

/**
 * 瀑布（桥梁）图 option。
 * 每个工会 = y 轴上一个类目（一行），行内 4 根横柱并排：
 *   期初(0→期初) | 入账(期初→期初+入账) | 支出(结余→结余+支出) | 结余(0→结余)
 * 「悬浮」增量柱用一根透明占位柱 + 一根实体柱堆叠实现。
 */
function buildWaterfallOption(def, list) {
  const T = theme();
  const c = waterfallColors(def);
  const decimals = typeof def.decimals === 'number' ? def.decimals : 2;
  const fmt = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(decimals);
  const labelShow = !(def.label && def.label.show === false);
  const bw = Number(def.barWidth) || 10;
  const legendShow = !!(def.legend && def.legend.show);
  const legendPos = (def.legend && def.legend.position) || 'bottom';

  const names = list.map(x => x.name);
  const initial = list.map(x => x.initial);
  const income = list.map(x => x.income);
  const expense = list.map(x => x.expense);
  const balance = list.map(x => x.balance);

  // sign：入账标 "+"、支出标 "−"，一眼看出是增还是减
  const barSeries = (name, color, data, stack, showLabel, sign) => ({
    name,
    type: 'bar',
    stack,
    barWidth: bw,
    itemStyle: { color, borderRadius: [0, 2, 2, 0] },
    label: {
      show: labelShow && showLabel,
      position: 'right',
      color: T.text || '#E6EEFF',
      fontSize: 11,
      // 0 值不标数字：否则每行都会多出几个 "0.00"，把真正有金额的柱子淹掉
      formatter: (p) => (Math.abs(Number(p.value)) < 1e-9 ? '' : (sign || '') + fmt(p.value)),
    },
    data,
  });

  // 透明占位柱：只用来把实体柱「抬」到正确的起点，不参与提示与图例
  const placeholder = (data, stack) => ({
    name: '__ph_' + stack,
    type: 'bar',
    stack,
    barWidth: bw,
    silent: true,
    itemStyle: { color: 'transparent' },
    emphasis: { itemStyle: { color: 'transparent' } },
    tooltip: { show: false },
    data,
  });

  return {
    color: c,
    tooltip: Object.assign(tooltipStyle(), {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params) => {
        const arr = Array.isArray(params) ? params : [params];
        const row = list[arr.length ? arr[0].dataIndex : -1];
        if (!row) return '';
        const groups = { initial: [], income: [], expense: [], balance: [] };
        (row.items || []).forEach(i => { if (groups[i.stage]) groups[i.stage].push(`${i.item || '未命名'} ${fmt(i.value)}`); });
        const itemLines = [
          ['入账', groups.income], ['支出', groups.expense], ['期初', groups.initial], ['结余', groups.balance],
        ].filter(g => g[1].length).map(g => `${g[0]}：${g[1].join('、')}`).slice(0, 3);
        return `<b>${escapeHtml(row.name)}</b><br/>`
          + `期初 ${fmt(row.initial)} 万元<br/>`
          + `入账 +${fmt(row.income)}　支出 −${fmt(row.expense)}<br/>`
          + `<b>结余 ${fmt(row.balance)}</b> 万元${row.manual ? '（手工指定）' : '（自动计算）'}`
          + (itemLines.length ? '<br/>' + itemLines.map(escapeHtml).join('<br/>') : '');
      },
    }),
    legend: legendShow ? {
      show: true,
      data: ['期初', '入账', '支出', '结余'],
      bottom: legendPos === 'bottom' ? 0 : undefined,
      top: legendPos === 'top' ? 0 : undefined,
      textStyle: { color: T.text || '#E6EEFF', fontSize: 12 },
      itemWidth: 12, itemHeight: 12,
    } : { show: false },
    grid: { left: 10, right: 60, top: 24, bottom: legendShow && legendPos === 'bottom' ? 40 : 20, containLabel: true },
    xAxis: Object.assign({ type: 'value', name: (def.axis && def.axis.yName) || '' }, axisStyle(0), {
      nameTextStyle: { color: T.muted || '#7E93BD' },
    }),
    yAxis: Object.assign({ type: 'category', data: names, inverse: true }, axisStyle(0), {
      axisLabel: { color: T.muted || '#7E93BD', fontSize: 12, interval: 0 },
    }),
    series: [
      barSeries('期初', c[0], initial, 'st1', true, ''),
      placeholder(initial, 'st2'),
      barSeries('入账', c[1], income, 'st2', true, '+'),
      placeholder(balance, 'st3'),
      barSeries('支出', c[2], expense, 'st3', true, '−'),
      barSeries('结余', c[3], balance, 'st4', true, ''),
    ],
  };
}

function buildChartOption(def, list) {
  const T = theme();
  const type = def.type || 'bar';
  const labelShow = !(def.label && def.label.show === false);
  const labelFormatter = (def.label && def.label.formatter) || '{c}';
  const decimals = typeof def.decimals === 'number' ? def.decimals : 0;
  const rnd = v => Number(Number(v).toFixed(Math.max(0, Math.min(6, decimals))));
  const legendShow = !!(def.legend && def.legend.show);
  const legendPos = (def.legend && def.legend.position) || 'bottom';

  if (type === 'pie' || type === 'doughnut') {
    return {
      color: palette(),
      tooltip: Object.assign(tooltipStyle(), { trigger: 'item' }),
      legend: legendShow ? {
        show: true,
        orient: legendPos === 'right' ? 'vertical' : 'horizontal',
        bottom: legendPos === 'right' ? undefined : 0,
        right: legendPos === 'right' ? 0 : undefined,
        top: legendPos === 'right' ? 'middle' : undefined,
        textStyle: { color: T.text || '#E6EEFF', fontSize: 12 },
        itemWidth: 12, itemHeight: 12,
      } : { show: false },
      series: [{
        type: 'pie',
        radius: type === 'doughnut' ? ['38%', '65%'] : '62%',
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: T.cardBg2 || '#0E1A35', borderWidth: 2 },
        label: { show: labelShow, color: T.text || '#E6EEFF', fontSize: 12, formatter: labelFormatter },
        labelLine: { lineStyle: { color: T.accent || '#4DD8FF' } },
        data: list.map(x => ({ name: x.name, value: rnd(x.value) })),
      }],
    };
  }

  const isH = type === 'hbar';
  const isLine = type === 'line';
  const wrapMax = def.wrapLabels ? 6 : 0;

  const catData = list.map(x => (def.wrapLabels ? wrapLabel(x.name, wrapMax) : x.name));
  const values = list.map(x => rnd(x.value));
  const seriesData = values.map((v, i) => (isLine ? v : {
    value: v,
    itemStyle: {
      color: new echarts.graphic.LinearGradient(
        isH ? 0 : 0, isH ? 0 : 0, isH ? 1 : 0, isH ? 0 : 1,
        [{ offset: 0, color: colorAt(i) }, { offset: 1, color: '#1E40AF' }]
      ),
    },
  }));

  const categoryAxis = Object.assign({ type: 'category', data: catData }, axisStyle(isH ? 0 : (def.axis && def.axis.rotate) || 0), {
    axisLabel: {
      color: T.muted || '#7E93BD',
      fontSize: 12,
      interval: 0,
      lineHeight: 15,
      rotate: isH ? 0 : ((def.axis && def.axis.rotate) || 0),
    },
  });
  const valueAxis = Object.assign({ type: 'value' }, axisStyle(0), {
    name: (def.axis && def.axis.yName) || '',
    nameTextStyle: { color: T.muted || '#7E93BD' },
  });

  return {
    tooltip: Object.assign(tooltipStyle(), { trigger: 'axis', axisPointer: { type: isLine ? 'line' : 'shadow' } }),
    grid: isH
      ? { left: 10, right: 40, top: 20, bottom: 20, containLabel: true }
      : { left: 50, right: 30, top: 30, bottom: def.wrapLabels ? 60 : 50, containLabel: true },
    xAxis: isH ? valueAxis : categoryAxis,
    yAxis: isH ? categoryAxis : valueAxis,
    series: [{
      type: isLine ? 'line' : 'bar',
      data: seriesData,
      smooth: isLine,
      symbolSize: isLine ? 8 : undefined,
      label: {
        show: labelShow,
        position: isH ? 'right' : isLine ? 'top' : 'top',
        color: T.accent || '#4DD8FF',
        fontWeight: 700,
        fontSize: 12,
        formatter: (p) => {
          const v = typeof p.value === 'object' ? p.value.value : p.value;
          if (labelFormatter === '{c}') return decimals ? Number(v).toFixed(decimals) : String(v);
          return labelFormatter.replace('{c}', String(v)).replace('{b}', String(p.name || ''));
        },
      },
      lineStyle: isLine ? { color: colorAt(0), width: 2.5 } : undefined,
      areaStyle: isLine ? {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(77,216,255,0.35)' }, { offset: 1, color: 'rgba(77,216,255,0.02)' },
        ]),
      } : undefined,
      barWidth: isH ? undefined : (def.barWidth || 36),
    }],
  };
}

function renderTableBlock(block) {
  const def = findTable(block.refId);
  const host = document.getElementById('table-' + block.id);
  if (!def || !host) return;
  const sheet = DATA[def.sheet];
  if (!sheet) { host.innerHTML = ''; return; }

  const built = E.buildTable(sheet, def);
  const cols = built.head || [];
  const html = ['<table class="data-table"><thead><tr>'];

  if (def.type === 'cross') {
    html.push(`<th>${escapeHtml(def.rowField || '')}</th>`);
    cols.forEach(c => html.push(`<th>${escapeHtml(c)}</th>`));
    if (def.showTotalColumn !== false) html.push('<th>合计</th>');
    html.push('</tr></thead><tbody>');
    built.rows.forEach(r => {
      const filter = def.detail && def.detail.filterField
        ? ` data-detail="${escapeHtml(def.detail.sheet || def.sheet)}" data-filter='${escapeHtml(JSON.stringify({ key: def.detail.filterField, value: r.key }))}'`
        : '';
      const cls = def.detail && def.detail.filterField ? ' class="clickable"' : '';
      html.push(`<tr${cls}${filter}><td>${escapeHtml(r.key)}</td>`);
      r.cells.forEach(c => html.push(`<td class="cell-value">${c}</td>`));
      if (def.showTotalColumn !== false) html.push(`<td class="cell-value">${r.total}</td>`);
      html.push('</tr>');
    });
    if (def.showTotalRow !== false) {
      html.push(`<tr class="row-total"><td>${escapeHtml(def.totalLabel || '合计')}</td>`);
      (built.colTotals || []).forEach(c => html.push(`<td class="cell-value">${c}</td>`));
      if (def.showTotalColumn !== false) html.push(`<td class="cell-value">${built.grand}</td>`);
      html.push('</tr>');
    }
  } else {
    html.push(`<th>${escapeHtml(def.groupBy || '')}</th>`);
    cols.forEach(c => html.push(`<th>${escapeHtml(c)}</th>`));
    html.push('</tr></thead><tbody>');
    const colDefs = def.columns || [];
    built.rows.forEach(r => {
      const filter = def.detail && def.detail.filterField
        ? ` data-detail="${escapeHtml(def.detail.sheet || def.sheet)}" data-filter='${escapeHtml(JSON.stringify({ key: def.detail.filterField, value: r.key }))}'`
        : '';
      const cls = def.detail && def.detail.filterField ? ' class="clickable"' : '';
      html.push(`<tr${cls}${filter}><td>${escapeHtml(r.key)}</td>`);
      r.cells.forEach((v, i) => {
        const cd = colDefs[i] || {};
        const txt = typeof v === 'number' ? E.fmtNum(v, typeof cd.decimals === 'number' ? cd.decimals : 0) : escapeHtml(v);
        html.push(`<td class="cell-value">${txt}</td>`);
      });
      html.push('</tr>');
    });
  }
  html.push('</tbody></table>');
  host.innerHTML = html.join('');
}

// ---------------------------------------------------------------------------
// 明细弹窗
// ---------------------------------------------------------------------------
function openDetail(sheetKey, filterRaw) {
  if (!DATA) return;
  const data = DATA[sheetKey];
  if (!data) return;
  let filter = null;
  try { filter = filterRaw ? (typeof filterRaw === 'string' ? JSON.parse(filterRaw) : filterRaw) : null; } catch (_) {}
  if (filter && (filter.value === undefined || filter.value === null || filter.value === '')) filter = null;

  const modal = document.getElementById('detail-modal');
  const title = document.getElementById('modal-title');
  const subtitle = document.getElementById('modal-subtitle');
  const body = document.getElementById('modal-body');
  const search = document.getElementById('modal-search');

  title.textContent = data.title || sheetKey;
  subtitle.innerHTML = escapeHtml(data.subtitle || '')
    + (filter ? `<span class="filter-tag">筛选：${escapeHtml(filter.key)} = "${escapeHtml(filter.value)}"</span>` : '');

  const rows = data.rows.slice();
  const headers = data.headers;

  const readVal = (r, h) => E.pick(r, headers, h);

  function renderTable(filteredRows) {
    const html = ['<table class="detail-table"><thead><tr>'];
    headers.forEach(h => html.push(`<th>${escapeHtml(h)}</th>`));
    html.push('</tr></thead><tbody>');
    filteredRows.forEach(r => {
      html.push('<tr>');
      headers.forEach(h => {
        const v = readVal(r, h);
        const isEmpty = v === '' || v === null || v === undefined;
        const isNum = typeof v === 'number';
        const isLongText = typeof v === 'string' && v.length > 30;
        const cls = isEmpty ? 'empty-cell' : isNum ? 'cell-number' : isLongText ? 'cell-text' : '';
        html.push(`<td class="${cls}">${isEmpty ? '—' : escapeHtml(v)}</td>`);
      });
      html.push('</tr>');
    });
    if (!filteredRows.length) {
      html.push(`<tr><td colspan="${headers.length}" style="text-align:center; padding:32px; color:#7E93BD">暂无数据</td></tr>`);
    }
    html.push('</tbody></table>');
    body.innerHTML = html.join('');
  }

  function applyFilters() {
    let result = rows;
    if (filter) {
      result = result.filter(r => String(readVal(r, filter.key) == null ? '' : readVal(r, filter.key)) === String(filter.value));
    }
    const q = (search.value || '').trim().toLowerCase();
    if (q) {
      result = result.filter(r => headers.some(h => {
        const v = readVal(r, h);
        return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
      }));
    }
    renderTable(result);
  }

  applyFilters();
  search.value = '';
  search.oninput = applyFilters;
  modal.classList.remove('hidden');
}

function closeDetail() { document.getElementById('detail-modal').classList.add('hidden'); }

// ---------------------------------------------------------------------------
// 徽章 / 提示
// ---------------------------------------------------------------------------
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
    } else txt.textContent = '已就绪';
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

/** 通用遮罩：标题/说明/按钮文案/点击行为 */
function showMask(opts) {
  const el = document.getElementById('session-mask');
  if (!el) return;
  const title = el.querySelector('.sm-title');
  const desc = el.querySelector('.sm-desc');
  const btn = document.getElementById('session-relogin');
  if (title) title.textContent = opts.title;
  if (desc) desc.textContent = opts.desc;
  if (btn) {
    btn.textContent = opts.btn;
    btn.onclick = opts.onClick;
  }
  el.classList.remove('hidden');
}

/** 会话过期 / 未登录 */
function showSessionMask() {
  showMask({
    title: '登录已过期',
    desc: '为保护数据安全，请重新登录后继续查看。',
    btn: '重新登录',
    onClick: () => location.replace('/login.html?role=dashboard'),
  });
}

/** 数据读取失败：明确报错，绝不拿示例数据冒充真实数据 */
function showLoadErrorMask(msg) {
  showMask({
    title: '数据读取失败',
    desc: `${msg}（当前未展示任何数据，以免把示例数据误当成真实数据）`,
    btn: '刷新重试',
    onClick: () => location.reload(),
  });
}

/** 探不到后端时的显著横幅（说明当前看到的是本地/示例数据） */
function showDegradedBanner() {
  if (document.getElementById('degraded-banner')) return;
  const d = document.createElement('div');
  d.id = 'degraded-banner';
  d.className = 'degraded-banner';
  d.textContent = '⚠️ 未连接到服务器：当前页面显示的是本地/示例数据，请刷新页面或联系管理员';
  document.body.prepend(d);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function bindEvents() {
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('[data-detail]');
    if (!target) {
      if (e.target.id === 'detail-modal') closeDetail();
      return;
    }
    openDetail(target.dataset.detail, target.dataset.filter);
  });
  const closeBtn = document.getElementById('modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
  const relogin = document.getElementById('session-relogin');
  if (relogin) relogin.addEventListener('click', () => location.replace('/login.html?role=dashboard'));
}

async function boot() {
  CFG = window.SEED_CONFIG || {};
  // 先用配置渲染骨架，避免白屏（随后用服务端配置覆盖）
  try { renderStructure(); } catch (e) { console.error(e); }

  const data = await DashboardStore.load();

  if (!data) {
    // 会话失效 → 去登录；数据读取失败 → 明确报错，都不再展示示例数据
    const err = DashboardStore.getLoadError && DashboardStore.getLoadError();
    if (err) showLoadErrorMask(err);
    else showSessionMask();
    return;
  }
  DATA = DashboardStore.getData();
  CFG = DashboardStore.getConfig() || CFG;

  renderStructure();
  renderValues();
  refreshSyncBadge();
  bindEvents();
  if (DashboardStore.isDegraded && DashboardStore.isDegraded()) showDegradedBanner();

  DashboardStore.subscribe((d, info) => {
    refreshSyncBadge();
    if (info && info.authRequired) { showSessionMask(); return; }
    if (info && info.loadFailed) { showLoadErrorMask(info.error || '数据读取失败'); return; }
    if (info && info.statusOnly) return;
    if (info && info.configOnly) {
      CFG = DashboardStore.getConfig() || CFG;
      renderStructure();
      renderValues();
      if (info.source === 'remote') flashHint('看板配置已更新，自动刷新');
      return;
    }
    DATA = DashboardStore.getData();
    renderValues();
    if (info && info.source === 'remote') flashHint('已收到云端最新数据，自动刷新');
  });

  setInterval(refreshSyncBadge, 5000);

  window.addEventListener('resize', () => {
    Object.values(charts).forEach(c => { try { c && c.resize(); } catch (_) {} });
  });
}

document.addEventListener('DOMContentLoaded', boot);
