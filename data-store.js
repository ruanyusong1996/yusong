/* ===== 数据存储抽象层 =====
 * 支持两种模式，自动探测：
 *   - API 模式（多人共享）：通过 fetch + EventSource 与后端通信
 *   - 本地模式（向后兼容）：用 localStorage + storage 事件
 *
 * 检测方式：探测同源 /api/health，2 秒超时
 *   - 200 OK  → API 模式
 *   - 失败   → 本地模式
 *
 * 数据格式（升级后）：
 *   DATA = {
 *     "<sheetKey>": {
 *       title, subtitle, headers: [列名...],
 *       schema: { [列名]: { type, required?, options?, full? } },  // 可选，向后兼容
 *       rows: [ { [列名]: 值, ... }, ... ]                          // 对象行
 *     },
 *     ...
 *   }
 *
 * 兼容：rows 为数组行时自动迁移为对象行；缺 schema 时从 BUILTIN_SCHEMA 派生。
 *
 * 公共 API:
 *   DashboardStore.load()                 Promise<data>
 *   DashboardStore.onReady(cb)
 *  Store.getData()                 → 当前数据快照
 *   DashboardStore.getSheet(key)
 *   DashboardStore.getSchema(key)         → { headers, schema }
 *   DashboardStore.updateSheet(key, rows)
 *   DashboardStore.addRow(key, row)
 *   DashboardStore.deleteRow(key, index)
 *   DashboardStore.replaceRow(key, index, row)
 *   DashboardStore.replaceAll(data)
 *   DashboardStore.reset()
 *
 *   DashboardStore.addColumn(key, fieldName, def, position?)  → 加列
 *   DashboardStore.removeColumn(key, fieldName)               → 删列
 *   DashboardStore.renameColumn(key, oldName, newName)        → 改名
 *   DashboardStore.updateColumn(key, fieldName, def)          → 改字段定义
 *   DashboardStore.moveColumn(key, fieldName, direction)      → 调整顺序
 *
 *   DashboardStore.subscribe(cb) → 返回取消订阅函数
 *   DashboardStore.getMode()      → 'api' | 'local'
 *   DashboardStore.getStatus()    → { mode, connected, lastSync, clients }
 */

