/* ===== 收集端口 · 数据填报页 =====
 *
 * 这是给各门店/区域填报人用的独立入口，和「管理后台」是两套界面：
 *   - 登录后只能看到**自己提报**的记录；
 *   - 只能改/删自己的，越权一律 403；
 *   - 写入时「提报人」由服务端按当前端口自动盖章，前端传什么都不算数。
 *
 * 所以这里刻意不依赖 data-store.js（那是后台/看板用的），
 * 只用了一层极薄的 fetch 封装，避免把后台的全量数据逻辑带进来。
 */
'use strict';

const CL = {
  // ⚠️ loginForm = 登录卡里的 <form id="cl-form">，form = 填报主界面的 <form id="cm-form">。
  // 以前只用一个 CL.form 指向 cl-form，结果填报表单被渲染进隐藏的登录卡里，
  // 用户看到的是一片空白的表单，提交时 readForm() 也取不到任何字段。
  loginForm: null,
  login: null, main: null, form: null, error: null,
  user: null, pass: null, tabs: null,
  portName: null,
  title: null, hint: null, table: null, empty: null, count: null,
  creds: null, logout: null, submit: null, reset: null,
  confirm: null, confirmTitle: null, confirmMsg: null,
  confirmOk: null, confirmCancel: null,
};

let SHEETS = [];        // [{ key, title, headers, schema, accounts }]
let ACTIVE = '';        // 当前选中的表 key
let EDIT_INDEX = null;  // 非空 = 正在编辑第 N 行
let ME = null;          // { portId, name, username, sheets }

/* ------------------------------------------------------------------ 工具 */

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _toastT = null;
function toast(msg, type) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (type === 'error' ? ' toast-error' : '');
  el.classList.remove('hidden');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.add('hidden'), 2600);
}

/** 统一请求：自动带 cookie，非 JSON 也给出可读错误，避免拿到 HTML 还当 JSON 解 */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('网络请求失败：' + (e && e.message));
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') < 0) {
    throw new Error(`服务返回了非 JSON 内容（HTTP ${res.status}），可能未登录或接口不存在`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

const get = u => api('GET', u);
const post = (u, b) => api('POST', u, b || {});

function confirmDialog(title, message) {
  CL.confirmTitle.textContent = title;
  CL.confirmMsg.textContent = message;
  CL.confirm.classList.remove('hidden');
  return new Promise(resolve => {
    const done = v => {
      CL.confirm.classList.add('hidden');
      CL.confirmOk.onclick = null;
      CL.confirmCancel.onclick = null;
      resolve(v);
    };
    CL.confirmOk.onclick = () => done(true);
    CL.confirmCancel.onclick = () => done(false);
  });
}

/* ------------------------------------------------------------ 登录 / 登出 */

function showLogin(msg) {
  CL.main.classList.add('hidden');
  CL.login.classList.remove('hidden');
  if (msg) {
    CL.error.textContent = msg;
    CL.error.classList.remove('hidden');
  } else {
    CL.error.classList.add('hidden');
  }
  setTimeout(() => CL.user && CL.user.focus(), 50);
}

function showMain() {
  CL.login.classList.add('hidden');
  CL.main.classList.remove('hidden');
  // 让填报人一眼知道自己登的是哪个端口（多人共用一台电脑时很关键）
  if (CL.portName && ME) {
    CL.portName.textContent = `端口：${ME.name}　·　账号：${ME.username}`;
  }
}

async function boot() {
  CL.login = $('collect-login');
  CL.main = $('collect-main');
  CL.loginForm = $('cl-form');   // 登录卡
  CL.form = $('cm-form');        // 填报表单（别和登录卡混了）
  CL.error = $('cl-error');
  CL.user = $('cl-user');
  CL.pass = $('cl-pass');
  CL.tabs = $('cm-tabs');
  CL.portName = $('cm-port-name');
  CL.title = $('cm-sheet-title');
  CL.hint = $('cm-sheet-hint');
  CL.table = $('cm-table');
  CL.empty = $('cm-empty');
  CL.count = $('cm-count');
  CL.creds = $('cm-creds');
  CL.logout = $('cm-logout');
  CL.submit = $('cm-submit');
  CL.reset = $('cm-reset');
  CL.confirm = $('confirm-modal');
  CL.confirmTitle = $('confirm-title');
  CL.confirmMsg = $('confirm-message');
  CL.confirmOk = $('confirm-ok');
  CL.confirmCancel = $('confirm-cancel');

  try {
    ME = await get('/api/port/me');
    showMain();
    await loadSheets();
  } catch (_) {
    showLogin();
  }

  CL.loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    CL.error.classList.add('hidden');
    try {
      await post('/api/port/login', { username: CL.user.value, password: CL.pass.value });
      ME = await get('/api/port/me');
      showMain();
      await loadSheets();
      toast('登录成功', 'ok');
    } catch (err) {
      CL.error.textContent = err.message || '登录失败';
      CL.error.classList.remove('hidden');
    }
  });

  CL.logout.addEventListener('click', async () => {
    try { await post('/api/port/logout'); } catch (_) {}
    ME = null;
    CL.pass.value = '';
    showLogin();
  });

  CL.creds.addEventListener('click', openCredsDialog);
  CL.submit.addEventListener('click', onSubmit);
  CL.reset.addEventListener('click', () => {
    EDIT_INDEX = null;
    CL.submit.textContent = '提交填报';
    renderForm();
  });
}

