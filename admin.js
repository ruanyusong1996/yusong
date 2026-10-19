/* ===== 后台管理逻辑 ===== */

const SHEETS = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支', '05-经费瀑布'];
const SHEET_TITLES = {
  '01-组织建设': '工会组织建设',
  '02-走访慰问': '员工走访慰问',
  '03-员工活动': '员工活动',
  '04-经费收支': '工会经费收支',
  '05-经费瀑布': '经费瀑布（桥梁）',
};
const SHEET_ICON = {
  '01-组织建设': '🏛️',
  '02-走访慰问': '🤝',
  '03-员工活动': '🎉',
  '04-经费收支': '💰',
  '05-经费瀑布': '🌉',
};

/** 瀑布（桥梁）图专用表：一行 = 某个工会的一个科目（期初/入账/支出/结余） */
const FUND_SHEET = '05-经费瀑布';
/** 该表固定使用的列名（后台编辑与看板渲染都按这套来） */
const FUND_COLS = { union: '工会名称', full: '工会全称', stage: '收支类型', item: '经费项目', amount: '金额（万元）', note: '备注' };
const FUND_STAGES = ['期初', '入账', '支出', '结余'];

let currentTab = SHEETS[0];
let DATA = null;
let SCHEMA = null;  // 当前 sheet 的 schema: { headers, schema: { [field]: def } }
let CFG = null;     // 看板配置（文字/主题/布局/指标/图表/表格）

// ============ 工具 ============
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type === 'error' ? ' toast-error' : '');
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

function setSync(state, msg) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  el.classList.toggle('syncing', state === 'syncing');
  el.classList.toggle('error', state === 'error');
  const txt = el.querySelector('.sync-text');
  if (state === 'syncing') txt.textContent = msg || '同步中…';
  else if (state === 'error') txt.textContent = msg || '同步失败';
  else txt.textContent = msg || '已同步';
}

function refreshSyncBadge() {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  const status = DashboardStore.getStatus();
  el.classList.toggle('local', status.mode === 'local');
  el.classList.toggle('api', status.mode === 'api');
  const tag = el.querySelector('.sync-tag');
  if (tag) tag.textContent = status.mode === 'api' ? '云端共享' : '本地存储';

  if (status.mode === 'api') {
    if (!status.connected) {
      setSync('error', '已断线，正在重连…');
    } else if (status.lastSync) {
      const t = new Date(status.lastSync);
      const pad = n => String(n).padStart(2, '0');
      setSync('ok', `已同步 · ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`);
    } else {
      setSync('ok', '已就绪');
    }
  } else {
    setSync('ok', '已同步');
  }
}

function confirmDialog(message, title = '确认操作') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    modal.classList.remove('hidden');
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    const close = (val) => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', okFn);
      cancel.removeEventListener('click', cancelFn);
      resolve(val);
    };
    const okFn = () => close(true);
    const cancelFn = () => close(false);
    ok.addEventListener('click', okFn);
    cancel.addEventListener('click', cancelFn);
  });
}

// ============ 数据刷新 ============
const PSEUDO_TABS = ['__config', '__security'];
function isPseudoTab(t) { return PSEUDO_TABS.indexOf(t) >= 0; }

function refreshAll() {
  DATA = DashboardStore.getData();
  refreshOverview();
  if (isPseudoTab(currentTab)) return;   // 配置/安全面板不由数据驱动
  SCHEMA = DashboardStore.getSchema(currentTab);
  renderTable();
  updateSchemaIndicator();
}

function refreshOverview() {
  if (!DATA) return;
  const src = (window.ConfigEngine && CFG) ? ConfigEngine.computeMetrics(DATA, CFG) : computeMetrics();
  const num = v => (typeof v === 'number' && Number.isFinite(v)) ? Number(v.toFixed(2)) : 0;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ov-org-total', src['org-total'] !== undefined ? src['org-total'] : '—');
  set('ov-org-established', src['org-established'] !== undefined ? src['org-established'] : '—');
  set('ov-org-preparing', src['org-preparing'] !== undefined ? src['org-preparing'] : '—');
  set('ov-visit-total', src['visit-total'] !== undefined ? src['visit-total'] : '—');
  set('ov-visit-amount', num(src['visit-amount']));
  set('ov-act-total', src['act-total'] !== undefined ? src['act-total'] : '—');
  set('ov-act-coverage', src['act-coverage'] !== undefined ? src['act-coverage'] : '—');
  set('ov-fund-balance', num(src['fund-balance']));

  SHEETS.forEach(k => {
    const el = document.getElementById('badge-' + k);
    if (el) el.textContent = (DATA[k] && DATA[k].rows) ? DATA[k].rows.length : 0;
  });
}

// ============ 派生指标 ============
function computeMetrics() {
  if (!DATA) return null;
  const org = DATA['01-组织建设'].rows;
  const visit = DATA['02-走访慰问'].rows;
  const act = DATA['03-员工活动'].rows;
  const fund = DATA['04-经费收支'].rows;
  const orgHeaders = DATA['01-组织建设'].headers;
  const visitHeaders = DATA['02-走访慰问'].headers;
  const actHeaders = DATA['03-员工活动'].headers;
  const fundHeaders = DATA['04-经费收支'].headers;

  const get = (row, headers, name) => DashboardStore.pickValue(row, headers, name);

  return {
    'org-total': org.length,
    'org-established': org.filter(r => get(r, orgHeaders, '组建状态') === '已组建').length,
    'org-preparing': org.filter(r => get(r, orgHeaders, '组建状态') === '筹建中').length,
    'visit-total': visit.length,
    'visit-amount': visit.reduce((s, r) => s + (Number(get(r, visitHeaders, '慰问物品金额（元）')) || 0), 0),
    'act-total': act.length,
    'act-coverage': act.reduce((s, r) => s + (Number(get(r, actHeaders, '覆盖人数')) || 0), 0),
    'fund-balance': fund.reduce((s, r) => {
      const wan = Number(get(r, fundHeaders, '当前结余（万元）'));
      if (Number.isFinite(wan)) return s + wan;
      const yuan = Number(get(r, fundHeaders, '当前结余（元）')) || 0;
      return s + yuan / 10000;
    }, 0),
  };
}

// ============ 表格渲染 ============
function renderTable() {
  if (!DATA || !SCHEMA) return;
  const sheet = DATA[currentTab];
  const headers = SCHEMA.headers;
  const rows = sheet.rows;
  const schema = SCHEMA.schema;
  const thead = document.querySelector('#admin-table thead');
  const tbody = document.querySelector('#admin-table tbody');
  const empty = document.getElementById('admin-empty');
  const info = document.getElementById('tab-info');

  // 搜索
  const q = (document.getElementById('admin-search').value || '').trim().toLowerCase();
  let filtered = rows;
  if (q) {
    filtered = rows.filter(r =>
      headers.some(h => {
        const v = r[h];
        return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
      })
    );
  }

  // 表头
  thead.innerHTML = '<tr>' + headers.map(h => {
    const cls = (schema[h] && schema[h].auto) ? 'col-index' : '';
    return `<th class="${cls}">${escapeHtml(h)}</th>`;
  }).join('') + '<th class="col-actions">操作</th></tr>';

  // 行
  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    tbody.innerHTML = filtered.map((row, displayIdx) => {
      const realIndex = rows.indexOf(row);
      const cells = headers.map(h => {
        const def = schema[h] || {};
        const v = row[h];
        const isEmpty = v === '' || v === null || v === undefined;
        const isLong = typeof v === 'string' && v.length > 40;
        const cls = isEmpty ? 'empty-cell'
          : def.auto ? 'col-index'
          : isLong ? 'col-long'
          : '';
        const content = isEmpty ? '—' : escapeHtml(v);
        return `<td class="${cls}">${content}</td>`;
      }).join('');
      return `<tr>${cells}<td class="col-actions">
        <button class="btn btn-ghost btn-row" data-action="edit" data-index="${realIndex}">编辑</button>
        <button class="btn btn-danger btn-row" data-action="delete" data-index="${realIndex}">删除</button>
      </td></tr>`;
    }).join('');
  }

  info.textContent = `共 ${rows.length} 条${q ? ` · 筛选 ${filtered.length} 条` : ''}`;
}

// ============ 数字输入：最多 2 位小数（也允许整数）============
const NUM_MAX_DECIMALS = 2;
/** 合法数字：整数，或最多 2 位小数（可选负号，仅当字段允许负数） */
const NUM_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** 实时闸门：拦截非法字符与第 3 位小数，支持粘贴自动清洗（全角/千分位等） */
function attachNumberGuard(input, def) {
  const allowNegative = !(typeof def.min === 'number' && def.min >= 0);

  function sanitize(raw) {
    let s = String(raw == null ? '' : raw);
    // 全角数字/符号转半角
    s = s.replace(/[\uFF10-\uFF19\uFF0E\uFF0D]/g, ch =>
      ch === '\uFF0E' ? '.' : ch === '\uFF0D' ? '-' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    // 去掉千分位分隔符、空格及一切非数字/小数点/负号字符
    s = s.replace(/[,\s]/g, '').replace(/[^\d.\-]/g, '');
    // 负号：只保留开头一个，且字段允许负数时才保留
    const wantNeg = allowNegative && s.charAt(0) === '-';
    s = s.replace(/-/g, '');
    // 只保留第一个小数点，且小数部分最多 2 位
    const dot = s.indexOf('.');
    if (dot !== -1) {
      s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
      const parts = s.split('.');
      s = parts[0] + '.' + (parts[1] || '').slice(0, NUM_MAX_DECIMALS);
    }
    return (wantNeg ? '-' : '') + s;
  }

  input.addEventListener('input', () => {
    const before = input.value;
    const after = sanitize(before);
    if (before === after) return;
    const pos = input.selectionStart;
    input.value = after;
    const next = Math.max(0, (pos || after.length) + (after.length - before.length));
    try { input.setSelectionRange(next, next); } catch (_) { /* 忽略 */ }
  });

  // 失焦时清理"12."这类未完成输入 → 12
  input.addEventListener('blur', () => {
    if (/^-?\d+\.$/.test(input.value)) input.value = input.value.slice(0, -1);
    if (input.value === '-' || input.value === '.') input.value = '';
  });
}

// ============ 行编辑器（按 schema 渲染）============
function openEditor(mode, index) {
  if (!SCHEMA) return;
  const sheet = DATA[currentTab];
  const headers = SCHEMA.headers;
  const schema = SCHEMA.schema;
  const row = mode === 'edit' ? { ...sheet.rows[index] } : {};
  const fieldsEl = document.getElementById('editor-fields');
  const titleEl = document.getElementById('editor-title');
  const subEl = document.getElementById('editor-subtitle');

  titleEl.textContent = mode === 'edit' ? `编辑记录 #${row['序号'] || (index + 1)}` : '新增记录';
  subEl.textContent = (SHEET_ICON[currentTab] || '') + ' ' + (SHEET_TITLES[currentTab] || currentTab);

  fieldsEl.innerHTML = '';

  headers.forEach(h => {
    const def = schema[h] || { type: 'text' };
    if (def.auto) return; // 序号自动
    const full = def.full || def.type === 'textarea';
    const wrap = document.createElement('div');
    wrap.className = 'editor-field' + (full ? ' full' : '');

    const label = document.createElement('label');
    label.innerHTML = escapeHtml(h) + (def.required ? '<span class="req">*</span>' : '');
    wrap.appendChild(label);

    let input;
    const value = row[h] !== undefined && row[h] !== null ? row[h] : '';
    if (def.type === 'select') {
      input = document.createElement('select');
      (def.options || []).forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (String(opt) === String(value)) o.selected = true;
        input.appendChild(o);
      });
    } else if (def.type === 'textarea') {
      input = document.createElement('textarea');
      input.value = value;
    } else if (def.type === 'number') {
      // 数字：文本框 + 实时限制（最多 2 位小数，可为整数）
      input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.placeholder = def.placeholder || '最多 2 位小数，如 12 或 12.34';
      input.value = (value === '' || value === undefined || value === null) ? '' : String(value);
      attachNumberGuard(input, def);
    } else {
      input = document.createElement('input');
      input.type = def.type;
      input.value = value;
      if (def.min !== undefined) input.min = def.min;
    }
    input.name = h;
    input.dataset.field = h;
    if (def.required) input.required = true;
    wrap.appendChild(input);
    fieldsEl.appendChild(wrap);
  });

  document.getElementById('editor-modal').classList.remove('hidden');
  const form = document.getElementById('editor-form');
  form.dataset.mode = mode;
  form.dataset.index = index !== undefined ? index : '';
}

function closeEditor() {
  document.getElementById('editor-modal').classList.add('hidden');
}

async function submitEditor(e) {
  e.preventDefault();
  const sheet = DATA[currentTab];
  const headers = SCHEMA.headers;
  const schema = SCHEMA.schema;
  const form = e.target;
  const mode = form.dataset.mode;
  const editIndex = parseInt(form.dataset.index);

  // 收集
  const newRow = {};
  headers.forEach(h => { if (schema[h] && schema[h].auto) return; newRow[h] = ''; });
  const inputs = form.querySelectorAll('input, select, textarea');
  for (const el of inputs) {
    const field = el.dataset.field;
    const def = schema[field] || {};
    let val = el.value;

    if (def.type === 'number') {
      const raw = String(val == null ? '' : val).trim();
      // 没动过的字段不校验格式：历史数据（如经费瀑布表由经费收支表自动带入的金额）
      // 可能带着 4 位小数，用户只是改同一行的其它格子，不该被拦下来。
      const original = mode === 'edit' ? sheet.rows[editIndex][field] : undefined;
      const untouched = original !== undefined && original !== null && String(original) === raw;
      if (raw === '') {
        val = '';
      } else if (!NUM_PATTERN.test(raw) && !untouched) {
        toast(`「${field}」格式不对：只能填数字，且小数点后最多 2 位`, 'error');
        el.focus();
        return;
      } else {
        // 去掉多余的前导 0（如 007 → 7），保留 0 与 0.xx
        val = Number(raw);
      }
    }

    newRow[field] = val;
  }

  // 必填校验
  for (const el of inputs) {
    if (el.required && (el.value === '' || el.value === null)) {
      toast(`字段「${el.name}」不能为空`, 'error');
      el.focus();
      return;
    }
  }

  setSync('syncing');
  try {
    if (mode === 'edit') {
      // 保留序号
      newRow['序号'] = sheet.rows[editIndex]['序号'];
      await DashboardStore.replaceRow(currentTab, editIndex, newRow);
    } else {
      await DashboardStore.addRow(currentTab, newRow);
    }
    closeEditor();
    toast(mode === 'edit' ? '已保存修改' : '已新增记录');
    setTimeout(() => refreshSyncBadge(), 600);
  } catch (err) {
    console.error(err);
    toast('保存失败：' + (err.message || err), 'error');
    setSync('error', '保存失败');
  }
}

// ============ 列管理（schema 编辑器）============
function updateSchemaIndicator() {
  const el = document.getElementById('schema-summary');
  if (!el) return;
  if (!SCHEMA) { el.textContent = ''; return; }
  const count = SCHEMA.headers.length - 1; // 减去"序号"
  el.textContent = `${count} 列 · 可点 "⚙ 列管理" 修改`;
}

