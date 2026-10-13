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
  const CLIENT_ID_KEY = 'hdj_client_id';
  const API_TIMEOUT_MS = 2000;
  const REQUIRED_KEYS = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支'];

  // 默认字段定义（兼容老数据：首次加载时若 DATA 没 schema，就用这套补齐）
  const BUILTIN_SCHEMA = {
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
  let _mode = 'local';           // 'api' | 'local'
  let _connected = false;        // SSE 连接状态
  let _lastSync = null;          // 最近一次推送时间
  let _ready = false;
  const _readyCallbacks = [];
  const _listeners = new Set();

  let _sse = null;               // EventSource 实例
  let _sseReconnectTimer = null;

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

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
      // 有 schema 但缺字段的，也补默认
      headers.forEach(h => {
        if (!(h in schema)) schema[h] = { type: 'text' };
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

  async function apiGet() {
    const resp = await fetch('/api/data', { cache: 'no-store' });
    if (!resp.ok) throw new Error('GET /api/data ' + resp.status);
    return resp.json();
  }

  async function apiPut(newData) {
    const resp = await fetch('/api/data', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Editor': hostNameSafe(),
        'X-Client-Id': CLIENT_ID,
      },
      body: JSON.stringify(newData),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('PUT /api/data ' + resp.status + ' ' + t);
    }
    return resp.json();
  }

  function hostNameSafe() {
    try { return location.hostname; } catch (_) { return 'anonymous'; }
  }

  async function apiReset() {
    const resp = await fetch('/api/reset', { method: 'POST' });
    if (!resp.ok) throw new Error('POST /api/reset ' + resp.status);
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
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
      const resp = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      return resp.ok;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 加载
  // -------------------------------------------------------------------------

  async function load() {
    if (_data) return _data;

    const isApi = await probeApi();
    _mode = isApi ? 'api' : 'local';
    console.log(`[DashboardStore] 模式: ${_mode}`);

    if (_mode === 'api') {
      try {
        _data = await apiGet();
        _data = normalizeData(_data);
      } catch (e) {
        console.error('[DashboardStore] API 拉取失败，回退本地', e);
        _mode = 'local';
        _data = await loadLocal();
        _data = normalizeData(_data);
      }
      if (_mode === 'api') startSSE();
    } else {
      _data = await loadLocal();
      _data = normalizeData(_data);
    }

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
  function getStatus() {
    return {
      mode: _mode,
      connected: _mode === 'local' ? true : _connected,
      lastSync: _lastSync,
      ready: _ready,
    };
  }

  function _emit(info) {
    // info.statusOnly=true 表示只是连接状态变化，UI 可只刷新徽章，无需重绘数据
    const payload = info || { statusOnly: true };
    _listeners.forEach(cb => { try { cb(_data, payload); } catch (e) { console.error(e); } });
  }

  // -------------------------------------------------------------------------
  // localStorage 跨 tab 兜底（仅本地模式生效）
  // -------------------------------------------------------------------------

  window.addEventListener('storage', (e) => {
    if (_mode !== 'local' || e.key !== STORAGE_KEY || !e.newValue) return;
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
    updateSheet, addRow, deleteRow, replaceRow, replaceAll,
    addColumn, removeColumn, renameColumn, updateColumn, moveColumn,
    reset, subscribe,
    getMode, getStatus,
    pickValue,
    BUILTIN_SCHEMA,  // 暴露供后台初次迁移时使用
  };
})();