/* ------------------------------------------------------------------ 取数 */

async function loadSheets() {
  const r = await get('/api/port/sheets');
  SHEETS = r.sheets || [];
  if (!ACTIVE || !SHEETS.some(s => s.key === ACTIVE)) ACTIVE = (SHEETS[0] && SHEETS[0].key) || '';
  renderTabs();
  renderForm();
  await reloadRecords();
}

function currentSheet() { return SHEETS.find(s => s.key === ACTIVE) || null; }

/* ------------------------------------------------------------ 渲染：页签 */

function renderTabs() {
  CL.tabs.innerHTML = '';
  SHEETS.forEach(s => {
    const b = document.createElement('button');
    b.className = 'cm-tab' + (s.key === ACTIVE ? ' active' : '');
    b.textContent = s.title || s.key;
    b.addEventListener('click', async () => {
      ACTIVE = s.key;
      EDIT_INDEX = null;
      CL.submit.textContent = '提交填报';
      renderTabs();
      renderForm();
      await reloadRecords();
    });
    CL.tabs.appendChild(b);
  });
}

/* ------------------------------------------------------------ 渲染：表单 */

/** 需要渲染成「经费账户」下拉的列名（与 04 表「工会名称」对应） */
const ACCOUNT_FIELD = '费用列支账户';