function openSchemaEditor() {
  if (!SCHEMA) return;
  const sheet = DATA[currentTab];
  const headers = SCHEMA.headers;
  const schema = SCHEMA.schema;

  document.getElementById('schema-title').textContent =
    `${SHEET_ICON[currentTab] || ''} ${SHEET_TITLES[currentTab]} · 表结构`;
  document.getElementById('schema-subtitle').textContent = `${headers.length - 1} 个字段（共 ${sheet.rows.length} 条数据）`;

  renderSchemaList();
  document.getElementById('schema-modal').classList.remove('hidden');
}

function closeSchemaEditor() {
  document.getElementById('schema-modal').classList.add('hidden');
}

function renderSchemaList() {
  const sheet = DATA[currentTab];
  const headers = SCHEMA.headers;
  const schema = SCHEMA.schema;
  const listEl = document.getElementById('schema-list');
  listEl.innerHTML = headers.map((h, idx) => {
    const def = schema[h] || {};
    if (def.auto) {
      return `<li class="schema-row schema-row-auto">
        <span class="schema-name">${escapeHtml(h)}</span>
        <span class="schema-meta">系统列 · 自动编号</span>
        <span class="schema-actions"></span>
      </li>`;
    }
    const typeLabel = ({
      text: '文本', number: '数字', date: '日期',
      select: '下拉', textarea: '多行文本',
    })[def.type] || def.type;
    return `<li class="schema-row" data-field="${escapeHtml(h)}">
      <span class="schema-handle">≡</span>
      <span class="schema-name">${escapeHtml(h)}</span>
      <span class="schema-meta">
        <span class="schema-type schema-type-${def.type}">${typeLabel}</span>
        ${def.required ? '<span class="schema-tag">必填</span>' : ''}
        ${def.full ? '<span class="schema-tag">整行</span>' : ''}
        ${def.type === 'select' ? `<span class="schema-tag">${(def.options || []).length} 项</span>` : ''}
      </span>
      <span class="schema-actions">
        <button class="btn btn-ghost btn-row" data-schema-action="up" data-field="${escapeHtml(h)}" ${idx <= 1 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-row" data-schema-action="down" data-field="${escapeHtml(h)}" ${idx >= headers.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-ghost btn-row" data-schema-action="edit" data-field="${escapeHtml(h)}">编辑</button>
        <button class="btn btn-danger btn-row" data-schema-action="del" data-field="${escapeHtml(h)}">删除</button>
      </span>
    </li>`;
  }).join('');
}

// 新增列弹窗
async function promptAddColumn(positionAfterField) {
  const sheet = DATA[currentTab];
  const headers = SCHEMA.headers;

  // 用一个简单的三层 modal：先选类型，再填字段
  const newFieldHtml = `
    <div class="add-col-form">
      <label>列名（必填）<input id="ac-name" type="text" placeholder="如：联系电话" /></label>
      <label>类型
        <select id="ac-type">
          <option value="text">文本</option>
          <option value="number">数字</option>
          <option value="date">日期</option>
          <option value="select">下拉选择</option>
          <option value="textarea">多行文本</option>
        </select>
      </label>
      <label id="ac-options-wrap" style="display:none">下拉选项（每行一个）
        <textarea id="ac-options" placeholder="选项1&#10;选项2"></textarea>
      </label>
      <div class="ac-flags">
        <label><input type="checkbox" id="ac-required" /> 必填</label>
        <label><input type="checkbox" id="ac-full" /> 占满整行</label>
      </div>
    </div>
  `;
  try {
    await showMiniModal('新增列', newFieldHtml, async (root) => {
      const nameEl = root.querySelector('#ac-name');
      const typeEl = root.querySelector('#ac-type');
      const requiredEl = root.querySelector('#ac-required');
      const fullEl = root.querySelector('#ac-full');
      const optionsEl = root.querySelector('#ac-options');
      if (!nameEl || !typeEl) { toast('表单未就绪', 'error'); return false; }
      const name = nameEl.value.trim();
      if (!name) { toast('请输入列名', 'error'); return false; }
      if (headers.includes(name)) { toast('已存在同名列', 'error'); return false; }
      const type = typeEl.value;
      const required = requiredEl ? requiredEl.checked : false;
      const full = fullEl ? fullEl.checked : false;
      let options;
      if (type === 'select') {
        options = (optionsEl ? optionsEl.value : '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!options.length) { toast('下拉选项至少 1 项', 'error'); return false; }
      }
      try {
        setSync('syncing');
        await DashboardStore.addColumn(currentTab, name, { type, required, full, options }, positionAfterField);
        SCHEMA = DashboardStore.getSchema(currentTab);
        renderSchemaList();
        updateSchemaIndicator();
        toast('已新增列');
        setTimeout(() => refreshSyncBadge(), 600);
        return true;
      } catch (e) {
        toast('新增失败：' + e.message, 'error');
        setSync('error', '新增失败');
        return false;
      }
    }, () => {
      // 切类型时显示/隐藏选项区
      const root = document.getElementById('mini-modal-content');
      if (!root) return;
      const sel = root.querySelector('#ac-type');
      const wrap = root.querySelector('#ac-options-wrap');
      if (!sel || !wrap) return;
      wrap.style.display = sel.value === 'select' ? '' : 'none';
      sel.addEventListener('change', () => {
        wrap.style.display = sel.value === 'select' ? '' : 'none';
      });
    });
  } catch (e) {
    console.error('[promptAddColumn]', e);
    toast('弹窗异常：' + e.message, 'error');
  }
}

// 编辑字段弹窗（含下拉选项编辑）
async function promptEditColumn(fieldName) {
  const schema = SCHEMA.schema;
  const def = { ...schema[fieldName] };
  const optionsText = (def.options || []).join('\n');

  const html = `
    <div class="add-col-form">
      <label>列名（必填）<input id="ec-name" type="text" value="${escapeHtml(fieldName)}" /></label>
      <label>类型
        <select id="ec-type">
          <option value="text" ${def.type==='text'?'selected':''}>文本</option>
          <option value="number" ${def.type==='number'?'selected':''}>数字</option>
          <option value="date" ${def.type==='date'?'selected':''}>日期</option>
          <option value="select" ${def.type==='select'?'selected':''}>下拉选择</option>
          <option value="textarea" ${def.type==='textarea'?'selected':''}>多行文本</option>
        </select>
      </label>
      <label id="ec-options-wrap" style="${def.type==='select'?'':'display:none'}">下拉选项（每行一个，可增删改）
        <textarea id="ec-options" rows="6">${escapeHtml(optionsText)}</textarea>
        <small class="muted">修改后，新记录使用新选项；历史记录的旧选项值会保留，但不再出现在下拉里。</small>
      </label>
      <div class="ac-flags">
        <label><input type="checkbox" id="ec-required" ${def.required?'checked':''} /> 必填</label>
        <label><input type="checkbox" id="ec-full" ${def.full?'checked':''} /> 占满整行</label>
      </div>
    </div>
  `;
  try {
    await showMiniModal('编辑列', html, async (root) => {
      const ecName = root.querySelector('#ec-name');
      const ecType = root.querySelector('#ec-type');
      const ecOptions = root.querySelector('#ec-options');
      const ecRequired = root.querySelector('#ec-required');
      const ecFull = root.querySelector('#ec-full');
      if (!ecName || !ecType) { toast('编辑表单未就绪', 'error'); return false; }
      const newName = ecName.value.trim();
      if (!newName) { toast('请输入列名', 'error'); return false; }
      const newType = ecType.value;
      const required = ecRequired ? ecRequired.checked : false;
      const full = ecFull ? ecFull.checked : false;
      let options = def.options;
      if (newType === 'select') {
        options = (ecOptions ? ecOptions.value : '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!options.length) { toast('下拉选项至少 1 项', 'error'); return false; }
      }
      try {
        setSync('syncing');
        if (newName !== fieldName) {
          await DashboardStore.renameColumn(currentTab, fieldName, newName);
        }
        await DashboardStore.updateColumn(currentTab, newName, { type: newType, required, full, options });
        toast('已保存');
        setTimeout(() => refreshSyncBadge(), 600);
        return true;
      } catch (e) {
        toast('保存失败：' + e.message, 'error');
        setSync('error', '保存失败');
        return false;
      }
    }, (root) => {
      const sel = root.querySelector('#ec-type');
      const wrap = root.querySelector('#ec-options-wrap');
      if (!sel || !wrap) return;
      sel.addEventListener('change', () => {
        wrap.style.display = sel.value === 'select' ? '' : 'none';
      });
    });
  } catch (e) {
    console.error('[promptEditColumn]', e);
    toast('弹窗异常：' + e.message, 'error');
  }
}

/** 通用小弹窗（无嵌套关闭） */
function showMiniModal(title, htmlBody, onConfirm, onShow) {
  return new Promise((resolve) => {
    const modal = document.getElementById('mini-modal');
    document.getElementById('mini-modal-title').textContent = title;
    document.getElementById('mini-modal-content').innerHTML = htmlBody;
    modal.classList.remove('hidden');

    const ok = document.getElementById('mini-modal-ok');
    const cancel = document.getElementById('mini-modal-cancel');
    const close = document.getElementById('mini-modal-close');
    const root = document.getElementById('mini-modal-content');

    // 带表单网格的弹窗（指标 / 图表 / 统计表）字段多，用宽版两列排版；
    // 瀑布图编辑器有左右分栏，同样需要宽版；
    // 「新增列 / 编辑列 / 选择指标」这类内容少，保持窄版。
    const panel = modal.querySelector('.mini-panel');
    if (panel) panel.classList.toggle('mini-panel-wide', !!root.querySelector('.form-grid, .wf-wrap'));

    // 弹窗刚打开时把内容区滚到顶部，避免上次滚到底部的位置被继承
    root.scrollTop = 0;

    const cleanup = () => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', okFn);
      cancel.removeEventListener('click', cancelFn);
      close.removeEventListener('click', cancelFn);
    };
    const okFn = async () => {
      const ok = await onConfirm(root);
      if (ok) { cleanup(); resolve(true); }
    };
    const cancelFn = () => { cleanup(); resolve(false); };

    ok.addEventListener('click', okFn);
    cancel.addEventListener('click', cancelFn);
    close.addEventListener('click', cancelFn);
    if (onShow) onShow(root);

    // enter 直接确认
    root.onkeydown = (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); okFn(); } };
  });
}

// ============ 事件绑定 ============
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;

      const dataPanel = document.getElementById('panel-data');
      const cfgPanel = document.getElementById('panel-config');
      const secPanel = document.getElementById('panel-security');

      if (currentTab === '__config') {
        dataPanel.classList.add('hidden');
        secPanel.classList.add('hidden');
        cfgPanel.classList.remove('hidden');
        CFG = DashboardStore.getConfig() || CFG;
        renderConfigPanel();
        return;
      }
      if (currentTab === '__security') {
        dataPanel.classList.add('hidden');
        cfgPanel.classList.add('hidden');
        secPanel.classList.remove('hidden');
        renderSecurityPanel();
        return;
      }

      cfgPanel.classList.add('hidden');
      secPanel.classList.add('hidden');
      dataPanel.classList.remove('hidden');
      document.getElementById('admin-search').value = '';
      // 「新增工会组织」在组织建设表与瀑布表都要有（新成立工会两边都得体现）；
      // 「瀑布图编辑」只有瀑布表需要。
      const addUnionBtn = document.getElementById('btn-add-union');
      const fundBtn = document.getElementById('btn-fund-editor');
      if (addUnionBtn) addUnionBtn.classList.toggle('hidden', currentTab !== '01-组织建设' && currentTab !== FUND_SHEET);
      if (fundBtn) fundBtn.classList.toggle('hidden', currentTab !== FUND_SHEET);
      SCHEMA = DashboardStore.getSchema(currentTab);
      renderTable();
      updateSchemaIndicator();
    });
  });
}

function bindToolbar() {
  document.getElementById('admin-search').addEventListener('input', renderTable);
  document.getElementById('btn-add').addEventListener('click', () => openEditor('add'));
  document.getElementById('btn-schema').addEventListener('click', openSchemaEditor);
  document.getElementById('btn-add-union').addEventListener('click', () => promptAddUnion());
  document.getElementById('btn-fund-editor').addEventListener('click', () => openFundEditor());

  document.querySelector('#admin-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const index = parseInt(btn.dataset.index);
    if (action === 'edit') {
      openEditor('edit', index);
    } else if (action === 'delete') {
      const ok = await confirmDialog(`确认删除第 ${index + 1} 条记录？此操作不可撤销`, '删除确认');
      if (!ok) return;
      setSync('syncing');
      try {
        await DashboardStore.deleteRow(currentTab, index);
        toast('已删除');
        setTimeout(() => refreshSyncBadge(), 600);
      } catch (err) {
        console.error(err);
        toast('删除失败：' + (err.message || err), 'error');
        setSync('error', '删除失败');
      }
    }
  });

  document.getElementById('editor-close').addEventListener('click', closeEditor);
  document.getElementById('editor-cancel').addEventListener('click', closeEditor);
  document.getElementById('editor-modal').addEventListener('click', (e) => {
    if (e.target.id === 'editor-modal') closeEditor();
  });
  document.getElementById('editor-form').addEventListener('submit', submitEditor);

  // Schema 编辑器
  document.getElementById('schema-close').addEventListener('click', closeSchemaEditor);
  document.getElementById('schema-cancel').addEventListener('click', closeSchemaEditor);
  document.getElementById('schema-add').addEventListener('click', () => promptAddColumn());
  document.getElementById('schema-modal').addEventListener('click', (e) => {
    if (e.target.id === 'schema-modal') closeSchemaEditor();
  });
  document.querySelector('#schema-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-schema-action]');
    if (!btn) return;
    const action = btn.dataset.schemaAction;
    const field = btn.dataset.field;
    if (action === 'edit') {
      await promptEditColumn(field);
      SCHEMA = DashboardStore.getSchema(currentTab);
      renderSchemaList();
      updateSchemaIndicator();
    } else if (action === 'del') {
      const ok = await confirmDialog(
        `确认删除列「${field}」？\n此操作将清空所有行该列的数据，且不可撤销。`,
        '删除列'
      );
      if (!ok) return;
      try {
        setSync('syncing');
        await DashboardStore.removeColumn(currentTab, field);
        SCHEMA = DashboardStore.getSchema(currentTab);
        renderSchemaList();
        updateSchemaIndicator();
        toast('已删除列');
        setTimeout(() => refreshSyncBadge(), 600);
      } catch (err) {
        toast('删除失败：' + err.message, 'error');
        setSync('error', '删除失败');
      }
    } else if (action === 'up' || action === 'down') {
      try {
        setSync('syncing');
        await DashboardStore.moveColumn(currentTab, field, action === 'up' ? -1 : +1);
        SCHEMA = DashboardStore.getSchema(currentTab);
        renderSchemaList();
        setTimeout(() => refreshSyncBadge(), 600);
      } catch (err) {
        toast('移动失败：' + err.message, 'error');
        setSync('error', '移动失败');
      }
    }
  });

  document.getElementById('btn-export').addEventListener('click', exportJSON);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-import').click());
  document.getElementById('file-import').addEventListener('change', importJSON);
  document.getElementById('btn-reset').addEventListener('click', async () => {
    const ok = await confirmDialog('确认重置为初始数据？所有修改（含表结构）将丢失', '重置数据');
    if (!ok) return;
    setSync('syncing');
    try {
      await DashboardStore.reset();
      toast('已重置为初始数据');
      setTimeout(() => refreshSyncBadge(), 600);
    } catch (err) {
      console.error(err);
      toast('重置失败：' + (err.message || err), 'error');
      setSync('error', '重置失败');
    }
  });
}

