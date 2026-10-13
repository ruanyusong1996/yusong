/* ===== 后台管理逻辑 ===== */

const SHEETS = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支'];
const SHEET_TITLES = {
  '01-组织建设': '工会组织建设',
  '02-走访慰问': '员工走访慰问',
  '03-员工活动': '员工活动',
  '04-经费收支': '工会经费收支',
};

// 字段类型定义（按表头配置输入控件）
const FIELD_DEFS = {
  '01-组织建设': {
    '工会名称': { type: 'text', required: true, full: true },
    '依托公司': { type: 'text', required: true, full: true },
    '工会主席': { type: 'text' },
    '职工人数': { type: 'number', min: 0 },
    '组建状态': { type: 'select', options: ['已组建', '筹建中'], required: true },
    '工会级别': { type: 'select', options: ['一级工会', '二级工会', '三级工会'], required: true },
    '备注': { type: 'textarea', full: true },
  },
  '02-走访慰问': {
    '慰问类型': { type: 'select', options: ['员工直系亲属重大疾病', '员工本人重大疾病', '其他'], required: true },
    '员工姓名': { type: 'text', required: true },
    '所在大区': { type: 'text', required: true },
    '员工所在部门/门店': { type: 'text', required: true },
    '慰问日期': { type: 'date' },
    '慰问物品金额（元）': { type: 'number', min: 0 },
    '具体事由': { type: 'textarea', full: true },
    '经办人': { type: 'text' },
    '备注': { type: 'textarea', full: true },
  },
  '03-员工活动': {
    '活动日期': { type: 'date', required: true },
    '活动内容': { type: 'text', required: true, full: true },
    '活动形式': { type: 'select', options: ['线下活动', '线上活动'], required: true },
    '活动类型': { type: 'select', options: ['社团活动', '节日主题活动', '属地关爱', '文体活动', '培训讲座', '公益活动', '技能竞赛'], required: true },
    '活动区域': { type: 'text' },
    '组织部门': { type: 'text' },
    '覆盖人数': { type: 'number', min: 0 },
    '支出金额（元）': { type: 'number', min: 0 },
    '备注': { type: 'textarea', full: true },
  },
  '04-经费收支': {
    '工会名称': { type: 'text', required: true },
    '工会全称': { type: 'text', full: true },
    '收支类型': { type: 'select', options: ['收入', '支出'], required: true },
    '经费项目': { type: 'select', options: ['上级工会反拨', '会员会费', '其他收入', '活动支出', '慰问支出', '培训支出', '其他支出'], required: true },
    '年初金额': { type: 'number', min: 0 },
    '支出金额': { type: 'number', min: 0 },
    '当前结余（元）': { type: 'number' },
    '当前结余（万元）': { type: 'number' },
    '事由摘要': { type: 'textarea', full: true },
    '经办人': { type: 'text' },
    '备注': { type: 'textarea', full: true },
  },
};

let currentTab = SHEETS[0];
let DATA = null;

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

  // 三态：断线 / 已同步（带时间戳）/ 已就绪
  // 注意：必须处理"恢复"分支，否则一旦显示断线就再也回不来
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

// ============ 派生指标 ============
function computeMetrics() {
  if (!DATA) return null;
  const org = DATA['01-组织建设'].rows;
  const visit = DATA['02-走访慰问'].rows;
  const act = DATA['03-员工活动'].rows;
  const fund = DATA['04-经费收支'].rows;

  return {
    'org-total': org.length,
    'org-established': org.filter(r => r[5] === '已组建').length,
    'org-preparing': org.filter(r => r[5] === '筹建中').length,
    'visit-total': visit.length,
    'visit-amount': visit.reduce((s, r) => s + (Number(r[6]) || 0), 0),
    'act-total': act.length,
    'act-coverage': act.reduce((s, r) => s + (Number(r[7]) || 0), 0),
    'fund-balance': fund.reduce((s, r) => s + (Number(r[9]) || 0), 0),
  };
}