function renderForm() {
  const sh = currentSheet();
  CL.form.innerHTML = '';
  if (!sh) {
    CL.title.textContent = '无可用数据表';
    CL.hint.textContent = '请联系管理员为你的端口授权数据表';
    return;
  }
  CL.title.textContent = sh.title || sh.key;
  CL.hint.textContent = `共 ${sh.headers.filter(h => h !== '序号').length} 个字段 · 带 * 为必填`;

  sh.headers.forEach(h => {
    const def = sh.schema[h] || {};
    // 系统列不出现在填报表单里
    if (h === '序号' || def.auto || def.derived || def.readonly) return;

    const wrap = document.createElement('div');
    wrap.className = 'cm-field' + (def.full ? ' full' : '');

    const lab = document.createElement('label');
    lab.innerHTML = escapeHtml(h) + (def.required ? '<span class="cm-req">*</span>' : '');
    lab.setAttribute('for', 'fld-' + h);
    wrap.appendChild(lab);

    let ctl;
    if (def.type === 'textarea') {
      ctl = document.createElement('textarea');
    } else if (def.type === 'select') {
      ctl = document.createElement('select');
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '请选择…';
      ctl.appendChild(ph);
      (def.options || []).forEach(o => {
        const op = document.createElement('option');
        op.value = o;
        op.textContent = o;
        ctl.appendChild(op);
      });
    } else {
      ctl = document.createElement('input');
      ctl.type = def.type === 'number' ? 'number'
        : def.type === 'date' ? 'date' : 'text';
      if (def.type === 'number') {
        ctl.step = 'any';
        if (typeof def.min === 'number') ctl.min = String(def.min);
      }
    }
    ctl.className = 'cm-ctl';
    ctl.id = 'fld-' + h;
    ctl.name = h;
    if (def.required) ctl.required = true;
    wrap.appendChild(ctl);

    // 账户列：给一个下拉候选（经费收支表里的工会名称），同时允许手填
    if (h === ACCOUNT_FIELD && Array.isArray(sh.accounts) && sh.accounts.length) {
      ctl.setAttribute('list', 'acct-options');
      ctl.autocomplete = 'off';
      let dl = CL.form.querySelector('#acct-options');
      if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'acct-options';
        CL.form.appendChild(dl);
      }
      dl.innerHTML = sh.accounts
        .map(a => `<option value="${escapeHtml(a)}"></option>`).join('');
    }

    CL.form.appendChild(wrap);
  });
}

function readForm() {
  const sh = currentSheet();
  const row = {};
  if (!sh) return row;
  sh.headers.forEach(h => {
    const def = sh.schema[h] || {};
    if (h === '序号' || def.auto || def.derived || def.readonly) return;
    const el = CL.form.querySelector('#fld-' + CSS.escape(h));
    if (!el) return;
    const v = el.value == null ? '' : String(el.value).trim();
    if (v === '') return;
    if (def.type === 'number') {
      const n = Number(v.replace(/,/g, ''));
      row[h] = Number.isFinite(n) ? n : v;
    } else {
      row[h] = v;
    }
  });
  return row;
}

function fillForm(row) {
  const sh = currentSheet();
  if (!sh) return;
  sh.headers.forEach(h => {
    const el = CL.form.querySelector('#fld-' + CSS.escape(h));
    if (el) el.value = row[h] === undefined || row[h] === null ? '' : String(row[h]);
  });
}

/* -------------------------------------------------------- 渲染：我的记录 */

function reloadRecords() {
  const sh = currentSheet();
  if (!sh) return Promise.resolve();
  return get('/api/port/records?sheet=' + encodeURIComponent(sh.key))
    .then(r => renderRecords(sh, r.records || []))
    .catch(e => { toast(e.message, 'error'); });
}

function renderRecords(sh, records) {
  const thead = CL.table.querySelector('thead');
  const tbody = CL.table.querySelector('tbody');
  const cols = sh.headers.slice();
  thead.innerHTML = '<tr>' + cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')
    + '<th style="width:110px">操作</th></tr>';
  tbody.innerHTML = '';

  CL.count.textContent = `${records.length} 条`;
  const none = !records.length;
  CL.empty.classList.toggle('hidden', !none);
  CL.table.classList.toggle('hidden', none);
  if (none) return;

  records.forEach(rec => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      const v = rec.row[c];
      td.textContent = v === undefined || v === null ? '' : String(v);
      if (c === '提报人') td.innerHTML = `<span class="cm-badge">${escapeHtml(String(v || ''))}</span>`;
      tr.appendChild(td);
    });
    const act = document.createElement('td');
    const b1 = document.createElement('button');
    b1.className = 'cm-row-btn';
    b1.textContent = '✏️';
    b1.title = '修改这条记录';
    b1.addEventListener('click', () => {
      EDIT_INDEX = rec.index;
      fillForm(rec.row);
      CL.submit.textContent = '保存修改';
      CL.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const b2 = document.createElement('button');
    b2.className = 'cm-row-btn';
    b2.textContent = '🗑️';
    b2.title = '删除这条记录';
    b2.addEventListener('click', async () => {
      const yes = await confirmDialog('删除确认', `确定删除这条「${sh.title}」记录吗？删除后不可恢复。`);
      if (!yes) return;
      try {
        await post('/api/port/delete', { sheet: sh.key, index: rec.index });
        toast('已删除', 'ok');
        EDIT_INDEX = null;
        CL.submit.textContent = '提交填报';
        await reloadRecords();
      } catch (err) { toast(err.message, 'error'); }
    });
    act.appendChild(b1);
    act.appendChild(b2);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });
}