// ============ 导入导出 ============
function exportJSON() {
  const data = DashboardStore.getData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `工会数据看板-备份-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已导出 JSON（含表结构）');
}

async function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed['01-组织建设'] || !parsed['04-经费收支']) {
      throw new Error('文件格式不正确，缺少关键数据表');
    }
    const ok = await confirmDialog('确认导入此文件？将覆盖当前所有数据（含表结构）', '导入确认');
    if (!ok) {
      e.target.value = '';
      return;
    }
    setSync('syncing');
    try {
      await DashboardStore.replaceAll(parsed);
      toast('已导入');
      setTimeout(() => refreshSyncBadge(), 600);
    } catch (err) {
      console.error(err);
      toast('导入失败：' + (err.message || err), 'error');
      setSync('error', '导入失败');
    }
  } catch (err) {
    toast('导入失败：' + err.message, 'error');
  }
  e.target.value = '';
}

// ============ 看板配置面板 ============
const E = window.ConfigEngine;

function getPath(obj, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, p, v) {
  const parts = String(p).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
}
function deepCloneCfg(o) { return JSON.parse(JSON.stringify(o || {})); }
function fieldOptions(sheetName) {
  const s = DATA && DATA[sheetName];
  return s ? s.headers.slice() : [];
}

/** 通用表单字段渲染 */
function formField(f, val) {
  const id = 'f_' + f.k.replace(/[^\w]/g, '_');
  const label = escapeHtml(f.label || f.k);
  const v = val === undefined || val === null ? '' : val;
  const wrapCls = 'form-field' + (f.full ? ' full' : '');
  let inner = '';
  switch (f.t) {
    case 'checkbox':
      return `<label class="${wrapCls} check"><input type="checkbox" id="${id}" data-k="${escapeHtml(f.k)}" ${v ? 'checked' : ''}/> ${label}</label>`;
    case 'textarea':
      inner = `<textarea id="${id}" data-k="${escapeHtml(f.k)}" rows="${f.rows || 3}">${escapeHtml(v)}</textarea>`;
      break;
    case 'select': {
      const opts = (f.opts || []).map(o => {
        const ov = typeof o === 'object' ? o.v : o;
        const ol = typeof o === 'object' ? o.l : o;
        return `<option value="${escapeHtml(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${escapeHtml(ol)}</option>`;
      }).join('');
      inner = `<select id="${id}" data-k="${escapeHtml(f.k)}">${opts}</select>`;
      break;
    }
    case 'sheet':
      inner = `<select id="${id}" data-k="${escapeHtml(f.k)}">${SHEETS.map(s => `<option value="${escapeHtml(s)}" ${s === v ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}</select>`;
      break;
    case 'field': {
      const list = fieldOptions(f.sheetOf ? getPath(window.__cfgDraft || {}, f.sheetOf) : f.sheet);
      const opts = ['', ...list].map(s => `<option value="${escapeHtml(s)}" ${s === v ? 'selected' : ''}>${s ? escapeHtml(s) : '（不指定）'}</option>`).join('');
      inner = `<select id="${id}" data-k="${escapeHtml(f.k)}">${opts}</select>`;
      break;
    }
    case 'number':
      inner = `<input type="text" inputmode="decimal" id="${id}" data-k="${escapeHtml(f.k)}" value="${escapeHtml(v)}" />`;
      break;
    case 'color':
      inner = `<span class="color-input"><input type="color" id="${id}" data-k="${escapeHtml(f.k)}" value="${escapeHtml(v || '#4DD8FF')}" /><input type="text" data-k="${escapeHtml(f.k)}" value="${escapeHtml(v || '')}" /></span>`;
      break;
    default:
      inner = `<input type="text" id="${id}" data-k="${escapeHtml(f.k)}" value="${escapeHtml(v)}" ${f.ph ? `placeholder="${escapeHtml(f.ph)}"` : ''} />`;
  }
  return `<label class="${wrapCls}">${label}${inner}</label>`;
}

function buildForm(fields, obj) {
  return `<div class="form-grid">${fields.map(f => formField(f, getPath(obj, f.k))).join('')}</div>`;
}

function readForm(root, fields) {
  const out = {};
  fields.forEach(f => {
    const els = root.querySelectorAll(`[data-k="${f.k}"]`);
    if (!els.length) return;
    const el = els[0];
    let v;
    if (f.t === 'checkbox') v = el.checked;
    else if (f.t === 'number') { const s = String(el.value).trim(); v = s === '' ? undefined : Number(s); }
    else if (f.t === 'color') {
      const txt = root.querySelector(`input[type="text"][data-k="${f.k}"]`);
      v = (txt && txt.value.trim()) || el.value;
    }
    // csvText：逗号分隔的输入框要还原成数组。
    // 注意必须在「读取时」转换：以前在调用方按 k === 'theme.palette' 判断，
    // 但 setPath 会把键名拆成嵌套路径，Object.keys(got) 得到的是 'theme' 不是
    // 'theme.palette'，那个判断永远不成立 —— 图表色板因此每次保存都变成字符串，
    // 看板所有图表随即渲染成黑色/报 addColorStop 错误。
    else if (f.t === 'csvText') v = csvToArr(el.value);
    else v = el.value;
    setPath(out, f.k, v);
  });
  return out;
}

// ---- 字段定义（用于自动生成编辑表单）----
const METRIC_FIELDS = [
  { k: 'id', label: 'ID（英文，唯一，公式引用用）', t: 'text' },
  { k: 'label', label: '显示名称', t: 'text' },
  { k: 'unit', label: '单位', t: 'text' },
  { k: 'decimals', label: '小数位（0-2）', t: 'number' },
  { k: 'visible', label: '在看板上显示', t: 'checkbox' },
  { k: 'sheet', label: '数据表（数据链接）', t: 'sheet' },
  { k: 'agg', label: '统计方式', t: 'select', opts: [['count', '计数'], ['sum', '求和'], ['avg', '平均'], ['max', '最大值'], ['min', '最小值'], ['distinct', '去重计数']].map(([v, l]) => ({ v, l })) },
  { k: 'field', label: '统计字段', t: 'field', sheetOf: 'sheet' },
  { k: 'scale', label: '结果乘数（如元→万元填 0.0001）', t: 'number' },
  { k: 'fallbackField', label: '兜底字段（主字段为空时用）', t: 'field', sheetOf: 'sheet' },
  { k: 'fallbackScale', label: '兜底乘数', t: 'number' },
  { k: 'expr', label: '计算公式（用 {指标id} 引用其它指标，如 {a}/{b}*100）', t: 'textarea', full: true, rows: 2 },
  { k: 'detail.sheet', label: '点击卡片→明细表', t: 'sheet' },
  { k: 'detail.filterField', label: '点击卡片→筛选字段', t: 'field', sheetOf: 'detail.sheet' },
  { k: 'detail.filterValue', label: '点击卡片→筛选值', t: 'text' },
];

const CHART_FIELDS = [
  { k: 'id', label: 'ID（英文，唯一）', t: 'text' },
  { k: 'title', label: '图表标题（留空则不显示）', t: 'text' },
  { k: 'visible', label: '显示', t: 'checkbox' },
  { k: 'type', label: '图表类型', t: 'select', opts: [['pie', '饼图'], ['doughnut', '环形图'], ['bar', '柱状图'], ['hbar', '条形图(横)'], ['line', '折线图'], ['waterfall', '瀑布/桥梁图（期初→入账→支出→结余）']].map(([v, l]) => ({ v, l })) },
  { k: 'sheet', label: '数据表', t: 'sheet' },
  { k: 'groupBy', label: '分组字段（横轴/饼块；瀑布图=每个工会一行）', t: 'field', sheetOf: 'sheet' },
  { k: 'agg', label: '统计方式', t: 'select', opts: [['count', '计数'], ['sum', '求和'], ['avg', '平均'], ['max', '最大值'], ['min', '最小值']].map(([v, l]) => ({ v, l })) },
  { k: 'field', label: '统计字段（瀑布图=金额列）', t: 'field', sheetOf: 'sheet' },
  { k: 'stageField', label: '【瀑布图】阶段字段（值含 期初/入账/支出/结余）', t: 'field', sheetOf: 'sheet' },
  { k: 'itemField', label: '【瀑布图】项目字段（经费项目名称）', t: 'field', sheetOf: 'sheet' },
  { k: 'height', label: '高度（px）', t: 'number' },
  { k: 'barWidth', label: '柱宽（px）', t: 'number' },
  { k: 'decimals', label: '数值小数位', t: 'number' },
  { k: 'wrapLabels', label: '长标签折行', t: 'checkbox' },
  { k: 'legend.show', label: '显示图例', t: 'checkbox' },
  { k: 'legend.position', label: '图例位置', t: 'select', opts: [['bottom', '底部'], ['top', '顶部'], ['right', '右侧']].map(([v, l]) => ({ v, l })) },
  { k: 'label.show', label: '显示数值标签', t: 'checkbox' },
  { k: 'label.formatter', label: '标签格式（{b}{c}）', t: 'text' },
  { k: 'axis.rotate', label: '横轴文字旋转角度', t: 'number' },
  { k: 'axis.yName', label: '纵轴单位说明', t: 'text' },
  { k: 'sortBy', label: '排序', t: 'select', opts: [['', '数据顺序'], ['valueDesc', '数值降序'], ['valueAsc', '数值升序'], ['nameAsc', '名称升序']].map(([v, l]) => ({ v, l })) },
  { k: 'colors', label: '配色（逗号分隔，留空用主题色板）', t: 'csvText', full: true },
  { k: 'detail.sheet', label: '点击图形→明细表', t: 'sheet' },
  { k: 'detail.groupField', label: '点击图形→按该字段筛选', t: 'field', sheetOf: 'detail.sheet' },
];

const TABLE_FIELDS = [
  { k: 'id', label: 'ID（英文，唯一）', t: 'text' },
  { k: 'title', label: '表格标题', t: 'text' },
  { k: 'visible', label: '显示', t: 'checkbox' },
  { k: 'type', label: '表格类型', t: 'select', opts: [['group', '分组统计表'], ['cross', '交叉表（行×列）']].map(([v, l]) => ({ v, l })) },
  { k: 'sheet', label: '数据表', t: 'sheet' },
  { k: 'groupBy', label: '分组字段', t: 'field', sheetOf: 'sheet' },
  { k: 'rowField', label: '交叉表-行字段', t: 'field', sheetOf: 'sheet' },
  { k: 'colField', label: '交叉表-列字段', t: 'field', sheetOf: 'sheet' },
  { k: 'showTotalColumn', label: '交叉表-显示合计列', t: 'checkbox' },
  { k: 'showTotalRow', label: '交叉表-显示合计行', t: 'checkbox' },
  { k: 'totalLabel', label: '合计行名称', t: 'text' },
  { k: 'sortBy', label: '排序', t: 'select', opts: [['', '数据顺序'], ['valueDesc', '数值降序'], ['valueAsc', '数值升序'], ['nameAsc', '名称升序']].map(([v, l]) => ({ v, l })) },
  { k: 'limit', label: '最多显示行数（0=不限）', t: 'number' },
  { k: 'detail.sheet', label: '点击行→明细表', t: 'sheet' },
  { k: 'detail.filterField', label: '点击行→筛选字段', t: 'field', sheetOf: 'detail.sheet' },
];

const SUBTITLE_TYPES = [
  { v: 'text', l: '普通文字（支持 {date}/{time}）' },
  { v: 'hint', l: '高亮提示' },
  { v: 'adminLink', l: '后台管理链接' },
  { v: 'syncBadge', l: '同步状态徽章' },
  { v: 'logout', l: '退出登录' },
];

const THEME_FIELDS = [
  { k: 'theme.accent', label: '强调色（数字/高亮）', t: 'color' },
  { k: 'theme.accent2', label: '辅助强调色（小标题）', t: 'color' },
  { k: 'theme.bg', label: '页面背景色', t: 'color' },
  { k: 'theme.cardBg', label: '卡片背景色', t: 'color' },
  { k: 'theme.cardBg2', label: '卡片渐变底色', t: 'color' },
  { k: 'theme.subCardBg', label: '子卡片(指标块)底色', t: 'text' },
  { k: 'theme.titleBar', label: '模块标题条颜色', t: 'color' },
  { k: 'theme.text', label: '正文文字色', t: 'color' },
  { k: 'theme.muted', label: '次要文字色', t: 'color' },
  { k: 'theme.danger', label: '警示色', t: 'color' },
  { k: 'theme.cardBorder', label: '卡片描边（可带透明度 rgba()）', t: 'text' },
  { k: 'theme.palette', label: '图表色板（逗号分隔）', t: 'csvText', full: true },
];

const TEXT_FIELDS = [
  { k: 'text.documentTitle', label: '浏览器标签标题', t: 'text' },
  { k: 'text.pageTitle', label: '看板主标题', t: 'text' },
  { k: 'text.titleDeco', label: '标题两侧装饰线 ━━━', t: 'checkbox' },
  { k: 'text.detailButtonText', label: '「查看明细」按钮文案', t: 'text' },
  { k: 'text.footer', label: '页脚文字', t: 'text', full: true },
];

const LAYOUT_FIELDS = [
  { k: 'layout.maxWidth', label: '内容最大宽度（px）', t: 'number' },
  { k: 'layout.moduleGap', label: '模块间距（px）', t: 'number' },
  { k: 'layout.columnGap', label: '列间距（px）', t: 'number' },
  { k: 'layout.cardRadius', label: '卡片圆角（px）', t: 'number' },
];

/** 逗号/空格分隔文本 → 数组；已经是数组就原样清洗（幂等，可重复调用） */
function csvToArr(s) {
  if (Array.isArray(s)) return s.map(x => String(x).trim()).filter(Boolean);
  return String(s == null ? '' : s).split(/[,，;；]/).map(x => x.trim()).filter(Boolean);
}

/** 读取配置面板上的所有值（含数组结构），返回新配置对象 */
function collectConfigFromPanel() {
  const root = document.getElementById('cfg-root');
  const next = deepCloneCfg(CFG);

  // 标量字段（逐个「叶子键」写回，避免整块替换丢掉未出现在表单里的字段）
  [TEXT_FIELDS, THEME_FIELDS, LAYOUT_FIELDS].forEach(fields => {
    const got = readForm(root, fields);
    fields.forEach(f => {
      const v = getPath(got, f.k);
      if (v === undefined) return;
      setPath(next, f.k, v);
    });
  });

  // 副标题条目
  const items = [];
  root.querySelectorAll('#sub-list [data-sub-item]').forEach(row => {
    const type = row.querySelector('[data-sub-type]').value;
    const textEl = row.querySelector('[data-sub-text]');
    items.push(textEl && textEl.value !== '' ? { type, text: textEl.value } : { type });
  });
  next.text = next.text || {};
  next.text.subtitleItems = items;

  // 指标 / 图表 / 表格 的可见性与顺序（列表里的复选框）
  ['metrics', 'charts', 'tables'].forEach(coll => {
    const ids = [];
    root.querySelectorAll(`[data-${coll}-row]`).forEach(row => {
      const i = parseInt(row.dataset[coll + 'Row'], 10);
      const src = CFG[coll][i];
      if (!src) return;
      const item = deepCloneCfg(src);
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) item.visible = cb.checked;
      ids.push(item);
    });
    next[coll] = ids;
  });

  // 模块结构（可见性 / 标题 / 顺序 / 列宽 / 块）
  const modules = [];
  root.querySelectorAll('[data-mod-card]').forEach(card => {
    const mi = parseInt(card.dataset.modCard, 10);
    const src = CFG.modules[mi];
    if (!src) return;
    const mod = deepCloneCfg(src);
    const cb = card.querySelector('[data-mod-visible]');
    if (cb) mod.visible = cb.checked;
    const titleEl = card.querySelector('[data-mod-title]');
    if (titleEl) mod.title = titleEl.value;
    const sd = card.querySelector('[data-mod-showdetail]');
    if (sd) mod.showDetail = sd.checked;

    const cols = [];
    card.querySelectorAll('[data-col-card]').forEach(colEl => {
      const ci = parseInt(colEl.dataset.colCard, 10);
      const cSrc = src.columns[ci];
      if (!cSrc) return;
      const col = deepCloneCfg(cSrc);
      const w = colEl.querySelector('[data-col-width]');
      if (w) col.width = Number(w.value) || 12;
      const blocks = [];
      colEl.querySelectorAll('[data-blk-row]').forEach(blkEl => {
        const bi = parseInt(blkEl.dataset.blkRow, 10);
        const bSrc = cSrc.blocks[bi];
        if (!bSrc) return;
        const b = deepCloneCfg(bSrc);
        const bcb = blkEl.querySelector('[data-blk-visible]');
        if (bcb) b.visible = bcb.checked;
        const bt = blkEl.querySelector('[data-blk-title]');
        if (bt) b.title = bt.value;
        const ref = blkEl.querySelector('[data-blk-ref]');
        if (ref) b.refId = ref.value;
        blocks.push(b);
      });
      col.blocks = blocks;
      cols.push(col);
    });
    mod.columns = cols;
    modules.push(mod);
  });
  next.modules = modules;

  return next;
}

function renderConfigPanel() {
  const root = document.getElementById('cfg-root');
  if (!root || !CFG) return;
  const t = CFG.text || {};
  const items = t.subtitleItems || [];

  const subRows = items.map((it, i) => `
    <li class="cfg-list-row" data-sub-item="${i}">
      <span class="cfg-drag">☰</span>
      <select data-sub-type class="cfg-mini-select">
        ${SUBTITLE_TYPES.map(x => `<option value="${x.v}" ${x.v === it.type ? 'selected' : ''}>${x.l}</option>`).join('')}
      </select>
      <input type="text" data-sub-text value="${escapeHtml(it.text || '')}" placeholder="显示文字" class="cfg-grow" />
      <button class="mini-btn" data-act="sub-up" data-i="${i}" title="上移">↑</button>
      <button class="mini-btn" data-act="sub-down" data-i="${i}" title="下移">↓</button>
      <button class="mini-btn danger" data-act="sub-del" data-i="${i}" title="删除">×</button>
    </li>`).join('');

  const moduleCards = (CFG.modules || []).map((mod, mi) => {
    const cols = (mod.columns || []).map((col, ci) => {
      const blocks = (col.blocks || []).map((b, bi) => {
        const isChart = b.type === 'chart';
        const isTable = b.type === 'table';
        const refOpts = isChart
          ? (CFG.charts || []).map(c => `<option value="${escapeHtml(c.id)}" ${c.id === b.refId ? 'selected' : ''}>${escapeHtml(c.id)}${c.title ? ' · ' + escapeHtml(c.title) : ''}</option>`).join('')
          : isTable
            ? (CFG.tables || []).map(x => `<option value="${escapeHtml(x.id)}" ${x.id === b.refId ? 'selected' : ''}>${escapeHtml(x.id)}${x.title ? ' · ' + escapeHtml(x.title) : ''}</option>`).join('')
            : '';
        const metricHint = b.type === 'metrics'
          ? `<span class="cfg-hint-inline">指标: ${escapeHtml((b.metricIds || []).join(', '))}</span>`
          : '';
        return `
          <li class="cfg-blk-row" data-blk-row="${bi}">
            <span class="cfg-type-tag">${b.type === 'metrics' ? '指标组' : b.type === 'chart' ? '图表' : b.type === 'table' ? '统计表' : '文字块'}</span>
            <label class="mini-check"><input type="checkbox" data-blk-visible ${b.visible !== false ? 'checked' : ''}/> 显示</label>
            <input type="text" data-blk-title value="${escapeHtml(b.title || '')}" placeholder="块标题（可空）" class="cfg-grow" />
            ${refOpts ? `<select data-blk-ref class="cfg-mini-select">${refOpts}</select>` : ''}
            ${metricHint}
            ${b.type === 'metrics' ? `<button class="mini-btn" data-act="blk-metrics" data-mod="${mi}" data-col="${ci}" data-blk="${bi}">选指标</button>` : ''}
            <button class="mini-btn" data-act="blk-up" data-mod="${mi}" data-col="${ci}" data-blk="${bi}">↑</button>
            <button class="mini-btn" data-act="blk-down" data-mod="${mi}" data-col="${ci}" data-blk="${bi}">↓</button>
            <button class="mini-btn danger" data-act="blk-del" data-mod="${mi}" data-col="${ci}" data-blk="${bi}">×</button>
          </li>`;
      }).join('');
      return `
        <div class="cfg-col-card" data-col-card="${ci}">
          <div class="cfg-col-head">
            <b>列 ${ci + 1}</b>
            <label class="mini-check">宽度
              <select data-col-width class="cfg-mini-select">
                ${[12, 8, 7, 6, 5, 4, 3, 2].map(w => `<option value="${w}" ${Number(col.width) === w ? 'selected' : ''}>${w}/12</option>`).join('')}
              </select>
            </label>
            <button class="mini-btn" data-act="col-up" data-mod="${mi}" data-col="${ci}">↑</button>
            <button class="mini-btn" data-act="col-down" data-mod="${mi}" data-col="${ci}">↓</button>
            <button class="mini-btn danger" data-act="col-del" data-mod="${mi}" data-col="${ci}">删除列</button>
          </div>
          <ul class="cfg-blk-list">${blocks || '<li class="cfg-empty">（该列为空，请添加内容块）</li>'}</ul>
          <div class="cfg-col-actions">
            <button class="mini-btn" data-act="blk-add" data-mod="${mi}" data-col="${ci}" data-type="metrics">+ 指标组</button>
            <button class="mini-btn" data-act="blk-add" data-mod="${mi}" data-col="${ci}" data-type="chart">+ 图表</button>
            <button class="mini-btn" data-act="blk-add" data-mod="${mi}" data-col="${ci}" data-type="table">+ 统计表</button>
            <button class="mini-btn" data-act="blk-add" data-mod="${mi}" data-col="${ci}" data-type="note">+ 文字块</button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="cfg-mod-card" data-mod-card="${mi}">
        <div class="cfg-mod-head">
          <label class="mini-check"><input type="checkbox" data-mod-visible ${mod.visible !== false ? 'checked' : ''}/> 显示模块</label>
          <input type="text" data-mod-title value="${escapeHtml(mod.title || '')}" class="cfg-grow" placeholder="模块标题" />
          <label class="mini-check"><input type="checkbox" data-mod-showdetail ${mod.showDetail !== false ? 'checked' : ''}/> 显示「查看明细」</label>
          <button class="mini-btn" data-act="mod-up" data-mod="${mi}">↑</button>
          <button class="mini-btn" data-act="mod-down" data-mod="${mi}">↓</button>
          <button class="mini-btn danger" data-act="mod-del" data-mod="${mi}">删除模块</button>
        </div>
        <div class="cfg-col-wrap">${cols}</div>
        <div class="cfg-mod-actions">
          <button class="mini-btn" data-act="col-add" data-mod="${mi}">+ 添加列</button>
        </div>
      </div>`;
  }).join('');

  const metricsRows = (CFG.metrics || []).map((m, i) => `
    <tr data-metrics-row="${i}">
      <td><input type="checkbox" ${m.visible !== false ? 'checked' : ''}/></td>
      <td class="mono">${escapeHtml(m.id)}</td>
      <td>${escapeHtml(m.label || '')}</td>
      <td>${escapeHtml(m.unit || '')}</td>
      <td>${escapeHtml(m.sheet || (m.expr ? '公式' : ''))}</td>
      <td class="mono small">${m.expr ? escapeHtml(m.expr) : escapeHtml((m.agg || 'count') + (m.field ? '(' + m.field + ')' : ''))}</td>
      <td class="cfg-op-cell">
        <button class="mini-btn" data-act="metric-edit" data-i="${i}">编辑</button>
        <button class="mini-btn" data-act="metric-up" data-i="${i}">↑</button>
        <button class="mini-btn" data-act="metric-down" data-i="${i}">↓</button>
        <button class="mini-btn danger" data-act="metric-del" data-i="${i}">删</button>
      </td>
    </tr>`).join('');

  const chartsRows = (CFG.charts || []).map((c, i) => `
    <tr data-charts-row="${i}">
      <td><input type="checkbox" ${c.visible !== false ? 'checked' : ''}/></td>
      <td class="mono">${escapeHtml(c.id)}</td>
      <td>${escapeHtml(c.type || '')}</td>
      <td>${escapeHtml(c.sheet || '')}</td>
      <td>${escapeHtml(c.groupBy || '')}</td>
      <td class="mono small">${escapeHtml((c.agg || 'count') + (c.field ? '(' + c.field + ')' : ''))}</td>
      <td class="cfg-op-cell">
        <button class="mini-btn" data-act="chart-edit" data-i="${i}">编辑</button>
        <button class="mini-btn danger" data-act="chart-del" data-i="${i}">删</button>
      </td>
    </tr>`).join('');

  const tablesRows = (CFG.tables || []).map((x, i) => `
    <tr data-tables-row="${i}">
      <td><input type="checkbox" ${x.visible !== false ? 'checked' : ''}/></td>
      <td class="mono">${escapeHtml(x.id)}</td>
      <td>${escapeHtml(x.title || '')}</td>
      <td>${x.type === 'cross' ? '交叉表' : '分组表'}</td>
      <td>${escapeHtml(x.sheet || '')}</td>
      <td class="cfg-op-cell">
        <button class="mini-btn" data-act="table-edit" data-i="${i}">编辑</button>
        <button class="mini-btn danger" data-act="table-del" data-i="${i}">删</button>
      </td>
    </tr>`).join('');

  root.innerHTML = `
    <section class="cfg-section">
      <div class="cfg-head">① 文字与标题</div>
      <div class="cfg-body">
        ${buildForm(TEXT_FIELDS, CFG)}
        <div class="cfg-sub-title">副标题条目（顺序即显示顺序）</div>
        <ul class="cfg-list" id="sub-list">${subRows || '<li class="cfg-empty">（暂无）</li>'}</ul>
        <button class="mini-btn" data-act="sub-add">+ 添加副标题条目</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">② 主题配色</div>
      <div class="cfg-body">${buildForm(THEME_FIELDS, CFG)}</div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">③ 页面布局</div>
      <div class="cfg-body">${buildForm(LAYOUT_FIELDS, CFG)}</div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">④ 模块与布局（模块 → 列 → 内容块）</div>
      <div class="cfg-body">
        <p class="cfg-hint">每个模块横向分 12 栅格，列宽度之和建议不超过 12（超出会自动换行）。列内可纵向堆叠多个内容块。</p>
        <div id="mod-list">${moduleCards || '<p class="cfg-empty">（暂无模块，点下面按钮新增）</p>'}</div>
        <button class="mini-btn" data-act="mod-add">+ 添加模块</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">⑤ 指标卡片（数据链接 + 计算公式）</div>
      <div class="cfg-body">
        <p class="cfg-hint">数据链接 = 选哪个表、怎么算（计数/求和/平均…）、算哪个字段、筛选条件；计算公式 = 用 <code>{指标id}</code> 引用其它指标做四则运算。</p>
        <div class="cfg-table-wrap">
          <table class="cfg-table">
            <thead><tr><th>显示</th><th>ID</th><th>名称</th><th>单位</th><th>数据表</th><th>算法</th><th>操作</th></tr></thead>
            <tbody>${metricsRows || ''}</tbody>
          </table>
        </div>
        <button class="mini-btn" data-act="metric-add">+ 新增指标</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">⑥ 图表样式</div>
      <div class="cfg-body">
        <div class="cfg-table-wrap">
          <table class="cfg-table">
            <thead><tr><th>显示</th><th>ID</th><th>类型</th><th>数据表</th><th>分组</th><th>算法</th><th>操作</th></tr></thead>
            <tbody>${chartsRows || ''}</tbody>
          </table>
        </div>
        <button class="mini-btn" data-act="chart-add">+ 新增图表</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">⑦ 统计表</div>
      <div class="cfg-body">
        <div class="cfg-table-wrap">
          <table class="cfg-table">
            <thead><tr><th>显示</th><th>ID</th><th>标题</th><th>类型</th><th>数据表</th><th>操作</th></tr></thead>
            <tbody>${tablesRows || ''}</tbody>
          </table>
        </div>
        <button class="mini-btn" data-act="table-add">+ 新增统计表</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">⑧ 高级：直接编辑配置 JSON</div>
      <div class="cfg-body">
        <p class="cfg-hint">适合批量改动或复制粘贴。点「应用 JSON」会覆盖当前面板内容（尚未保存到服务器）。</p>
        <textarea id="cfg-json" class="cfg-json" rows="14" spellcheck="false">${escapeHtml(JSON.stringify(CFG, null, 2))}</textarea>
        <button class="mini-btn" data-act="json-apply">应用 JSON 到面板</button>
        <button class="mini-btn" data-act="json-refresh">把面板内容写回 JSON</button>
      </div>
    </section>
  `;
  window.__cfgDraft = CFG;
}

// ---- 面板事件（委派）----
let _cfgBound = false;
function bindConfigPanel() {
  if (_cfgBound) return;
  _cfgBound = true;

  document.getElementById('cfg-save').addEventListener('click', saveConfigFromPanel);
  document.getElementById('cfg-reload').addEventListener('click', () => {
    CFG = DashboardStore.getConfig() || CFG;
    renderConfigPanel();
    toast('已放弃未保存的修改');
  });
  document.getElementById('cfg-reset').addEventListener('click', async () => {
    const ok = await confirmDialog('确认恢复为默认看板配置？当前自定义的文字/布局/图表设置都会丢失（不影响数据）', '恢复默认配置');
    if (!ok) return;
    try {
      CFG = await DashboardStore.resetConfig();
      renderConfigPanel();
      toast('已恢复默认配置');
    } catch (e) {
      toast('恢复失败：' + e.message, 'error');
    }
  });

  document.getElementById('cfg-root').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const i = parseInt(btn.dataset.i, 10);
    const mi = parseInt(btn.dataset.mod, 10);
    const ci = parseInt(btn.dataset.col, 10);
    const bi = parseInt(btn.dataset.blk, 10);

    // 先从面板收集当前状态，保证用户输入不丢
    if (act !== 'sub-add' && act !== 'metric-add' && act !== 'chart-add' && act !== 'table-add'
      && act !== 'mod-add' && act !== 'blk-add' && act !== 'json-apply' && act !== 'json-refresh') {
      CFG = collectConfigFromPanel();
    }

    const move = (arr, from, to) => {
      if (to < 0 || to >= arr.length) return false;
      const [x] = arr.splice(from, 1);
      arr.splice(to, 0, x);
      return true;
    };

    try {
      if (act === 'sub-add') {
        CFG = collectConfigFromPanel();
        CFG.text.subtitleItems = (CFG.text.subtitleItems || []).concat([{ type: 'text', text: '新条目' }]);
      } else if (act === 'sub-del') {
        CFG.text.subtitleItems.splice(i, 1);
      } else if (act === 'sub-up') {
        move(CFG.text.subtitleItems, i, i - 1);
      } else if (act === 'sub-down') {
        move(CFG.text.subtitleItems, i, i + 1);
      } else if (act === 'mod-add') {
        CFG = collectConfigFromPanel();
        CFG.modules.push({
          id: 'm-' + Date.now().toString(36), visible: true, title: '新模块', sheet: SHEETS[0], showDetail: true,
          columns: [{ id: 'c-' + Date.now().toString(36), width: 12, blocks: [] }],
        });
      } else if (act === 'mod-del') {
        const ok = await confirmDialog('确认删除该模块？（模块内的布局配置会一并删除，数据表不受影响）', '删除模块');
        if (!ok) return;
        CFG.modules.splice(mi, 1);
      } else if (act === 'mod-up') {
        move(CFG.modules, mi, mi - 1);
      } else if (act === 'mod-down') {
        move(CFG.modules, mi, mi + 1);
      } else if (act === 'col-add') {
        CFG.modules[mi].columns.push({ id: 'c-' + Date.now().toString(36), width: 6, blocks: [] });
      } else if (act === 'col-del') {
        if (CFG.modules[mi].columns.length <= 1) { toast('每个模块至少保留 1 列', 'error'); return; }
        CFG.modules[mi].columns.splice(ci, 1);
      } else if (act === 'col-up') {
        move(CFG.modules[mi].columns, ci, ci - 1);
      } else if (act === 'col-down') {
        move(CFG.modules[mi].columns, ci, ci + 1);
      } else if (act === 'blk-add') {
        const type = btn.dataset.type;
        const blk = { id: 'b-' + Date.now().toString(36), type, visible: true, title: '' };
        if (type === 'chart') blk.refId = (CFG.charts[0] || {}).id || '';
        else if (type === 'table') blk.refId = (CFG.tables[0] || {}).id || '';
        else if (type === 'metrics') blk.metricIds = (CFG.metrics || []).slice(0, 3).map(m => m.id);
        else if (type === 'note') blk.text = '在这里写说明文字';
        CFG.modules[mi].columns[ci].blocks.push(blk);
      } else if (act === 'blk-del') {
        CFG.modules[mi].columns[ci].blocks.splice(bi, 1);
      } else if (act === 'blk-up') {
        move(CFG.modules[mi].columns[ci].blocks, bi, bi - 1);
      } else if (act === 'blk-down') {
        move(CFG.modules[mi].columns[ci].blocks, bi, bi + 1);
      } else if (act === 'blk-metrics') {
        await promptEditMetricList(mi, ci, bi);
        return;
      } else if (act === 'metric-add') {
        await promptEditMetric(-1);
        return;
      } else if (act === 'metric-edit') {
        await promptEditMetric(i);
        return;
      } else if (act === 'metric-del') {
        const m = CFG.metrics[i];
        const ok = await confirmDialog(`确认删除指标「${m.label || m.id}」？引用它的模块块与公式需要手动调整`, '删除指标');
        if (!ok) return;
        CFG.metrics.splice(i, 1);
      } else if (act === 'metric-up') {
        move(CFG.metrics, i, i - 1);
      } else if (act === 'metric-down') {
        move(CFG.metrics, i, i + 1);
      } else if (act === 'chart-add') {
        await promptEditChart(-1);
        return;
      } else if (act === 'chart-edit') {
        await promptEditChart(i);
        return;
      } else if (act === 'chart-del') {
        const c = CFG.charts[i];
        const ok = await confirmDialog(`确认删除图表「${c.id}」？使用它的块会变成空白`, '删除图表');
        if (!ok) return;
        CFG.charts.splice(i, 1);
      } else if (act === 'table-add') {
        await promptEditTable(-1);
        return;
      } else if (act === 'table-edit') {
        await promptEditTable(i);
        return;
      } else if (act === 'table-del') {
        const x = CFG.tables[i];
        const ok = await confirmDialog(`确认删除统计表「${x.title || x.id}」？使用它的块会变成空白`, '删除统计表');
        if (!ok) return;
        CFG.tables.splice(i, 1);
      } else if (act === 'json-apply') {
        const el = document.getElementById('cfg-json');
        const parsed = JSON.parse(el.value);
        if (!parsed || !Array.isArray(parsed.modules) || !Array.isArray(parsed.metrics)) {
          throw new Error('JSON 必须包含 modules 与 metrics 数组');
        }
        CFG = parsed;
      } else if (act === 'json-refresh') {
        CFG = collectConfigFromPanel();
        document.getElementById('cfg-json').value = JSON.stringify(CFG, null, 2);
        toast('已把面板内容写入 JSON');
        return;
      }
      renderConfigPanel();
    } catch (err) {
      toast(err.message || '操作失败', 'error');
    }
  });
}

/** 编辑指标 */
async function promptEditMetric(idx) {
  const isNew = idx < 0;
  const draft = isNew
    ? {
      id: 'm-' + Date.now().toString(36), label: '新指标', unit: '', decimals: 0, visible: true,
      sheet: SHEETS[0], agg: 'count', field: '', where: [],
      detail: { sheet: SHEETS[0] },
    }
    : deepCloneCfg(CFG.metrics[idx]);
  window.__cfgDraft = draft;

  const whereRows = (draft.where || []).map((w, i) => whereRowHtml(w, i, draft.sheet)).join('');
  const html = `
    ${buildForm(METRIC_FIELDS, draft)}
    <div class="cfg-sub-title">筛选条件（可选，全部满足才计入）</div>
    <div id="where-rows">${whereRows}</div>
    <button class="mini-btn" type="button" data-wact="add">+ 添加条件</button>
    <p class="cfg-hint">提示：填了「计算公式」时，上面的数据表/统计方式会被忽略，改用公式计算（公式可引用其它指标）。</p>
  `;

  await showMiniModal(isNew ? '新增指标' : ('编辑指标 · ' + (draft.label || draft.id)), html, async (root) => {
    const got = readForm(root, METRIC_FIELDS);
    const next = Object.assign(deepCloneCfg(draft), got);
    if (!next.id) { toast('请填写 ID', 'error'); return false; }
    if (!isNew && next.id !== draft.id && (CFG.metrics || []).some(m => m.id === next.id)) {
      toast('ID 已存在', 'error'); return false;
    }
    if (isNew && (CFG.metrics || []).some(m => m.id === next.id)) { toast('ID 已存在', 'error'); return false; }
    if (!next.detail) next.detail = {};
    // 筛选条件
    const where = [];
    root.querySelectorAll('#where-rows [data-wrow]').forEach(row => {
      const field = row.querySelector('[data-w-field]').value;
      const op = row.querySelector('[data-w-op]').value;
      const value = row.querySelector('[data-w-value]').value;
      if (field) where.push({ field, op, value });
    });
    next.where = where;
    // 清理空值
    Object.keys(next).forEach(k => { if (next[k] === '' && ['scale', 'fallbackScale', 'fallbackField', 'expr', 'field'].indexOf(k) >= 0) delete next[k]; });
    if (next.expr === '') delete next.expr;
    if (next.detail && next.detail.filterValue === '') delete next.detail.filterValue;

    CFG = collectConfigFromPanel();
    if (isNew) CFG.metrics.push(next);
    else CFG.metrics[idx] = next;
    renderConfigPanel();
    toast('已更新指标（记得点右上角「保存配置」）');
    return true;
  }, (root) => {
    // 数据表变化时刷新字段下拉
    const sheetSel = root.querySelector('[data-k="sheet"]');
    const fieldSel = root.querySelector('[data-k="field"]');
    const fbSel = root.querySelector('[data-k="fallbackField"]');
    const reffill = (sel, keep) => {
      if (!sel) return;
      const list = fieldOptions(sheetSel.value);
      sel.innerHTML = ['', ...list].map(s => `<option value="${escapeHtml(s)}" ${s === keep ? 'selected' : ''}>${s ? escapeHtml(s) : '（不指定）'}</option>`).join('');
    };
    if (sheetSel) sheetSel.addEventListener('change', () => {
      reffill(fieldSel, '');
      reffill(fbSel, '');
      root.querySelectorAll('#where-rows [data-w-field]').forEach(sel => {
        const list = fieldOptions(sheetSel.value);
        sel.innerHTML = list.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
      });
    });
    // 条件增删
    const rowsHost = root.querySelector('#where-rows');
    rowsHost.addEventListener('click', (ev) => {
      const del = ev.target.closest('[data-wdel]');
      if (!del) return;
      del.closest('[data-wrow]').remove();
    });
    const addBtn = root.querySelector('[data-wact="add"]');
    if (addBtn) addBtn.addEventListener('click', () => {
      const i = rowsHost.querySelectorAll('[data-wrow]').length;
      rowsHost.insertAdjacentHTML('beforeend', whereRowHtml({ field: '', op: '==', value: '' }, i, sheetSel ? sheetSel.value : SHEETS[0]));
    });
  });
}

function whereRowHtml(w, i, sheetName) {
  const fields = fieldOptions(sheetName);
  return `
    <div class="where-row" data-wrow="${i}">
      <select data-w-field>${fields.map(f => `<option value="${escapeHtml(f)}" ${f === w.field ? 'selected' : ''}>${escapeHtml(f)}</option>`).join('')}</select>
      <select data-w-op>${E.OPS.map(op => `<option value="${op}" ${op === (w.op || '==') ? 'selected' : ''}>${E.OP_LABEL[op]}</option>`).join('')}</select>
      <input type="text" data-w-value value="${escapeHtml(w.value || '')}" placeholder="值" />
      <button class="mini-btn danger" type="button" data-wdel>×</button>
    </div>`;
}

/** 选择指标组包含哪些指标 */
async function promptEditMetricList(mi, ci, bi) {
  const block = CFG.modules[mi].columns[ci].blocks[bi];
  const chosen = new Set(block.metricIds || []);
  const html = `
    <p class="cfg-hint">勾选该指标组要显示的指标（顺序按指标列表顺序）</p>
    <ul class="pick-list">
      ${(CFG.metrics || []).map(m => `
        <li><label class="mini-check"><input type="checkbox" value="${escapeHtml(m.id)}" ${chosen.has(m.id) ? 'checked' : ''}/> ${escapeHtml(m.label || m.id)} <span class="mono small">(${escapeHtml(m.id)})</span></label></li>`).join('')}
    </ul>`;
  await showMiniModal('选择指标', html, async (root) => {
    const ids = [...root.querySelectorAll('input[type="checkbox"]:checked')].map(x => x.value);
    CFG = collectConfigFromPanel();
    CFG.modules[mi].columns[ci].blocks[bi].metricIds = ids;
    renderConfigPanel();
    toast('已更新指标组');
    return true;
  });
}

/** 编辑图表 */
async function promptEditChart(idx) {
  const isNew = idx < 0;
  const draft = isNew
    ? {
      id: 'chart-' + Date.now().toString(36), title: '', visible: true, type: 'bar', sheet: SHEETS[0],
      groupBy: '', agg: 'count', field: '', where: [], colors: [], height: 240,
      legend: { show: true, position: 'bottom' }, label: { show: true, formatter: '{c}' },
      axis: { rotate: 0, yName: '' }, detail: { sheet: SHEETS[0], groupField: '' },
    }
    : deepCloneCfg(CFG.charts[idx]);
  window.__cfgDraft = draft;
  const d = deepCloneCfg(draft);
  d.colors = (d.colors || []).join(', ');

  await showMiniModal(isNew ? '新增图表' : ('编辑图表 · ' + (draft.id)), buildForm(CHART_FIELDS, d), async (root) => {
    const got = readForm(root, CHART_FIELDS);
    const next = Object.assign(deepCloneCfg(draft), got);
    if (!next.id) { toast('请填写 ID', 'error'); return false; }
    if ((CFG.charts || []).some((c, i) => c.id === next.id && i !== idx)) { toast('ID 已存在', 'error'); return false; }
    next.colors = csvToArr(got['colors']);
    // 瀑布图必需的三个列：没填就给出常用默认值，避免图表一片空白
    if (next.type === 'waterfall') {
      if (!next.stageField) next.stageField = '收支类型';
      if (!next.itemField) next.itemField = '经费项目';
      if (!next.field) next.field = '金额（万元）';
    }
    if (!next.detail) next.detail = {};
    CFG = collectConfigFromPanel();
    if (isNew) CFG.charts.push(next); else CFG.charts[idx] = next;
    renderConfigPanel();
    toast('已更新图表（记得点「保存配置」）');
    return true;
  }, (root) => {
    const sheetSel = root.querySelector('[data-k="sheet"]');
    const refill = (k, keep) => {
      const sel = root.querySelector(`[data-k="${k}"]`);
      if (!sel || !sheetSel) return;
      const list = fieldOptions(sheetSel.value);
      sel.innerHTML = ['', ...list].map(s => `<option value="${escapeHtml(s)}" ${s === keep ? 'selected' : ''}>${s ? escapeHtml(s) : '（不指定）'}</option>`).join('');
    };
    if (sheetSel) sheetSel.addEventListener('change', () => {
      refill('groupBy', ''); refill('field', ''); refill('stageField', ''); refill('itemField', ''); refill('detail.groupField', '');
    });
  });
}

/** 编辑统计表 */
async function promptEditTable(idx) {
  const isNew = idx < 0;
  const draft = isNew
    ? {
      id: 'tbl-' + Date.now().toString(36), title: '新统计表', visible: true, type: 'group',
      sheet: SHEETS[0], groupBy: '', columns: [{ label: '数量', agg: 'count' }],
      sortBy: 'valueDesc', limit: 0, detail: { sheet: SHEETS[0], filterField: '' },
    }
    : deepCloneCfg(CFG.tables[idx]);
  window.__cfgDraft = draft;
  const colsRows = (draft.columns || []).map((c, i) => statsColHtml(c, i, draft.sheet)).join('');
  const crossRows = (draft.crossColumns || []).map((c, i) => crossColHtml(c, i)).join('');

  const html = `
    ${buildForm(TABLE_FIELDS, draft)}
    <div class="cfg-sub-title">统计列（分组表用）</div>
    <div id="stat-rows">${colsRows}</div>
    <button class="mini-btn" type="button" data-sact="add">+ 添加统计列</button>
    <div class="cfg-sub-title">交叉列（交叉表用）</div>
    <div id="cross-rows">${crossRows}</div>
    <button class="mini-btn" type="button" data-cact="add">+ 添加交叉列</button>
  `;

  await showMiniModal(isNew ? '新增统计表' : ('编辑统计表 · ' + (draft.title || draft.id)), html, async (root) => {
    const got = readForm(root, TABLE_FIELDS);
    const next = Object.assign(deepCloneCfg(draft), got);
    if (!next.id) { toast('请填写 ID', 'error'); return false; }
    if ((CFG.tables || []).some((x, i) => x.id === next.id && i !== idx)) { toast('ID 已存在', 'error'); return false; }

    next.columns = [];
    root.querySelectorAll('#stat-rows [data-srow]').forEach(row => {
      const label = row.querySelector('[data-s-label]').value;
      const agg = row.querySelector('[data-s-agg]').value;
      const field = row.querySelector('[data-s-field]') ? row.querySelector('[data-s-field]').value : '';
      const dec = row.querySelector('[data-s-dec]') ? row.querySelector('[data-s-dec]').value : '';
      const item = { label: label || E.AGG_LABEL[agg] || '数量', agg };
      if (field) item.field = field;
      if (dec !== '') item.decimals = Number(dec);
      next.columns.push(item);
    });
    next.crossColumns = [];
    root.querySelectorAll('#cross-rows [data-crow]').forEach(row => {
      const key = row.querySelector('[data-c-key]').value;
      const label = row.querySelector('[data-c-label]').value;
      if (key) next.crossColumns.push({ key, label: label || key });
    });
    if (!next.columns.length && next.type === 'group') next.columns = [{ label: '数量', agg: 'count' }];

    CFG = collectConfigFromPanel();
    if (isNew) CFG.tables.push(next); else CFG.tables[idx] = next;
    renderConfigPanel();
    toast('已更新统计表（记得点「保存配置」）');
    return true;
  }, (root) => {
    const sheetSel = root.querySelector('[data-k="sheet"]');
    const refill = (k, keep) => {
      const sel = root.querySelector(`[data-k="${k}"]`);
      if (!sel || !sheetSel) return;
      const list = fieldOptions(sheetSel.value);
      sel.innerHTML = ['', ...list].map(s => `<option value="${escapeHtml(s)}" ${s === keep ? 'selected' : ''}>${s ? escapeHtml(s) : '（不指定）'}</option>`).join('');
    };
    if (sheetSel) sheetSel.addEventListener('change', () => { refill('groupBy', ''); refill('rowField', ''); refill('colField', ''); refill('detail.filterField', ''); });

    const statHost = root.querySelector('#stat-rows');
    statHost.addEventListener('click', ev => {
      const del = ev.target.closest('[data-sdel]');
      if (del) del.closest('[data-srow]').remove();
    });
    const crossHost = root.querySelector('#cross-rows');
    crossHost.addEventListener('click', ev => {
      const del = ev.target.closest('[data-cdel]');
      if (del) del.closest('[data-crow]').remove();
    });
    root.querySelector('[data-sact="add"]').addEventListener('click', () => {
      const i = statHost.querySelectorAll('[data-srow]').length;
      statHost.insertAdjacentHTML('beforeend', statsColHtml({ label: '数量', agg: 'count' }, i, sheetSel ? sheetSel.value : SHEETS[0]));
    });
    root.querySelector('[data-cact="add"]').addEventListener('click', () => {
      const i = crossHost.querySelectorAll('[data-crow]').length;
      crossHost.insertAdjacentHTML('beforeend', crossColHtml({ key: '', label: '' }, i));
    });
  });
}

function statsColHtml(c, i, sheetName) {
  const fields = fieldOptions(sheetName);
  const aggs = [['count', '计数'], ['sum', '求和'], ['avg', '平均'], ['max', '最大值'], ['min', '最小值'], ['distinct', '去重计数']];
  return `
    <div class="where-row" data-srow="${i}">
      <input type="text" data-s-label value="${escapeHtml(c.label || '')}" placeholder="列名" />
      <select data-s-agg>${aggs.map(([v, l]) => `<option value="${v}" ${v === (c.agg || 'count') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-s-field>${['', ...fields].map(f => `<option value="${escapeHtml(f)}" ${f === c.field ? 'selected' : ''}>${f ? escapeHtml(f) : '（不指定）'}</option>`).join('')}</select>
      <input type="text" data-s-dec value="${c.decimals === undefined ? '' : c.decimals}" placeholder="小数位" style="width:70px" />
      <button class="mini-btn danger" type="button" data-sdel>×</button>
    </div>`;
}

function crossColHtml(c, i) {
  return `
    <div class="where-row" data-crow="${i}">
      <input type="text" data-c-key value="${escapeHtml(c.key || '')}" placeholder="字段值（如 已组建）" />
      <input type="text" data-c-label value="${escapeHtml(c.label || '')}" placeholder="显示表头" />
      <button class="mini-btn danger" type="button" data-cdel>×</button>
    </div>`;
}

// ============ 经费瀑布（桥梁）图 ============
// 数据表「05-经费瀑布」是长表：一行 = 某工会的一个科目。
// 后台提供：① 逐行编辑（通用表格）② 按工会的「瀑布图编辑」弹窗 ③ 新增工会组织。

function fundSheetRows() {
  const s = DATA && DATA[FUND_SHEET];
  return s && Array.isArray(s.rows) ? s.rows : [];
}

/** 把长表行按工会聚合成编辑用的模型。认不出阶段/工会名为空的行放进 orphans，保存时原样带回（绝不静默丢数据） */
function fundBuildModel() {
  const model = {};
  const orphans = [];
  fundSheetRows().forEach(r => {
    const name = String(r[FUND_COLS.union] == null ? '' : r[FUND_COLS.union]).trim();
    if (!name) { orphans.push(r); return; }
    if (!model[name]) {
      model[name] = { name, full: String(r[FUND_COLS.full] || ''), initial: [], income: [], expense: [], manual: null };
    }
    const m = model[name];
    if (!m.full) m.full = String(r[FUND_COLS.full] || '');
    const stage = String(r[FUND_COLS.stage] || (r['收支类型'] || '')).trim();
    const amount = Number(r[FUND_COLS.amount]);
    const item = {
      item: String(r[FUND_COLS.item] == null ? '' : r[FUND_COLS.item]),
      amount: Number.isFinite(amount) ? amount : 0,
    };
    if (stage === '期初') m.initial.push(item);
    else if (stage === '入账') m.income.push(item);
    else if (stage === '支出') m.expense.push(item);
    else if (stage === '结余') m.manual = item.amount;
    else orphans.push(r);
  });
  // 没有期初行的工会补一条空的，界面上才有的改
  Object.keys(model).forEach(k => { if (!model[k].initial.length) model[k].initial.push({ item: '上年结转', amount: 0 }); });
  return { model, orphans };
}

function fundBalanceOf(m) {
  const sum = arr => arr.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const initial = sum(m.initial), income = sum(m.income), expense = sum(m.expense);
  return {
    initial, income, expense,
    balance: m.manual === null ? initial + income - expense : m.manual,
  };
}

function fundModelToRows(model, orphans) {
  const rows = [];
  Object.keys(model).forEach(name => {
    const m = model[name];
    const push = (stage, it) => rows.push({
      [FUND_COLS.union]: name,
      [FUND_COLS.full]: m.full || '',
      [FUND_COLS.stage]: stage,
      [FUND_COLS.item]: it.item || '未命名',
      [FUND_COLS.amount]: Number.isFinite(Number(it.amount)) ? Number(it.amount) : 0,
      [FUND_COLS.note]: '',
    });
    (m.initial || []).forEach(it => push('期初', it));
    (m.income || []).forEach(it => push('入账', it));
    (m.expense || []).forEach(it => push('支出', it));
    if (m.manual !== null) push('结余', { item: '手工指定', amount: m.manual });
  });
  // 认不出阶段的行原样带回（比如用户填了自定义收支类型），不能悄悄删掉
  (orphans || []).forEach(r => rows.push(r));
  return rows;
}

/** 科目行（期初/入账/支出）的编辑行 HTML */
function fundItemRowHtml(stage, it, i) {
  const cls = stage === '入账' ? 'wf-in' : stage === '支出' ? 'wf-out' : 'wf-init';
  return `
    <tr class="wf-item ${cls}" data-wf-item="${i}" data-wf-stage="${escapeHtml(stage)}">
      <td class="wf-stage">${escapeHtml(stage)}</td>
      <td><input type="text" class="wf-item-name" data-wf-name value="${escapeHtml(it.item || '')}" placeholder="项目名称" /></td>
      <td><input type="text" inputmode="decimal" class="wf-item-amt" data-wf-amt value="${it.amount === 0 ? '0' : (it.amount === undefined ? '' : it.amount)}" placeholder="0" /></td>
      <td><button class="mini-btn danger" type="button" data-wf-del>×</button></td>
    </tr>`;
}

function fundUnionPanelHtml(m) {
  const b = fundBalanceOf(m);
  const fmt = v => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '0.00');
  const rows = []
    .concat((m.initial || []).map((it, i) => fundItemRowHtml('期初', it, i)))
    .concat((m.income || []).map((it, i) => fundItemRowHtml('入账', it, i)))
    .concat((m.expense || []).map((it, i) => fundItemRowHtml('支出', it, i)))
    .join('');
  return `
    <div class="wf-main-head">
      <label class="wf-field">工会名称<input type="text" id="wf-union-name" value="${escapeHtml(m.name)}" /></label>
      <label class="wf-field grow">工会全称<input type="text" id="wf-union-full" value="${escapeHtml(m.full || '')}" /></label>
      <button class="mini-btn danger" type="button" id="wf-del-union">删除该工会</button>
    </div>
    <table class="wf-table">
      <thead><tr><th style="width:70px">阶段</th><th>项目</th><th style="width:120px">金额（万元）</th><th style="width:40px"></th></tr></thead>
      <tbody id="wf-rows">${rows || '<tr class="wf-empty"><td colspan="4">（还没有科目，点下面按钮添加）</td></tr>'}</tbody>
    </table>
    <div class="wf-add-row">
      <button class="mini-btn" type="button" data-wf-add="入账">＋ 添加入账项</button>
      <button class="mini-btn" type="button" data-wf-add="支出">＋ 添加支出项</button>
      <button class="mini-btn" type="button" data-wf-add="期初">＋ 添加期初项</button>
    </div>
    <div class="wf-sum">
      <span>期初 <b>${fmt(b.initial)}</b></span>
      <span>＋ 入账 <b class="wf-in-text">${fmt(b.income)}</b></span>
      <span>－ 支出 <b class="wf-out-text">${fmt(b.expense)}</b></span>
      <span>＝ 结余 <b class="wf-bal-text">${fmt(b.balance)}</b> 万元</span>
      <label class="wf-manual"><input type="checkbox" id="wf-manual" ${m.manual !== null ? 'checked' : ''}/> 手工指定结余</label>
      <input type="text" inputmode="decimal" id="wf-balance" class="wf-item-amt" value="${m.manual === null ? '' : m.manual}" ${m.manual === null ? 'disabled' : ''} />
    </div>
    <p class="cfg-hint">结余默认自动计算（期初＋入账－支出）。勾「手工指定」可强行填写（例如账实不符需要手工平账）。金额单位：万元，最多 2 位小数。</p>
  `;
}