function refreshOverview() {
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

  // 角标
  SHEETS.forEach(k => {
    const el = document.getElementById('badge-' + k);
    if (el) el.textContent = DATA[k].rows.length;
  });
}

// ============ 表格渲染 ============
function renderTable() {
  if (!DATA) return;
  const sheet = DATA[currentTab];
  const headers = sheet.headers;
  const rows = sheet.rows;
  const thead = document.querySelector('#admin-table thead');
  const tbody = document.querySelector('#admin-table tbody');
  const empty = document.getElementById('admin-empty');
  const info = document.getElementById('tab-info');

  // 搜索
  const q = (document.getElementById('admin-search').value || '').trim().toLowerCase();
  let filtered = rows;
  if (q) {
    filtered = rows.filter(r => r.some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(q)));
  }

  // 表头
  thead.innerHTML = '<tr>' + headers.map((h, i) => {
    const isIndex = i === 0;
    return `<th class="${isIndex ? 'col-index' : ''}">${escapeHtml(h)}${isIndex ? '' : ''}</th>`;
  }).join('') + '<th class="col-actions">操作</th></tr>';

  // 行
  if (filtered.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    tbody.innerHTML = filtered.map((row, displayIdx) => {
      const realIndex = rows.indexOf(row); // 用于编辑/删除
      return '<tr>' + row.map((v, i) => {
        const isEmpty = v === '' || v === null || v === undefined;
        const isLong = typeof v === 'string' && v.length > 40;
        const cls = isEmpty ? 'empty-cell' : (i === 0 ? 'col-index' : (isLong ? 'col-long' : ''));
        const content = isEmpty ? '—' : escapeHtml(v);
        return `<td class="${cls}">${content}</td>`;
      }).join('') + `<td class="col-actions">
        <button class="btn btn-ghost btn-row" data-action="edit" data-index="${realIndex}">编辑</button>
        <button class="btn btn-danger btn-row" data-action="delete" data-index="${realIndex}">删除</button>
      </td></tr>`;
    }).join('');
  }

  info.textContent = `共 ${rows.length} 条${q ? ` · 筛选 ${filtered.length} 条` : ''}`;
}

// ============ 编辑器 ============
function openEditor(mode, index) {
  const sheet = DATA[currentTab];
  const headers = sheet.headers;
  const defs = FIELD_DEFS[currentTab] || {};
  const row = mode === 'edit' ? sheet.rows[index] : headers.map(() => '');
  const fieldsEl = document.getElementById('editor-fields');
  const titleEl = document.getElementById('editor-title');
  const subEl = document.getElementById('editor-subtitle');

  titleEl.textContent = mode === 'edit' ? `编辑记录 #${row[0] || index + 1}` : '新增记录';
  subEl.textContent = SHEET_TITLES[currentTab] || currentTab;

  fieldsEl.innerHTML = '';

  headers.forEach((h, idx) => {
    if (idx === 0) return; // 序号自动
    const def = defs[h] || { type: 'text' };
    const full = def.full || def.type === 'textarea';
    const wrap = document.createElement('div');
    wrap.className = 'editor-field' + (full ? ' full' : '');

    const label = document.createElement('label');
    label.innerHTML = escapeHtml(h) + (def.required ? '<span class="req">*</span>' : '');
    wrap.appendChild(label);

    let input;
    const value = row[idx] !== undefined && row[idx] !== null ? row[idx] : '';
    if (def.type === 'select') {
      input = document.createElement('select');
      def.options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === value) o.selected = true;
        input.appendChild(o);
      });
    } else if (def.type === 'textarea') {
      input = document.createElement('textarea');
      input.value = value;
    } else {
      input = document.createElement('input');
      input.type = def.type;
      input.value = value;
      if (def.min !== undefined) input.min = def.min;
    }
    input.name = h;
    input.dataset.index = idx;
    if (def.required) input.required = true;
    wrap.appendChild(input);
    fieldsEl.appendChild(wrap);
  });

  document.getElementById('editor-modal').classList.remove('hidden');
  document.getElementById('editor-form').dataset.mode = mode;
  document.getElementById('editor-form').dataset.index = index !== undefined ? index : '';
}