/* ------------------------------------------------------------------ 交互 */

async function onSubmit() {
  const sh = currentSheet();
  if (!sh) return;
  const row = readForm();
  try {
    if (EDIT_INDEX === null) {
      await post('/api/port/submit', { sheet: sh.key, row });
      toast('提交成功', 'ok');
    } else {
      await post('/api/port/update', { sheet: sh.key, index: EDIT_INDEX, row });
      toast('修改已保存', 'ok');
      EDIT_INDEX = null;
      CL.submit.textContent = '提交填报';
    }
    renderForm();
    await reloadRecords();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openCredsDialog() {
  const html = `
    <div class="cm-field">
      <label>新用户名（留空表示不修改）</label>
      <input id="cred-user" type="text" class="cm-ctl" placeholder="${escapeHtml(ME && ME.username ? ME.username : '')}" />
    </div>
    <div class="cm-field">
      <label>新密码（留空表示不修改，至少 4 位）</label>
      <input id="cred-pass" type="password" class="cm-ctl" placeholder="留空则不修改" />
    </div>
    <p class="cm-tip">用户名在 10 个端口之间不能重复。修改后请用新账号重新登录。</p>
  `;
  showMini('修改账号密码', html, async () => {
    const u = document.getElementById('cred-user');
    const p = document.getElementById('cred-pass');
    if (!u || !p) return false;
    const username = u.value.trim();
    const password = p.value;
    if (!username && !password) { toast('用户名与密码都没有填写', 'error'); return false; }
    try {
      await post('/api/port/credentials', { username, password });
      toast('已更新，请重新登录', 'ok');
      ME = null;
      CL.pass.value = '';
      showLogin();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  });
}

/* ------------------------------------------------- 极简弹窗（本页面专用） */

let MINI_OK = null;
function showMini(title, html, onOk) {
  let box = document.getElementById('cm-mini');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cm-mini';
    box.className = 'modal-backdrop hidden';
    box.innerHTML = `
      <div class="modal-panel mini-panel">
        <div class="modal-header">
          <h2 class="modal-title" id="cm-mini-title">—</h2>
          <button id="cm-mini-close" class="modal-close">×</button>
        </div>
        <div id="cm-mini-content" class="mini-content"></div>
      <div class="mini-actions">
          <button class="btn btn-ghost" id="cm-mini-cancel">取消</button>
          <button class="btn btn-primary" id="cm-mini-ok">确认</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    box.querySelector('#cm-mini-close').addEventListener('click', () => hideMini());
    box.querySelector('#cm-mini-cancel').addEventListener('click', () => hideMini());
    box.querySelector('#cm-mini-ok').addEventListener('click', async () => {
      const fn = MINI_OK;
      MINI_OK = null;
      const r = fn ? await fn() : true;
      if (r !== false) hideMini();
      else MINI_OK = fn;
    });
  }
  box.querySelector('#cm-mini-title').textContent = title;
  box.querySelector('#cm-mini-content').innerHTML = html;
  MINI_OK = onOk;
  box.classList.remove('hidden');
}
function hideMini() {
  const box = document.getElementById('cm-mini');
  if (box) box.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', boot);