/**
 * 结余合计交叉核对：瀑布表各工会结余之和 vs「04-经费收支」的当前结余之和。
 * 两张表都能录入金额，口径不一致时看板上会出现「两处数字打架」，这里先提醒。
 */
function fundCrossCheckHtml(model) {
  const sum = Object.keys(model).reduce((s, k) => s + (Number(fundBalanceOf(model[k]).balance) || 0), 0);
  const num = v => {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const fund = DATA && DATA['04-经费收支'];
  let ref = null;
  if (fund && Array.isArray(fund.rows)) {
    const H = fund.headers || [];
    const hasCol = H.indexOf('当前结余（万元）') >= 0 || H.indexOf('当前结余（元）') >= 0;
    if (hasCol) {
      ref = fund.rows.reduce((s, r) => {
        const w = num(DashboardStore.pickValue(r, H, '当前结余（万元）'));
        if (w !== null) return s + w;
        const y = num(DashboardStore.pickValue(r, H, '当前结余（元）'));
        return s + (y !== null ? y / 10000 : 0);
      }, 0);
    }
  }
  const f2 = v => Number(v).toFixed(2);
  if (ref === null) {
    return `<span>全部工会结余合计 <b class="wf-bal-text">${f2(sum)}</b> 万元</span>`;
  }
  const diff = sum - ref;
  const bad = Math.abs(diff) > 0.011;
  return `<span>全部工会结余合计 <b class="wf-bal-text">${f2(sum)}</b> 万元</span>`
    + `<span>「04-经费收支」结余合计 <b>${f2(ref)}</b> 万元</span>`
    + (bad
      ? `<span class="wf-diff">⚠ 相差 ${f2(Math.abs(diff))} 万元，建议核对（否则看板上两张图的数字会不一致）</span>`
      : `<span class="wf-ok">✓ 与经费收支表一致</span>`);
}

function fundSideHtml(model, active) {
  const names = Object.keys(model);
  if (!names.length) return '<ul class="wf-union-list"><li class="wf-empty">（还没有工会，点「＋ 新增工会」）</li></ul>';
  return `<ul class="wf-union-list">${names.map(n => {
    const b = fundBalanceOf(model[n]);
    return `<li data-wf-union="${escapeHtml(n)}" class="${n === active ? 'active' : ''}">
      <span class="wf-union-name">${escapeHtml(n)}</span>
      <span class="wf-union-bal">${Number(b.balance).toFixed(2)}</span>
    </li>`;
  }).join('')}</ul>`;
}

/** 「🌉 瀑布图编辑」：按工会编辑期初 / 入账项 / 支出项 / 结余 */
async function openFundEditor() {
  if (!DATA || !DATA[FUND_SHEET]) { toast('未找到「05-经费瀑布」表，请刷新页面', 'error'); return; }
  const { model, orphans } = fundBuildModel();
  let active = Object.keys(model)[0] || '';

  const shell = `
    <div class="wf-wrap">
      <div class="wf-side">
        <div class="wf-side-head"><b>工会组织</b><button class="mini-btn" type="button" id="wf-add-union">＋ 新增工会</button></div>
        <div id="wf-side-list">${fundSideHtml(model, active)}</div>
      </div>
      <div class="wf-main" id="wf-main">${active ? fundUnionPanelHtml(model[active]) : '<p class="cfg-empty">请先在左侧新增工会</p>'}</div>
    </div>
    <div class="wf-cross" id="wf-cross">${fundCrossCheckHtml(model)}</div>`;

  /** 把当前面板里的输入写回 model（切换工会 / 保存前都要先做，否则改动会丢） */
  const collect = (root) => {
    if (!active || !model[active]) return;
    const m = model[active];
    const nameEl = root.querySelector('#wf-union-name');
    const fullEl = root.querySelector('#wf-union-full');
    if (nameEl) {
      const nn = String(nameEl.value || '').trim();
      if (nn && nn !== m.name) {           // 改名：把整组搬到新名字下
        model[nn] = m; delete model[m.name]; m.name = nn; active = nn;
      }
    }
    if (fullEl) m.full = String(fullEl.value || '');

    const groups = { 期初: [], 入账: [], 支出: [] };
    root.querySelectorAll('#wf-rows [data-wf-item]').forEach(tr => {
      const stage = tr.dataset.wfStage;
      const item = tr.querySelector('[data-wf-name]').value.trim();
      const raw = tr.querySelector('[data-wf-amt]').value.trim();
      const amt = raw === '' ? 0 : Number(raw);
      if (!groups[stage]) return;
      groups[stage].push({ item: item || '未命名', amount: Number.isFinite(amt) ? amt : 0 });
    });
    m.initial = groups['期初'] || [];
    m.income = groups['入账'] || [];
    m.expense = groups['支出'] || [];

    const manualCb = root.querySelector('#wf-manual');
    const balEl = root.querySelector('#wf-balance');
    if (manualCb && manualCb.checked) {
      const raw = String(balEl.value || '').trim();
      const v = raw === '' ? 0 : Number(raw);
      m.manual = Number.isFinite(v) ? v : 0;
    } else {
      m.manual = null;
    }
  };

  const repaint = (root) => {
    root.querySelector('#wf-side-list').innerHTML = fundSideHtml(model, active);
    const main = root.querySelector('#wf-main');
    main.innerHTML = active && model[active] ? fundUnionPanelHtml(model[active]) : '<p class="cfg-empty">请先在左侧新增工会</p>';
    main.querySelectorAll('.wf-item-amt').forEach(inp => attachNumberGuard(inp, {}));
    const cross = root.querySelector('#wf-cross');
    if (cross) cross.innerHTML = fundCrossCheckHtml(model);
  };

  await showMiniModal('经费瀑布（桥梁）图编辑', shell, async (root) => {
    collect(root);
    // 校验：工会名不能为空 / 重名已由 collect 处理
    const bad = Object.keys(model).filter(n => !n.trim());
    if (bad.length) { toast('工会名称不能为空', 'error'); return false; }
    setSync('syncing');
    try {
      await DashboardStore.updateSheet(FUND_SHEET, fundModelToRows(model, orphans));
      toast('已保存，看板瀑布图会实时刷新');
      setTimeout(() => refreshSyncBadge(), 600);
      return true;
    } catch (e) {
      console.error(e);
      toast('保存失败：' + (e.message || e), 'error');
      setSync('error', '保存失败');
      return false;
    }
  }, (root) => {
    repaint(root);

    root.addEventListener('click', async (ev) => {
      // 切换工会
      const li = ev.target.closest('[data-wf-union]');
      if (li) {
        collect(root);
        active = li.dataset.wfUnion;
        repaint(root);
        return;
      }
      // 删除科目行
      const del = ev.target.closest('[data-wf-del]');
      if (del) { del.closest('[data-wf-item]').remove(); return; }
      // 添加科目行
      const add = ev.target.closest('[data-wf-add]');
      if (add) {
        const stage = add.dataset.wfAdd;
        const host = root.querySelector('#wf-rows');
        host.querySelectorAll('.wf-empty').forEach(x => x.remove());
        const n = host.querySelectorAll('[data-wf-item]').length;
        host.insertAdjacentHTML('beforeend', fundItemRowHtml(stage, { item: '', amount: 0 }, n));
        host.querySelectorAll('.wf-item-amt').forEach(inp => attachNumberGuard(inp, {}));
        const last = host.querySelector(`[data-wf-item="${n}"] [data-wf-name]`);
        if (last) last.focus();
        return;
      }
      // 删除整个工会
      if (ev.target.closest('#wf-del-union')) {
        if (!active) return;
        const ok = await confirmDialog(`确认删除工会「${active}」的全部经费科目？该工会会从瀑布图上消失（不影响其它数据表）`, '删除工会');
        if (!ok) return;
        delete model[active];
        active = Object.keys(model)[0] || '';
        repaint(root);
        return;
      }
      // 新增工会
      if (ev.target.closest('#wf-add-union')) {
        const added = await promptAddUnion();
        if (added) {
          // 新工会已经写进 DATA 了，把它并进当前正在编辑的模型（不清掉未保存的改动）
          const fresh = fundBuildModel().model;
          Object.keys(fresh).forEach(k => { if (!model[k]) model[k] = fresh[k]; });
          active = added;
          repaint(root);
        }
        return;
      }
    });

    root.addEventListener('change', (ev) => {
      if (ev.target.id !== 'wf-manual') return;
      const bal = root.querySelector('#wf-balance');
      if (!bal) return;
      bal.disabled = !ev.target.checked;
      if (ev.target.checked) {
        collect(root);
        const m = model[active];
        bal.value = m ? Number(fundBalanceOf(m).balance).toFixed(2) : '';
        bal.focus();
      }
    });
  });
}

/** 「＋ 新增工会组织」：一次把工会登记进组织建设表 + 瀑布表，看板上立刻可见 */
async function promptAddUnion() {
  const orgSchema = (DashboardStore.getSchema('01-组织建设') || {}).schema || {};
  const levelOpts = (orgSchema['工会级别'] && orgSchema['工会级别'].options) || ['一级工会', '二级工会', '三级工会'];
  const statusOpts = (orgSchema['组建状态'] && orgSchema['组建状态'].options) || ['已组建', '筹建中'];
  // 入账项目不该把「上年结转」列进来（那是期初用的）
  const projOpts = ((DashboardStore.BUILTIN_SCHEMA[FUND_SHEET]['经费项目'] || {}).options || ['上级工会反拨'])
    .filter(o => o !== '上年结转');
  const defaultProj = projOpts.indexOf('上级工会反拨') >= 0 ? '上级工会反拨' : projOpts[0];

  const html = `
    <div class="form-grid">
      <label class="form-field">工会名称（简称，瀑布图上显示的那个）<input type="text" id="u-name" placeholder="如：汕头二店工会" /></label>
      <label class="form-field">工会全称<input type="text" id="u-full" placeholder="选填" /></label>
      <label class="form-field">依托公司<input type="text" id="u-company" placeholder="选填，默认同工会全称" /></label>
      <label class="form-field">工会级别<select id="u-level">${levelOpts.map(o => `<option value="${escapeHtml(o)}" ${o === '三级工会' ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>
      <label class="form-field">组建状态<select id="u-status">${statusOpts.map(o => `<option value="${escapeHtml(o)}" ${o === '已组建' ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>
      <label class="form-field">期初金额（万元）<input type="text" inputmode="decimal" id="u-initial" value="0" /></label>
      <label class="form-field">首笔入账项目<select id="u-proj">${projOpts.map(o => `<option value="${escapeHtml(o)}" ${o === defaultProj ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></label>
      <label class="form-field">首笔入账金额（万元，可留空）<input type="text" inputmode="decimal" id="u-amount" value="" /></label>
      <label class="form-field check full"><input type="checkbox" id="u-to-org" checked /> 同时登记到「一、组织建设」表（工会总数 / 组建率等指标会同步更新）</label>
      <label class="form-field check full"><input type="checkbox" id="u-to-fund" checked /> 同时登记到「05-经费瀑布」表（瀑布图上立刻出现这一行）</label>
    </div>
    <p class="cfg-hint">金额单位：万元，最多 2 位小数。建好后可随时在「🌉 瀑布图编辑」里补录更多入账/支出项目。</p>`;

  let created = null;
  await showMiniModal('新增工会组织', html, async (root) => {
    const name = String(root.querySelector('#u-name').value || '').trim();
    if (!name) { toast('请填写工会名称', 'error'); return false; }
    const full = String(root.querySelector('#u-full').value || '').trim();
    const company = String(root.querySelector('#u-company').value || '').trim() || full || name;
    const level = root.querySelector('#u-level').value;
    const status = root.querySelector('#u-status').value;
    const initialRaw = String(root.querySelector('#u-initial').value || '').trim();
    const amountRaw = String(root.querySelector('#u-amount').value || '').trim();
    const proj = root.querySelector('#u-proj').value;
    const toOrg = root.querySelector('#u-to-org').checked;
    const toFund = root.querySelector('#u-to-fund').checked;

    if (initialRaw && !NUM_PATTERN.test(initialRaw)) { toast('期初金额最多 2 位小数', 'error'); return false; }
    if (amountRaw && !NUM_PATTERN.test(amountRaw)) { toast('入账金额最多 2 位小数', 'error'); return false; }

    // 重名检查（瀑布表里已经有这个工会就没必要再建）
    const exists = fundSheetRows().some(r => String(r[FUND_COLS.union] || '').trim() === name);
    if (toFund && exists) { toast(`工会「${name}」已经在瀑布表里了`, 'error'); return false; }

    setSync('syncing');
    try {
      // ⚠️ 必须一次提交：addRow 每调一次就 PUT 一整份数据并触发 SSE 广播，
      // 广播回来前端会重新 GET 一次数据 —— 连续 addRow 会互相覆盖，
      // 表现就是「只写进去了第一行，后面的凭空消失」。
      // 所以这里在内存里把要加的行都准备好，最后 replaceAll 一次落库。
      const next = JSON.parse(JSON.stringify(DashboardStore.getData() || {}));
      if (toOrg && next['01-组织建设'] && Array.isArray(next['01-组织建设'].rows)) {
        next['01-组织建设'].rows.push({
          工会名称: name, 依托公司: company, 工会主席: '', 职工人数: '',
          组建状态: status, 工会级别: level, 备注: '由「新增工会组织」创建',
        });
      }
      if (toFund && next[FUND_SHEET] && Array.isArray(next[FUND_SHEET].rows)) {
        const base = { [FUND_COLS.union]: name, [FUND_COLS.full]: full || '', [FUND_COLS.note]: '新建工会' };
        const fundRows = [];
        if (initialRaw !== '') {
          fundRows.push(Object.assign({}, base, {
            [FUND_COLS.stage]: '期初', [FUND_COLS.item]: '上年结转', [FUND_COLS.amount]: Number(initialRaw),
          }));
        }
        if (amountRaw !== '') {
          fundRows.push(Object.assign({}, base, {
            [FUND_COLS.stage]: '入账', [FUND_COLS.item]: proj, [FUND_COLS.amount]: Number(amountRaw),
          }));
        }
        if (!fundRows.length) {
          fundRows.push(Object.assign({}, base, {
            [FUND_COLS.stage]: '期初', [FUND_COLS.item]: '上年结转', [FUND_COLS.amount]: 0,
          }));
        }
        fundRows.forEach(r => next[FUND_SHEET].rows.push(r));
      }
      await DashboardStore.replaceAll(next);
      created = name;
      toast('已新增工会组织「' + name + '」，看板已同步');
      setTimeout(() => refreshSyncBadge(), 600);
      return true;
    } catch (e) {
      console.error(e);
      toast('新增失败：' + (e.message || e), 'error');
      setSync('error', '新增失败');
      return false;
    }
  }, (root) => {
    ['#u-initial', '#u-amount'].forEach(sel => {
      const el = root.querySelector(sel);
      if (el) attachNumberGuard(el, {});
    });
  });
  if (created) refreshAll();
  return created;
}

async function saveConfigFromPanel() {
  try {
    CFG = collectConfigFromPanel();
    const { errors: errs, warnings: warns } = validateConfig(CFG);
    if (errs.length) throw new Error(errs[0]);
    if (warns.length) console.warn('[看板配置] 提醒：\n - ' + warns.join('\n - '));
    setSync('syncing');
    await DashboardStore.saveConfig(CFG);
    CFG = DashboardStore.getConfig() || CFG;
    renderConfigPanel();
    if (warns.length) toast('已保存，但有 ' + warns.length + ' 处提醒：' + warns[0]);
    else toast('看板配置已保存，看板端会实时刷新');
    if (warns.length) showConfigWarnings(warns);
    setTimeout(() => refreshSyncBadge(), 600);
  } catch (e) {
    console.error(e);
    toast('保存失败：' + (e.message || e), 'error');
    setSync('error', '保存失败');
  }
}

/** 把「保存成功但不完美」的地方常驻显示在配置面板顶部，避免静默出错 */
function showConfigWarnings(list) {
  const host = document.getElementById('cfg-root');
  if (!host) return;
  let box = document.getElementById('cfg-warn-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cfg-warn-box';
    box.className = 'cfg-warn-box';
    host.prepend(box);
  }
  box.innerHTML = `<b>⚠️ 需要留意（不影响保存）</b><ul>${list.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
}

/**
 * 校验配置。
 * errors   —— 会真正把看板弄坏，直接拦住保存；
 * warnings —— 不拦，但必须告诉用户（否则会「静默出错」：卡片/图表变空白）。
 *
 * 注意：列宽之和 > 12 属于合法排版（超出会自动换行，最初版配置就是这么排的），
 * 只能当警告。之前把它当错误硬拦，导致用户为了能保存而去改列宽，把原本的布局改坏了。
 */
function validateConfig(cfg) {
  const errs = [];
  const warns = [];
  const ids = (cfg.metrics || []).map(m => m.id);
  if (ids.some(x => !x)) errs.push('有指标未填写 ID');
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) errs.push('指标 ID 重复：' + [...new Set(dup)].join('、'));
  (cfg.charts || []).forEach(c => {
    if (!c.id) errs.push('有图表未填写 ID');
    // 瀑布（桥梁）图缺了阶段/金额列就画不出任何柱子，直接拦住
    if (c.type === 'waterfall') {
      if (!c.groupBy) errs.push(`瀑布图「${c.id}」未选择分组字段（一般是「工会名称」，决定图上每一行）`);
      if (!c.field) errs.push(`瀑布图「${c.id}」未选择金额字段（一般是「金额（万元）」）`);
      if (!c.stageField) errs.push(`瀑布图「${c.id}」未选择阶段字段（值应为 期初 / 入账 / 支出 / 结余）`);
    }
  });
  (cfg.tables || []).forEach(t => {
    if (!t.id) errs.push('有统计表未填写 ID');
    if (t.type === 'group' && !t.groupBy) errs.push(`统计表「${t.title || t.id}」未选择分组字段`);
    if (t.type === 'cross' && (!t.rowField || !t.colField)) errs.push(`交叉表「${t.title || t.id}」需选择行字段与列字段`);
  });
  (cfg.metrics || []).forEach(m => {
    if (m.expr) {
      const refs = String(m.expr).match(/\{([^}]+)\}/g) || [];
      refs.forEach(r => {
        const id = r.slice(1, -1).trim();
        if (ids.indexOf(id) < 0) errs.push(`指标「${m.label || m.id}」的公式引用了不存在的指标 {${id}}`);
      });
    } else if (m.agg !== 'count' && m.agg !== 'distinct' && !m.field) {
      errs.push(`指标「${m.label || m.id}」的统计方式需要选择字段`);
    }
  });
  // 色板：必须是合法颜色数组，否则图表会整张渲染失败
  const pal = cfg.theme && cfg.theme.palette;
  const palList = Array.isArray(pal) ? pal : (typeof pal === 'string' ? csvToArr(pal) : []);
  const badColors = palList.filter(x => !/^#([0-9a-f]{3,8})$/i.test(String(x).trim()) && !/^(rgb|rgba|hsl|hsla)\(/i.test(String(x).trim()) && !/^[a-z]{3,20}$/i.test(String(x).trim()));
  if (!palList.length) errs.push('图表色板不能为空（图表会失去配色）');
  else if (badColors.length) errs.push('图表色板里有无法识别的颜色：' + badColors.slice(0, 3).join('、'));

  const chartIds = (cfg.charts || []).map(c => c.id);
  const tableIds = (cfg.tables || []).map(t => t.id);
  (cfg.modules || []).forEach(m => {
    const widths = (m.columns || []).map(x => Number(x.width) || 0);
    const total = widths.reduce((s, x) => s + x, 0);
    if (total > 12) warns.push(`模块「${m.title}」各列宽度之和为 ${total}，超出部分会自动换行显示`);
    (m.columns || []).forEach(c => {
      (c.blocks || []).forEach(b => {
        if (b.type === 'chart' && !b.refId) errs.push(`模块「${m.title}」有内容块未选择图表`);
        if (b.type === 'table' && !b.refId) errs.push(`模块「${m.title}」有内容块未选择统计表`);
        // 悬空引用：块指向了已删除的指标/图表/统计表 → 看板上会凭空少一块，必须提示
        const missMetrics = (b.metricIds || []).filter(x => ids.indexOf(x) < 0);
        if (missMetrics.length) warns.push(`模块「${m.title}」有个指标组引用了不存在的指标：${missMetrics.join('、')}（该卡片会显示为空白）`);
        if (b.type === 'chart' && b.refId && chartIds.indexOf(b.refId) < 0) warns.push(`模块「${m.title}」引用了不存在的图表「${b.refId}」`);
        if (b.type === 'table' && b.refId && tableIds.indexOf(b.refId) < 0) warns.push(`模块「${m.title}」引用了不存在的统计表「${b.refId}」`);
      });
    });
  });
  const unused = ids.filter(id => id && !(cfg.modules || []).some(m => (m.columns || []).some(c => (c.blocks || []).some(b => (b.metricIds || []).indexOf(id) >= 0))));
  if (unused.length) warns.push(`有 ${unused.length} 个指标没有放进任何模块，看板上看不到：${unused.slice(0, 5).join('、')}`);
  return { errors: errs, warnings: [...new Set(warns)] };
}

// ============ 安全设置面板 ============
function renderSecurityPanel() {
  const root = document.getElementById('sec-root');
  if (!root) return;
  const status = DashboardStore.getStatus();
  const isApi = status.mode === 'api';
  root.innerHTML = `
    <section class="cfg-section">
      <div class="cfg-head">💾 数据存储与备份</div>
      <div class="cfg-body" id="sec-storage-body">
        <p class="cfg-hint">正在读取存储状态…</p>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">🔑 当前登录状态</div>
      <div class="cfg-body">
        <p class="cfg-hint">
          运行模式：<b>${isApi ? '云端共享（API 模式，密码保护已启用）' : '本地单机（无后端，密码保护不生效）'}</b><br/>
          ${isApi
      ? '看板与会话保存在服务端，密码经过加盐哈希存储，猜不到也拿不到原文。'
      : '直接双击 HTML 打开时为单机模式，数据存浏览器本地，无法做密码校验；请通过服务地址访问以启用密码保护。'}
        </p>
        <button class="mini-btn" id="sec-logout">退出登录</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">🔒 修改「看板」密码</div>
      <div class="cfg-body">
        <p class="cfg-hint">看板密码用于打开数据看板（index.html）。</p>
        <div class="form-grid">
          <label class="form-field"><span>当前后台密码</span><input type="password" id="pw-cur-1" autocomplete="off" /></label>
          <label class="form-field"><span>新看板密码（≥4 位）</span><input type="password" id="pw-new-1" autocomplete="off" /></label>
          <label class="form-field"><span>确认新密码</span><input type="password" id="pw-new-2" autocomplete="off" /></label>
        </div>
        <button class="btn btn-primary" id="sec-save-dash">保存看板密码</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">🔒 修改「后台」密码</div>
      <div class="cfg-body">
        <p class="cfg-hint">后台密码用于打开本管理页与执行写入操作，修改后其它已登录设备会被强制下线。</p>
        <div class="form-grid">
          <label class="form-field"><span>当前后台密码</span><input type="password" id="pw-cur-2" autocomplete="off" /></label>
          <label class="form-field"><span>新后台密码（≥4 位）</span><input type="password" id="pw-new-3" autocomplete="off" /></label>
          <label class="form-field"><span>确认新密码</span><input type="password" id="pw-new-4" autocomplete="off" /></label>
        </div>
        <button class="btn btn-primary" id="sec-save-admin">保存后台密码</button>
      </div>
    </section>

    <section class="cfg-section">
      <div class="cfg-head">💡 忘记密码怎么办</div>
      <div class="cfg-body">
        <p class="cfg-hint">
          密码哈希存在数据目录的 <code>server-auth.json</code> 里。若忘记密码：
          删除该文件后重启服务，会重新生成默认密码（看板 gonghui123 / 后台 admin123）。
        </p>
      </div>
    </section>
  `;

  const logout = document.getElementById('sec-logout');
  if (logout) logout.addEventListener('click', async () => {
    await DashboardStore.authLogout();
    location.replace('/login.html?role=admin&next=/admin.html');
  });

  const doChange = async (role, curId, n1Id, n2Id, btn) => {
    const cur = document.getElementById(curId).value;
    const n1 = document.getElementById(n1Id).value;
    const n2 = document.getElementById(n2Id).value;
    if (!cur) { toast('请输入当前后台密码', 'error'); return; }
    if (n1.length < 4) { toast('新密码至少 4 位', 'error'); return; }
    if (n1 !== n2) { toast('两次输入的新密码不一致', 'error'); return; }
    btn.disabled = true;
    try {
      await DashboardStore.authChangePassword(role, cur, n1);
      toast(role === 'admin' ? '后台密码已更新' : '看板密码已更新');
      renderSecurityPanel();
    } catch (e) {
      toast(e.message || '修改失败', 'error');
      btn.disabled = false;
    }
  };

  const b1 = document.getElementById('sec-save-dash');
  if (b1) b1.addEventListener('click', () => doChange('dashboard', 'pw-cur-1', 'pw-new-1', 'pw-new-2', b1));
  const b2 = document.getElementById('sec-save-admin');
  if (b2) b2.addEventListener('click', () => doChange('admin', 'pw-cur-2', 'pw-new-3', 'pw-new-4', b2));

  refreshStorageSection();
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 「数据存储与备份」分区：存储是否持久 + 快照列表 + 一键恢复 */
async function refreshStorageSection() {
  const body = document.getElementById('sec-storage-body');
  if (!body) return;
  let info, bk;
  try {
    info = await DashboardStore.getStorageInfo();
    bk = await DashboardStore.listBackups();
  } catch (e) {
    body.innerHTML = `<p class="cfg-hint cfg-warn">存储状态读取失败：${escapeHtml(e.message || String(e))}</p>`;
    return;
  }
  const rows = bk.backups || [];
  const warn = (info.hints || []).map(h =>
    `<p class="cfg-hint ${info.persistent ? '' : 'cfg-warn'}">${escapeHtml(h)}</p>`).join('');

  body.innerHTML = `
    <div class="store-status ${info.persistent ? 'is-ok' : 'is-bad'}">
      <div class="store-line">
        <span class="store-dot"></span>
        <b>${info.persistent
      ? '数据持久化：已开启 —— 重新部署 / 重启容器都不会丢数据'
      : '数据持久化：未开启 —— 平台重新部署后数据会被重置！'}</b>
      </div>
      <table class="cfg-table store-table">
        <tbody>
          <tr><td>数据目录</td><td><code>${escapeHtml(info.dataDir || '')}</code></td></tr>
          <tr><td>数据文件</td><td><code>${escapeHtml(info.dataFile || '')}</code></td></tr>
          <tr><td>最近写入</td><td>${fmtTime(info.dataMtime)}</td></tr>
          <tr><td>当前数据量</td><td>${info.sheets || 0} 张表 / ${info.rows || 0} 行</td></tr>
          <tr><td>快照目录</td><td><code>${escapeHtml(info.backupDir || '')}</code>（共 ${info.backupCount || 0} 份）</td></tr>
        </tbody>
      </table>
      ${warn}
    </div>

    <div class="cfg-subhead">最近快照（点「恢复」即可回滚到那一刻）</div>
    ${rows.length ? `
      <table class="cfg-table">
        <thead><tr><th>时间</th><th>类型</th><th>内容</th><th>大小</th><th>操作</th></tr></thead>
        <tbody>
          ${rows.slice(0, 12).map(b => `
            <tr>
              <td>${fmtTime(b.mtime)}</td>
              <td>${b.kind === 'data' ? '数据' : '看板配置'}</td>
              <td>${b.kind === 'data' ? ((b.rows === null || b.rows === undefined) ? '—' : b.rows + ' 行') : '—'}</td>
              <td>${(b.size / 1024).toFixed(1)} KB</td>
              <td><button class="mini-btn" type="button" data-restore="${escapeHtml(b.name)}">恢复</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`
      : '<p class="cfg-hint">暂无快照（每次保存前后会自动生成，也可点下方按钮立即生成一份）。</p>'}

    <div class="cfg-actions">
      <button class="mini-btn" type="button" id="store-backup-now">立即备份数据</button>
      <button class="mini-btn" type="button" id="store-refresh">刷新状态</button>
    </div>
  `;

  body.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.restore;
      const isCfg = name.indexOf('server-config.') === 0;
      const ok = await confirmDialog(
        `确认用这份快照覆盖当前的${isCfg ? '看板配置' : '全部数据'}？\n\n${name}\n\n覆盖前会自动把当前版本另存一份，可再恢复回来。`,
        '恢复快照'
      );
      if (!ok) return;
      try {
        setSync('syncing');
        await DashboardStore.restoreBackup(name);
        SCHEMA = DashboardStore.getSchema(currentTab) || SCHEMA;
        refreshAll();
        await refreshStorageSection();
        toast('已恢复到：' + name);
        setTimeout(refreshSyncBadge, 600);
      } catch (e) {
        toast('恢复失败：' + (e.message || e), 'error');
        setSync('error', '恢复失败');
      }
    });
  });

  const now = document.getElementById('store-backup-now');
  if (now) now.addEventListener('click', async () => {
    try {
      setSync('syncing');
      const r = await DashboardStore.createBackup('data');
      toast('已生成快照：' + r.name);
      await refreshStorageSection();
      setTimeout(refreshSyncBadge, 600);
    } catch (e) {
      toast('备份失败：' + (e.message || e), 'error');
      setSync('error', '备份失败');
    }
  });

  const rf = document.getElementById('store-refresh');
  if (rf) rf.addEventListener('click', refreshStorageSection);
}

// ============ 启动 ============
/** 把服务端返回的存储来源翻译成人话，避免用户看到 env / app-root 这种内部值发懵 */
const STORAGE_MODE_LABEL = {
  env: '环境变量指定的目录',
  volume: '持久卷',
  mount: '持久挂载点',
  'app-data': '代码目录下的 data/（非持久）',
  'app-root': '代码目录本身（非持久）',
};
const storageModeLabel = m => STORAGE_MODE_LABEL[m] || (m ? `${m}（非持久）` : '未知');

/**
 * 数据没写在持久目录时，在后台顶部常驻一条告警。
 * 这就是「每次重新部署数据被清空」的直接原因，必须让用户一眼看到。
 */
async function checkStorageWarning() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const h = await r.json();
    if (h && h.persistent === false) showStorageWarning(storageModeLabel(h.storageMode), h.dataMtime);
  } catch (_) { /* 本地模式没有这个接口，忽略 */ }
}

function showStorageWarning(mode, dataMtime) {
  if (document.getElementById('storage-warn')) return;
  const d = document.createElement('div');
  d.id = 'storage-warn';
  d.className = 'storage-warn';
  d.innerHTML = `
    <span class="sw-icon">!</span>
    <span class="sw-text">
      <b>数据写在临时目录，平台重新部署后会丢失</b>（当前实际写在：${escapeHtml(mode || '未知')}${dataMtime ? '，最近写入 ' + escapeHtml(fmtTime(dataMtime)) : ''}）
      —— 请给该服务挂一块持久卷、<b>挂载路径填 /data</b>，然后重新部署。
      在此之前的一切修改，都可能在下次部署时消失。
    </span>
    <button class="sw-close" type="button" id="storage-warn-close">知道了</button>`;
  document.body.prepend(d);
  const btn = document.getElementById('storage-warn-close');
  if (btn) btn.addEventListener('click', () => d.remove());
}

/** 数据读取失败时的提示层（不会再拿示例数据冒充真实数据） */
function showLoadErrorScreen(msg) {  const wrap = document.createElement('div');
  wrap.className = 'load-error-screen';
  wrap.innerHTML = `
    <div class="les-card">
      <div class="les-title">数据读取失败</div>
      <div class="les-desc">${escapeHtml(String(msg))}</div>
      <div class="les-hint">已停止加载，避免把示例数据误当成真实数据。可先刷新重试；若持续失败，请检查服务端存储与网络。</div>
      <button class="les-btn" type="button" onclick="location.reload()">刷新重试</button>
    </div>`;
  document.body.appendChild(wrap);
}

async function boot() {
  const data = await DashboardStore.load();
  if (!data) {
    const err = DashboardStore.getLoadError && DashboardStore.getLoadError();
    if (err) { showLoadErrorScreen(err); return; }   // 读取失败 ≠ 未登录，别把人踢到登录页打转
    // 会话失效 / 未登录：回到登录页
    location.replace('/login.html?role=admin&next=/admin.html');
    return;
  }
  checkStorageWarning();   // 数据没写在持久盘上 → 顶部常驻告警（重新部署会丢数据）
  CFG = DashboardStore.getConfig() || window.SEED_CONFIG;
  refreshAll();

  bindTabs();
  bindToolbar();
  bindConfigPanel();

  DashboardStore.subscribe((_data, info) => {
    if (info && info.authRequired) {
      location.replace('/login.html?role=admin&next=/admin.html');
      return;
    }
    if (info && info.loadFailed) { showLoadErrorScreen(info.error || '数据读取失败'); return; }
    if (info && info.configOnly) {
      if (!isPseudoTab(currentTab)) return;
      CFG = DashboardStore.getConfig() || CFG;
      if (currentTab === '__config') renderConfigPanel();
      return;
    }
    if (info && info.statusOnly) { refreshSyncBadge(); return; }
    refreshAll();
    refreshSyncBadge();
    if (info && info.source === 'remote') {
      toast('已收到云端最新数据，自动刷新');
    }
  });
  refreshSyncBadge();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('editor-modal').classList.contains('hidden')) closeEditor();
      if (!document.getElementById('schema-modal').classList.contains('hidden')) closeSchemaEditor();
      if (!document.getElementById('mini-modal').classList.contains('hidden')) {
        document.getElementById('mini-modal').classList.add('hidden');
      }
      if (!document.getElementById('confirm-modal').classList.contains('hidden')) {
        document.getElementById('confirm-modal').classList.add('hidden');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
