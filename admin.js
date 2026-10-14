/* ===== 后台管理逻辑 ===== */

const SHEETS = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支'];
const SHEET_TITLES = {
  '01-组织建设': '工会组织建设',
  '02-走访慰问': '员工走访慰问',
  '03-员工活动': '员工活动',
  '04-经费收支': '工会经费收支',
};
const SHEET_ICON = {
  '01-组织建设': '🏛️',
  '02-走访慰问': '🤝',
  '03-员工活动': '🎉',
  '04-经费收支': '💰',
};

let currentTab = SHEETS[0];
let DATA = null;
let SCHEMA = null;  // 当前 sheet 的 schema: { headers, schema: { [field]: def } }

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
function refreshAll() {
  DATA = DashboardStore.getData();
  SCHEMA = DashboardStore.getSchema(currentTab);
  refreshOverview();
  renderTable();
  updateSchemaIndicator();
}

function refreshOverview() {
  if (!DATA) return;
  const m = computeMetrics();
  if (!m) return;
  document.getElementById('ov-org-total').textContent = m['org-total'];
  document.getElementById('ov-org-established').textContent = m['org-established'];
  document.getElementById('ov-org-preparing').textContent = m['org-preparing'];
  document.getElementById('ov-visit-total').textContent = m['visit-total'];
  document.getElementById('ov-visit-amount').textContent = Number(m['visit-amount'].toFixed(2));
  document.getElementById('ov-act-total').textContent = m['act-total'];
  document.getElementById('ov-act-coverage').textContent = m['act-coverage'];
  document.getElementById('ov-fund-balance').textContent = Number(m['fund-balance'].toFixed(2));

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
      if (raw === '') {
        val = '';
      } else if (!NUM_PATTERN.test(raw)) {
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
      document.getElementById('admin-search').value = '';
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

// ============ 启动 ============
async function boot() {
  await DashboardStore.load();
  refreshAll();

  bindTabs();
  bindToolbar();

  DashboardStore.subscribe((_data, info) => {
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
