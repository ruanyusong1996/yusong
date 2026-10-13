/* ===== 数据存储抽象层 =====
 * 支持两种模式，自动探测：
 *   - API 模式（多人共享）：通过 fetch + EventSource 与后端通信
 *   - 本地模式（向后兼容）：用 localStorage + storage 事件
 *
 * 检测方式：探测同源 /api/health，2 秒超时
 *   - 200 OK  → API 模式
 *   - 失败   → 本地模式
 *
 * 公共 API:
 *   DashboardStore.load()         Promise<data>
 *   DashboardStore.onReady(cb)
 *   DashboardStore.getData()      → 当前数据快照
 *   DashboardStore.getSheet(key)
 *   DashboardStore.updateSheet(key, rows)
 *   DashboardStore.addRow(key, row)
 *   DashboardStore.deleteRow(key, index)
 *   DashboardStore.replaceRow(key, index, row)
 *   DashboardStore.replaceAll(data)
 *   DashboardStore.reset()
 *   DashboardStore.subscribe(cb) → 返回取消订阅函数
 *   DashboardStore.getMode()      → 'api' | 'local'
 *   DashboardStore.getStatus()    → { mode, connected, lastSync, clients }
 */

(function () {
  const STORAGE_KEY = 'hdj_dashboard_data_v1';
  const CLIENT_ID_KEY = 'hdj_client_id';
  const API_TIMEOUT_MS = 2000;
  const REQUIRED_KEYS = ['01-组织建设', '02-走访慰问', '03-员工活动', '04-经费收支'];

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
        'X-Editor': location.hostname,
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
          _data = fresh;
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
      } catch (e) {
        console.error('[DashboardStore] API 拉取失败，回退本地', e);
        _mode = 'local';
        _data = await loadLocal();
      }
      if (_mode === 'api') startSSE();
    } else {
      _data = await loadLocal();
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
  // 修改操作
  // -------------------------------------------------------------------------

  function _renumberRows(rows) {
    return rows.map((r, idx) => {
      const newRow = r.slice();
      newRow[0] = idx + 1;
      return newRow;
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
    _data = clone(newData);
    await _persist();
  }

  async function reset() {
    if (_mode === 'api') {
      _data = await apiReset();
      _lastSync = new Date().toISOString();
    } else {
      _data = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      _data = await loadLocal();
    }
    _emit({ source: 'reset' });
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
      _data = JSON.parse(e.newValue);
      _listeners.forEach(cb => { try { cb(_data, { source: 'storage-event' }); } catch (err) { console.error(err); } });
    } catch (err) { console.error(err); }
  });

  // -------------------------------------------------------------------------
  // 暴露
  // -------------------------------------------------------------------------

  window.DashboardStore = {
    load, onReady, getData, getSheet,
    updateSheet, addRow, deleteRow, replaceRow, replaceAll,
    reset, subscribe,
    getMode, getStatus,
  };
})();