(function () {
  const STORAGE_KEY = 'hdj_dashboard_data_v1';
  const CONFIG_KEY = 'hdj_dashboard_config_v1';
  const CLIENT_ID_KEY = 'hdj_client_id';
  const API_TIMEOUT_MS = 2000;
  const REQUIRED_KEYS = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支', '05-经费瀑布'];
  // 默认字段定义由前后端共用的 ./schema.js 提供（服务端校验端口提报数据也用它）。
  // 浏览器里 schema.js 会把它挂到 window.BUILTIN_SCHEMA，这里取用即可。
  const BUILTIN_SCHEMA = (typeof window !== "undefined" && window.BUILTIN_SCHEMA) || {};

  // 每个标签页一个唯一 id（用于 SSE 广播时跳过自己）
  const CLIENT_ID = (() => {
    try {
      let id = sessionStorage.getItem(CLIENT_ID_KEY);
      if (!id) {
        id = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        sessionStorage.setItem(CLIENT_ID_KEY, id);
      }
      return id;
    } catch (_) {
      return 'c_' + Math.random().toString(36).slice(2, 10);
    }
  })();

  let _data = null;
  let _config = null;            // 看板配置（文字/布局/指标/图表/主题）
  let _mode = 'local';           // 'api' | 'local'
  let _connected = false;        // SSE 连接状态
  let _lastSync = null;          // 最近一次推送时间
  let _ready = false;
  let _unauthorized = false;     // 会话失效 / 未登录
  const _readyCallbacks = [];
  const _listeners = new Set();
  const _configListeners = new Set();

  let _sse = null;               // EventSource 实例
  let _sseReconnectTimer = null;
  let _loadError = null;         // API 模式下数据读取失败的原因（绝不静默降级）
  let _degraded = false;         // 探不到后端、只能显示本地/示例数据

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** 只保留真正的数据表（排除 _meta 这类元信息） */
  function sheetKeys(data) {
    return data ? Object.keys(data).filter(k => k !== '_meta') : [];
  }

  // -------------------------------------------------------------------------
  // 行数据迁移 / 字段访问工具
  // -------------------------------------------------------------------------

  /** 把数组行转为对象行，并按 headers 重建 */
  function migrateRow(arrRow, headers) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = i < arrRow.length ? arrRow[i] : ''; });
    return obj;
  }

  /** 把整个 sheet 标准化为新格式（保证 schema 存在、行是对象、序号正确） */
  function normalizeSheet(sheet, builtinFields) {
    if (!sheet) return sheet;
    // 兼容：原数据已含 "序号"，不要再 unshift
    let headers = (sheet.headers || []).slice();
    const hadSeq = headers[0] === '序号';
    let schema = sheet.schema ? { ...sheet.schema } : {};
    // 若没 schema，从 BUILTIN_SCHEMA 派生
    if (!sheet.schema && builtinFields) {
      schema = clone(builtinFields);
      // 把 headers 里没出现的字段也加上 schema（未知列默认文本）
      headers.forEach(h => {
        if (!(h in schema)) schema[h] = { type: 'text' };
      });
    } else {
      // 有 schema 但缺字段的，也补默认。
      // 关键：新版本新增的列（如「当前进度」「经办人」）在老数据的 schema 里没有，
      // 这里优先用 BUILTIN_SCHEMA 的定义补上，否则它们会退化成纯文本框，
      // 「当前进度」的下拉阶段、「进度日期」的日期控件就都没了。
      headers.forEach(h => {
        if (!(h in schema)) {
          schema[h] = (builtinFields && builtinFields[h]) ? clone(builtinFields[h]) : { type: 'text' };
        }
      });
    }
    // 序号列固定为系统字段
    schema['序号'] = { auto: true };
    if (!hadSeq) headers.unshift('序号');

    // rows 迁移
    let rows = sheet.rows || [];
    if (rows.length && Array.isArray(rows[0])) {
      rows = rows.map(r => migrateRow(r, headers));
    }
    // 补序号
    rows = rows.map((r, idx) => ({ ...r, '序号': idx + 1 }));

    return { ...sheet, headers, schema, rows };
  }

  /** 标准化整份数据 */
  function normalizeData(data) {
    const out = {};
    REQUIRED_KEYS.forEach(k => {
      if (data[k]) out[k] = normalizeSheet(data[k], BUILTIN_SCHEMA[k]);
    });
    // 其它未知 sheet 也保留
    Object.keys(data).forEach(k => {
      if (!out[k]) out[k] = data[k];
    });

    // 经费汇入：把 02/03 的支出按「费用列支账户 = 工会名称」汇进 04，并重算结余。
    // 这里是唯一的计算入口（服务端与离线模式共用），保证看板与后台看到的数字完全一致。
    // 若 ConfigEngine 没加载（比如在 Node 里只 require 了本文件），就跳过——不静默给错数字。
    const CE = (typeof window !== 'undefined' ? window.ConfigEngine : null)
      || (typeof globalThis !== 'undefined' ? globalThis.ConfigEngine : null);
    if (CE && typeof CE.ensureFundColumns === 'function' && typeof CE.rollupFundExpense === 'function') {
      try {
        CE.ensureFundColumns(out);
        const warns = [];
        const derived = CE.rollupFundExpense(out, warns);
        if (warns.length) console.warn('[rollup] ' + warns.join(' | '));
        return derived;
      } catch (e) {
        console.error('[rollup] 经费汇入计算失败：', e && (e.message || e));
      }
    }
    return out;
  }

  /** 安全地从行对象取值，兼容 object 和 array 两种格式 */
  function pickValue(row, headers, fieldName) {
    if (row == null) return '';
    if (typeof row === 'object' && !Array.isArray(row)) {
      return row[fieldName] !== undefined ? row[fieldName] : '';
    }
    // array 行：按列索引查
    const i = headers.indexOf(fieldName);
    return i >= 0 && i < row.length ? row[i] : '';
  }

  /** 把对象行转回按 headers 顺序的数组（用于 PUT 到服务器前的清理，可选） */
  // 当前我们直接对象行上传，更直观。

  // -------------------------------------------------------------------------
  // API 模式：HTTP 请求
  // -------------------------------------------------------------------------

  /** 会话失效错误（未登录 / 登录过期） */
  function AuthError(msg) { const e = new Error(msg || '需要登录'); e.name = 'AuthError'; return e; }

  async function httpJson(url, options) {
    const resp = await fetch(url, options);
    if (resp.status === 401 || resp.status === 403) {
      _unauthorized = true;
      _emit();
      const err = AuthError('会话已失效，请重新登录');
      err.status = resp.status;
      throw err;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`${options && options.method || 'GET'} ${url} ${resp.status} ${t}`);
    }
    return resp.json();
  }

  async function apiGet() {
    return httpJson('/api/data', { cache: 'no-store' });
  }

  async function apiPut(newData) {
    return httpJson('/api/data', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Editor': hostNameSafe(),
        'X-Client-Id': CLIENT_ID,
      },
      body: JSON.stringify(newData),
    });
  }

  async function apiGetConfig() {
    return httpJson('/api/config', { cache: 'no-store' });
  }

  async function apiPutConfig(cfg) {
    return httpJson('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
      body: JSON.stringify(cfg),
    });
  }

  function hostNameSafe() {
    try { return location.hostname; } catch (_) { return 'anonymous'; }
  }

  async function apiReset() {
    await httpJson('/api/reset', { method: 'POST' });
    return apiGet();
  }

  // -------------------------------------------------------------------------
  // SSE 订阅
  // -------------------------------------------------------------------------

  function startSSE() {
    if (_sse) return;
    try {
      _sse = new EventSource('/api/stream');

      _sse.addEventListener('open', () => {
        _connected = true;
        _lastSync = _lastSync || new Date().toISOString();
        _emit();
      });

      _sse.addEventListener('hello', () => {
        _connected = true;
        _lastSync = _lastSync || new Date().toISOString();
        _emit();
      });

      _sse.addEventListener('update', async (e) => {
        // 跳过自己发起的变更（本地已更新，无需重复拉取）
        let payload = {};
        try { payload = JSON.parse(e.data || '{}'); } catch (_) {}
        if (payload.editorId && payload.editorId === CLIENT_ID) {
          _lastSync = payload.ts || new Date().toISOString();
          _emit();
          return;
        }
        try {
          // 收到他人推送：拉取最新数据（避免回声写回）
          const fresh = await apiGet();
          _data = normalizeData(fresh);
          _lastSync = payload.ts || new Date().toISOString();
          _listeners.forEach(cb => { try { cb(_data, { source: 'remote' }); } catch (err) { console.error(err); } });
          _emit();
        } catch (err) {
          console.error('[sse] 拉取最新数据失败', err);
        }
      });

      // 他人改了「看板配置」→ 重新拉配置并重绘
      _sse.addEventListener('config', async (e) => {
        let payload = {};
        try { payload = JSON.parse(e.data || '{}'); } catch (_) {}
        if (payload.editorId && payload.editorId === CLIENT_ID) return;
        try {
          await loadConfig();
          _emit({ configOnly: true, source: 'remote' });
        } catch (err) {
          console.error('[sse] 拉取最新配置失败', err);
        }
      });

      _sse.addEventListener('error', () => {
        _connected = false;
        _emit();
        // EventSource 默认会自动重连；这里额外加一个保险
        clearTimeout(_sseReconnectTimer);
        _sseReconnectTimer = setTimeout(() => {
          if (_mode === 'api') {
            try { _sse?.close(); } catch (_) {}
            _sse = null;
            startSSE();
          }
        }, 5000);
      });
    } catch (e) {
      console.error('[sse] 创建失败', e);
    }
  }

  function stopSSE() {
    clearTimeout(_sseReconnectTimer);
    if (_sse) { try { _sse.close(); } catch (_) {} _sse = null; }
    _connected = false;
  }

  // -------------------------------------------------------------------------
  // 模式探测
  // -------------------------------------------------------------------------

  async function probeApi() {
    for (let i = 0; i < 2; i++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
        const resp = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (resp.ok) return true;
      } catch (_) { /* 再试一次 */ }
      if (i === 0) await sleep(600);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  async function load() {
    if (_data) {
      if (!_config) { try { await loadConfig(); } catch (_) {} }
      return _data;
    }

    const isApi = await probeApi();
    _mode = isApi ? 'api' : 'local';
    console.log(`[DashboardStore] 模式: ${_mode}`);

    if (_mode === 'api') {
      // ⚠️ 关键：探测到后端就是 API 模式，此时绝不允许「静默降级成本地示例数据」——
      //    否则用户会看到种子数据，误以为「数据被清空了」。
      let lastErr = null;
      for (let i = 0; i < 3; i++) {
        try {
          _data = normalizeData(await apiGet());
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (e.name === 'AuthError') {
            _ready = true;
            _readyCallbacks.forEach(cb => cb(null));
            _emit({ authRequired: true });
            return null;
          }
          if (i < 2) await sleep(400 * (i + 1));
        }
      }
      if (lastErr) {
        _loadError = lastErr.message || String(lastErr);
        console.error('[DashboardStore] 数据读取失败（不会降级为示例数据）:', lastErr);
        _ready = true;
        _readyCallbacks.forEach(cb => cb(null));
        _emit({ loadFailed: true, error: _loadError });
        return null;
      }
      startSSE();
    } else {
      _data = normalizeData(await loadLocal());
      // 浏览器直开本地文件（file://）属正常离线用法；
      // 若是 http(s) 页面却探不到后端，则要显著提示，避免把示例数据当真数据看
      _degraded = location.protocol !== 'file:';
      if (_degraded) console.warn('[DashboardStore] 未连接到服务器，当前显示的是本地/示例数据');
    }

    try { await loadConfig(); } catch (_) {}

    _ready = true;
    _readyCallbacks.forEach(cb => cb(_data));
    _emit({ source: 'init' });
    return _data;
  }

  async function loadLocal() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}

    if (stored) {
      try { return JSON.parse(stored); } catch (e) { console.warn('localStorage 解析失败', e); }
    }

    if (window.SEED_DATA) return clone(window.SEED_DATA);
    try {
      const resp = await fetch('./seed-data.json');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } catch (e) {
      console.error('默认数据加载失败', e);
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // 行级修改
  // -------------------------------------------------------------------------

  function _renumberRows(rows) {
    return rows.map((r, idx) => {
      const o = (r && typeof r === 'object' && !Array.isArray(r)) ? { ...r } : { value: r };
      o['序号'] = idx + 1;
      return o;
    });
  }

  async function _persist() {
    // 兜底：宁可报错，也不要用一份空数据覆盖服务端
    if (!_data || !sheetKeys(_data).length) {
      throw new Error('本地数据为空，已阻止写入（防止把服务端数据清空）');
    }
    if (_mode === 'api') {
      try {
        await apiPut(_data);
        _lastSync = new Date().toISOString();
      } catch (e) {
        console.error('[DashboardStore] 推送后端失败', e);
        throw e;
      }
    } else {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_data)); } catch (e) {}
    }
    _emit({ source: 'local' });
  }

  async function updateSheet(key, rows) {
    if (!_data || !_data[key]) return;
    _data[key].rows = _renumberRows(rows);
    await _persist();
  }

  async function addRow(key, row) {
    if (!_data || !_data[key]) return;
    const rows = _data[key].rows.slice();
    rows.push(row);
    _data[key].rows = _renumberRows(rows);
    await _persist();
  }

  async function deleteRow(key, index) {
    if (!_data || !_data[key]) return;
    _data[key].rows = _renumberRows(_data[key].rows.filter((_, i) => i !== index));
    await _persist();
  }

  async function replaceRow(key, index, row) {
    if (!_data || !_data[key]) return;
    const rows = _data[key].rows.slice();
    rows[index] = row;
    _data[key].rows = _renumberRows(rows);
    await _persist();
  }

  async function replaceAll(newData) {
    _data = normalizeData(clone(newData));
    await _persist();
  }

  /**
   * 强制从服务端重新拉一份最新数据并替换内存副本（不触发回调，由调用方决定何时刷新）。
   *
   * 用途：「按工会编辑瀑布图」这类**整组替换**的保存动作，必须以服务端最新数据为基底。
   * 只凭打开弹窗那一刻的快照去 PUT 一整份数据，只要期间有别的写入（另一标签页 / 手机端 /
   * 上一次保存的 SSE 回声），那些工会就会被旧快照覆盖掉 —— 这是「编辑后工会消失」的另一条路径。
   */
  async function fetchLatest() {
    if (_mode === 'api') {
      const fresh = await apiGet();
      _data = normalizeData(fresh);
      _lastSync = new Date().toISOString();
    }
    return _data;
  }

  async function reset() {
    if (_mode === 'api') {
      _data = await apiReset();
      _data = normalizeData(_data);
      _lastSync = new Date().toISOString();
    } else {
      _data = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      _data = await loadLocal();
      _data = normalizeData(_data);
    }
    _emit({ source: 'reset' });
  }

  // -------------------------------------------------------------------------
  // 表结构（schema）修改
  // -------------------------------------------------------------------------

  function getSchema(key) {
    if (!_data || !_data[key]) return null;
    const sheet = _data[key];
    return {
      headers: sheet.headers.slice(),
      schema: { ...sheet.schema },
    };
  }

  /** 添加新列。position 缺省则追加末尾；position 是 headers 中的字段名时插到该字段后 */
  async function addColumn(key, fieldName, def, position) {
    if (!_data || !_data[key]) throw new Error('表不存在: ' + key);
    if (!fieldName || typeof fieldName !== 'string') throw new Error('列名不能为空');
    const sheet = _data[key];
    if (sheet.headers.includes(fieldName)) throw new Error('已存在同名列: ' + fieldName);

    // 默认字段定义
    const finalDef = { type: 'text', ...def };
    // options 校验：select 类型必须 options
    if (finalDef.type === 'select' && (!Array.isArray(finalDef.options) || !finalDef.options.length)) {
      finalDef.options = ['选项1'];
    }

    // 插入位置（"序号" 列始终在第一位）
    let insertAt = sheet.headers.length;
    if (position) {
      const i = sheet.headers.indexOf(position);
      if (i >= 0) insertAt = i + 1;
    }
    // 不允许插到序号列前面
    if (insertAt <= 1) insertAt = 1;

    const newHeaders = sheet.headers.slice();
    newHeaders.splice(insertAt, 0, fieldName);

    const newSchema = { ...sheet.schema };
    newSchema[fieldName] = finalDef;

    // 所有行补一个空字段
    const newRows = sheet.rows.map(r => {
      const obj = (r && typeof r === 'object' && !Array.isArray(r)) ? { ...r } : migrateRow(r, sheet.headers);
      obj[fieldName] = '';
      return obj;
    });

    sheet.headers = newHeaders;
    sheet.schema = newSchema;
    sheet.rows = newRows;
    await _persist();
  }

  /** 删除列：headers/schema/所有行同步移除该字段 */
  async function removeColumn(key, fieldName) {
    if (!_data || !_data[key]) throw new Error('表不存在: ' + key);
    if (fieldName === '序号') throw new Error('「序号」列不可删除');
    const sheet = _data[key];
    if (!sheet.headers.includes(fieldName)) throw new Error('列不存在: ' + fieldName);

    sheet.headers = sheet.headers.filter(h => h !== fieldName);
    const newSchema = { ...sheet.schema };
    delete newSchema[fieldName];
    sheet.schema = newSchema;
    sheet.rows = sheet.rows.map(r => {
      const obj = { ...r };
      delete obj[fieldName];
      return obj;
    });
    await _persist();
  }

  /** 重命名列：headers、schema、所有行的 key 都改名 */
  async function renameColumn(key, oldName, newName) {
    if (!_data || !_data[key]) throw new Error('表不存在: ' + key);
    if (!oldName || !newName) throw new Error('名称不能为空');
    if (oldName === '序号') throw new Error('「序号」列不可重命名');
    if (oldName === newName) return;
    const sheet = _data[key];
    if (!sheet.headers.includes(oldName)) throw new Error('列不存在: ' + oldName);
    if (sheet.headers.includes(newName)) throw new Error('已存在同名列: ' + newName);

    sheet.headers = sheet.headers.map(h => h === oldName ? newName : h);
    const newSchema = { ...sheet.schema };
    newSchema[newName] = newSchema[oldName];
    delete newSchema[oldName];
    sheet.schema = newSchema;
    sheet.rows = sheet.rows.map(r => {
      const obj = { ...r };
      if (oldName in obj) obj[newName] = obj[oldName];
      delete obj[oldName];
      return obj;
    });
    await _persist();
  }

  /** 修改字段定义（type/required/full/options）。可单独传 options 用于改下拉菜单 */
  async function updateColumn(key, fieldName, def) {
    if (!_data || !_data[key]) throw new Error('表不存在: ' + key);
    if (fieldName === '序号') throw new Error('「序号」列不可修改');
    const sheet = _data[key];
    if (!sheet.schema[fieldName]) throw new Error('列不存在: ' + fieldName);

    const merged = { ...sheet.schema[fieldName], ...def };
    if (merged.type === 'select' && (!Array.isArray(merged.options) || !merged.options.length)) {
      merged.options = ['选项1'];
    }
    sheet.schema = { ...sheet.schema, [fieldName]: merged };
    await _persist();
  }

  /** 调整列顺序：direction = -1 (上移) 或 +1 (下移) */
  async function moveColumn(key, fieldName, direction) {
    if (!_data || !_data[key]) throw new Error('表不存在: ' + key);
    if (fieldName === '序号') throw new Error('「序号」列不可移动');
    const sheet = _data[key];
    const idx = sheet.headers.indexOf(fieldName);
    if (idx < 0) throw new Error('列不存在');
    const targetIdx = idx + direction;
    if (targetIdx <= 0 || targetIdx >= sheet.headers.length) return; // 边界

    const newHeaders = sheet.headers.slice();
    const [moved] = newHeaders.splice(idx, 1);
    newHeaders.splice(targetIdx, 0, moved);
    sheet.headers = newHeaders;
    await _persist();
  }

  // -------------------------------------------------------------------------
  // 看板配置（文字 / 布局 / 指标 / 图表 / 主题）
  // -------------------------------------------------------------------------

  function defaultConfig() { return clone(window.SEED_CONFIG || {}); }

  function mergeWithDefaults(stored) {
    const base = defaultConfig();
    if (window.ConfigEngine && ConfigEngine.mergeConfig) return ConfigEngine.mergeConfig(base, stored);
    return stored || base;
  }

  function loadLocalConfig() {
    let stored = null;
    try { stored = localStorage.getItem(CONFIG_KEY); } catch (_) {}
    let parsed = null;
    if (stored) { try { parsed = JSON.parse(stored); } catch (_) { console.warn('配置解析失败，回退默认'); } }
    return mergeWithDefaults(parsed);
  }

  async function loadConfig() {
    if (_mode === 'api') {
      try {
        const cfg = await apiGetConfig();
        _config = mergeWithDefaults(cfg);
      } catch (e) {
        if (e.name === 'AuthError') throw e;
        console.warn('[DashboardStore] 配置拉取失败，改用本地默认配置', e);
        _config = loadLocalConfig();
      }
    } else {
      _config = loadLocalConfig();
    }
    _configListeners.forEach(cb => { try { cb(_config); } catch (e) { console.error(e); } });
    return _config;
  }

  /** 保存整份配置（后台「看板配置」用） */
  async function saveConfig(cfg) {
    const next = clone(cfg);
    if (_mode === 'api') {
      await apiPutConfig(next);
      _config = mergeWithDefaults(next);
    } else {
      _config = next;
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); } catch (_) {}
    }
    _configListeners.forEach(cb => { try { cb(_config); } catch (e) { console.error(e); } });
    _emit({ configOnly: true, source: 'local' });
    return _config;
  }

  /** 恢复默认配置 */
  async function resetConfig() {
    const base = defaultConfig();
    if (_mode === 'api') {
      await apiPutConfig(base);
    } else {
      try { localStorage.removeItem(CONFIG_KEY); } catch (_) {}
    }
    _config = base;
    _configListeners.forEach(cb => { try { cb(_config); } catch (e) { console.error(e); } });
    _emit({ configOnly: true, source: 'reset' });
    return _config;
  }

  function getConfig() { return _config; }
  function subscribeConfig(cb) {
    _configListeners.add(cb);
    if (_config) { try { cb(_config); } catch (_) {} }
    return () => _configListeners.delete(cb);
  }

  // -------------------------------------------------------------------------
  // 登录 / 会话
  // -------------------------------------------------------------------------

  async function authStatus() {
    if (_mode === 'local') {
      return { mode: 'local', needAuth: false, dashboard: true, admin: true, offline: true };
    }
    try {
      const s = await httpJson('/api/auth/status', { cache: 'no-store' });
      s.mode = 'api';
      s.needAuth = true;
      return s;
    } catch (e) {
      return { mode: 'api', needAuth: false, dashboard: true, admin: true, error: e.message };
    }
  }

  /** role: 'dashboard' | 'admin' */
  async function authLogin(role, password) {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, password }),
    });
    let body = {};
    try { body = await resp.json(); } catch (_) {}
    if (!resp.ok) {
      const err = new Error(body.error || (resp.status === 401 ? '密码错误' : '登录失败'));
      err.status = resp.status;
      throw err;
    }
    _unauthorized = false;
    return body;
  }

  async function authLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    stopSSE();
    _unauthorized = true;
    _emit();
    return true;
  }

  /** 修改密码（需后台会话）：role 指定要改哪个密码 */
  async function authChangePassword(role, current, next) {
    const resp = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, current, next }),
    });
    let body = {};
    try { body = await resp.json(); } catch (_) {}
    if (!resp.ok) {
      const err = new Error(body.error || '修改失败');
      err.status = resp.status;
      throw err;
    }
    return body;
  }

  function getAuthState() { return { unauthorized: _unauthorized, mode: _mode }; }

  // -------------------------------------------------------------------------
  // 订阅 / 状态
  // -------------------------------------------------------------------------

  function subscribe(cb) {
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  }

  function getData() { return _data; }
  function getSheet(key) { return _data && _data[key]; }

  function onReady(cb) {
    if (_ready) cb(_data);
    else _readyCallbacks.push(cb);
  }

  function getMode() { return _mode; }
  function getLoadError() { return _loadError; }
  function isDegraded() { return _degraded; }
  function getStatus() {
    return {
      mode: _mode,
      connected: _mode === 'local' ? true : _connected,
      lastSync: _lastSync,
      ready: _ready,
      degraded: _degraded,
      loadError: _loadError,
    };
  }

  // -------------------------------------------------------------------------
  // 存储诊断 / 备份恢复（后台「安全设置」用）
  // -------------------------------------------------------------------------

  async function getStorageInfo() {
    if (_mode !== 'api') {
      return { persistent: true, dataDir: '(浏览器本地存储)', mode: 'local', rows: 0, sheets: sheetKeys(_data).length, backupCount: 0, hints: ['当前是离线/本地模式，数据存在浏览器里。'] };
    }
    return httpJson('/api/storage', { cache: 'no-store' });
  }

  async function listBackups() {
    if (_mode !== 'api') return { count: 0, backups: [], dir: '' };
    return httpJson('/api/backups', { cache: 'no-store' });
  }

  async function createBackup(kind) {
    return httpJson('/api/backups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind || 'data' }),
    });
  }

  /** 用某份快照覆盖回去（改配置的快照会顺带刷新配置） */
  async function restoreBackup(name) {
    const r = await httpJson('/api/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (String(name).startsWith('server-config.')) {
      await loadConfig();
      _emit({ configOnly: true, source: 'local' });
    } else {
      _data = normalizeData(await apiGet());
      _endSync();
      _emit({ source: 'local' });
    }
    return r;
  }

  function _endSync() { _lastSync = new Date().toISOString(); }

  function _emit(info) {
    // info.statusOnly=true 表示只是连接状态变化，UI 可只刷新徽章，无需重绘数据
    const payload = info || { statusOnly: true };
    _listeners.forEach(cb => { try { cb(_data, payload); } catch (e) { console.error(e); } });
  }

  // -------------------------------------------------------------------------
  // localStorage 跨 tab 兜底（仅本地模式生效）
  // -------------------------------------------------------------------------

  window.addEventListener('storage', (e) => {
    if (_mode !== 'local') return;
    if (e.key === CONFIG_KEY) {
      _config = loadLocalConfig();
      _configListeners.forEach(cb => { try { cb(_config); } catch (err) { console.error(err); } });
      _emit({ configOnly: true, source: 'storage-event' });
      return;
    }
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      _data = normalizeData(JSON.parse(e.newValue));
      _listeners.forEach(cb => { try { cb(_data, { source: 'storage-event' }); } catch (err) { console.error(err); } });
    } catch (err) { console.error(err); }
  });

  // -------------------------------------------------------------------------
  // 暴露
  // -------------------------------------------------------------------------

  window.DashboardStore = {
    load, onReady, getData, getSheet,
    getSchema,
    updateSheet, addRow, deleteRow, replaceRow, replaceAll, fetchLatest,
    addColumn, removeColumn, renameColumn, updateColumn, moveColumn,
    reset, subscribe,
    getMode, getStatus,
    pickValue,
    BUILTIN_SCHEMA,  // 暴露供后台初次迁移时使用

    // 看板配置
    getConfig, saveConfig, resetConfig, subscribeConfig,

    // 存储诊断 / 备份恢复
    getStorageInfo, listBackups, createBackup, restoreBackup,

    // 状态
    getLoadError, isDegraded,

    // 登录 / 会话
    authStatus, authLogin, authLogout, authChangePassword, getAuthState,
  };
})();