function closeEditor() {
  document.getElementById('editor-modal').classList.add('hidden');
}

async function submitEditor(e) {
  e.preventDefault();
  const sheet = DATA[currentTab];
  const headers = sheet.headers;
  const form = e.target;
  const mode = form.dataset.mode;
  const editIndex = parseInt(form.dataset.index);

  // 校验
  const newRow = headers.map(() => '');
  newRow[0] = 0; // 稍后自动编号
  const inputs = form.querySelectorAll('input, select, textarea');
  inputs.forEach(el => {
    const idx = parseInt(el.dataset.index);
    let val = el.value;
    if (el.type === 'number' && val !== '') val = Number(val);
    newRow[idx] = val;
  });

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
      await DashboardStore.replaceRow(currentTab, editIndex, newRow);
    } else {
      await DashboardStore.addRow(currentTab, newRow);
    }
    closeEditor();
    toast(mode === 'edit' ? '已保存修改' : '已新增记录');
    setTimeout(() => setSync('已同步'), 600);
  } catch (err) {
    console.error(err);
    toast('保存失败：' + (err.message || err), 'error');
    setSync('error', '保存失败');
  }
}

// ============ 事件绑定 ============
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      document.getElementById('admin-search').value = '';
      renderTable();
    });
  });
}

function bindToolbar() {
  document.getElementById('admin-search').addEventListener('input', renderTable);
  document.getElementById('btn-add').addEventListener('click', () => openEditor('add'));

  // 表格内按钮（事件委托）
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
        setTimeout(() => setSync('已同步'), 600);
      } catch (err) {
        console.error(err);
        toast('删除失败：' + (err.message || err), 'error');
        setSync('error', '删除失败');
      }
    }
  });

  // 编辑器
  document.getElementById('editor-close').addEventListener('click', closeEditor);
  document.getElementById('editor-cancel').addEventListener('click', closeEditor);
  document.getElementById('editor-modal').addEventListener('click', (e) => {
    if (e.target.id === 'editor-modal') closeEditor();
  });
  document.getElementById('editor-form').addEventListener('submit', submitEditor);

  // 顶部工具
  document.getElementById('btn-export').addEventListener('click', exportJSON);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-import').click());
  document.getElementById('file-import').addEventListener('change', importJSON);
  document.getElementById('btn-reset').addEventListener('click', async () => {
    const ok = await confirmDialog('确认重置为初始数据？所有修改将丢失', '重置数据');
    if (!ok) return;
    setSync('syncing');
    try {
      await DashboardStore.reset();
      toast('已重置为初始数据');
      setTimeout(() => setSync('已同步'), 600);
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
  toast('已导出 JSON');
}

async function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    // 简单校验
    if (!parsed['01-组织建设'] || !parsed['04-经费收支']) {
      throw new Error('文件格式不正确，缺少关键数据表');
    }
    const ok = await confirmDialog('确认导入此文件？将覆盖当前所有数据', '导入确认');
    if (!ok) {
      e.target.value = '';
      return;
    }
    setSync('syncing');
    try {
      await DashboardStore.replaceAll(parsed);
      toast('已导入');
      setTimeout(() => setSync('已同步'), 600);
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
  DATA = DashboardStore.getData();
  refreshOverview();
  renderTable();
  bindTabs();
  bindToolbar();

  DashboardStore.subscribe((_data, info) => {
    // 仅状态变化（SSE 连上/断开）时只刷新徽章
    if (info && info.statusOnly) { refreshSyncBadge(); return; }
    DATA = DashboardStore.getData();
    refreshOverview();
    renderTable();
    refreshSyncBadge();
    // 别人改了数据，提示一下
    if (info && info.source === 'remote') {
      toast('已收到云端最新数据，自动刷新');
    }
  });
  refreshSyncBadge();

  // Esc 关闭编辑器
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!document.getElementById('editor-modal').classList.contains('hidden')) closeEditor();
      if (!document.getElementById('confirm-modal').classList.contains('hidden')) {
        document.getElementById('confirm-modal').classList.add('hidden');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
