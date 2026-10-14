/* ===== 配置引擎 ConfigEngine =====
 * 看板与后台共用：把「配置」翻译成「数字与图表数据」。
 *   - 数据链接：sheet + agg + field + where  →  聚合
 *   - 计算公式：expr 里用 {指标id} 引用其它指标，支持 + - * / ( ) 与数字（无 eval，自带解析器）
 *   - 图表/表格：分组聚合、交叉表
 * 纯函数、无依赖，可在 Node 里直接单测。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------

  function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  /** 深合并：对象递归；数组以 patch 为准（用户的顺序/增删不该被默认值覆盖） */
  function deepMerge(base, patch) {
    if (patch === undefined) return clone(base);
    if (isPlainObject(base) && isPlainObject(patch)) {
      const out = {};
      Object.keys(base).forEach(k => { out[k] = deepMerge(base[k], patch[k]); });
      Object.keys(patch).forEach(k => { if (!(k in out)) out[k] = clone(patch[k]); });
      return out;
    }
    return clone(patch);
  }

  function clone(v) {
    if (v === undefined || v === null) return v;
    return JSON.parse(JSON.stringify(v));
  }

  /** 合并默认配置与已存配置（补齐新增字段，不动用户已有设置） */
  function mergeConfig(defaults, stored) {
    if (!stored || !Object.keys(stored).length) return clone(defaults);
    return deepMerge(defaults, stored);
  }

  /** 安全取字段值，兼容对象行与数组行 */
  function pick(row, headers, field) {
    if (row == null || !field) return '';
    if (isPlainObject(row)) {
      return row[field] !== undefined && row[field] !== null ? row[field] : '';
    }
    const i = (headers || []).indexOf(field);
    return i >= 0 && i < row.length && row[i] != null ? row[i] : '';
  }

  /** 转数字：空串/非数字 → null */
  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/,/g, '').trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // ---------------------------------------------------------------------
  // 筛选条件 where: [{ field, op, value }]
  // ---------------------------------------------------------------------
  const OPS = ['==', '!=', 'contains', 'notContains', 'empty', 'notEmpty', '>', '>=', '<', '<='];
  const OP_LABEL = {
    '==': '等于', '!=': '不等于', 'contains': '包含', 'notContains': '不包含',
    'empty': '为空', 'notEmpty': '不为空', '>': '大于', '>=': '大于等于', '<': '小于', '<=': '小于等于',
  };

  function matchWhere(row, headers, where) {
    if (!where || !where.length) return true;
    return where.every(c => {
      if (!c || !c.field) return true;
      const raw = pick(row, headers, c.field);
      const sv = String(raw == null ? '' : raw).trim();
      const cv = c.value == null ? '' : String(c.value).trim();
      const nv = toNum(sv), ncv = toNum(cv);
      switch (c.op || '==') {
        case '==': return sv === cv;
        case '!=': return sv !== cv;
        case 'contains': return cv === '' ? true : sv.includes(cv);
        case 'notContains': return cv === '' ? true : !sv.includes(cv);
        case 'empty': return sv === '';
        case 'notEmpty': return sv !== '';
        case '>': return nv !== null && ncv !== null && nv > ncv;
        case '>=': return nv !== null && ncv !== null && nv >= ncv;
        case '<': return nv !== null && ncv !== null && nv < ncv;
        case '<=': return nv !== null && ncv !== null && nv <= ncv;
        default: return true;
      }
    });
  }

  function filterRows(sheet, where) {
    const headers = (sheet && sheet.headers) || [];
    const rows = (sheet && sheet.rows) || [];
    if (!where || !where.length) return rows;
    return rows.filter(r => matchWhere(r, headers, where));
  }

  // ---------------------------------------------------------------------
  // 聚合：count / sum / avg / max / min / distinct
  // ---------------------------------------------------------------------
  const AGG_LABEL = { count: '计数', sum: '求和', avg: '平均值', max: '最大值', min: '最小值', distinct: '去重计数' };

  /** 取一行的数值（支持 fallbackField 兜底列 + scale 缩放） */
  function rowNumber(row, headers, spec) {
    const primary = toNum(pick(row, headers, spec.field));
    if (primary !== null) return primary * (typeof spec.scale === 'number' ? spec.scale : 1);
    if (spec.fallbackField) {
      const fb = toNum(pick(row, headers, spec.fallbackField));
      if (fb !== null) return fb * (typeof spec.fallbackScale === 'number' ? spec.fallbackScale : 1);
    }
    return null;
  }

  function aggregate(sheet, spec) {
    if (!sheet) return 0;
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, spec.where);
    const agg = spec.agg || 'count';

    if (agg === 'count') return rows.length;
    if (agg === 'distinct') {
      const set = new Set(rows.map(r => String(pick(r, headers, spec.field) == null ? '' : pick(r, headers, spec.field))));
      set.delete('');
      return set.size;
    }
    const nums = rows.map(r => rowNumber(r, headers, spec)).filter(v => v !== null);
    if (!nums.length) return 0;
    switch (agg) {
      case 'sum': return nums.reduce((a, b) => a + b, 0);
      case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
      case 'max': return Math.max.apply(null, nums);
      case 'min': return Math.min.apply(null, nums);
      default: return rows.length;
    }
  }

  // ---------------------------------------------------------------------
  // 计算公式：{metric-id} 引用 + 四则运算（无 eval）
  // ---------------------------------------------------------------------
  function tokenizeExpr(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
      if (/[0-9.]/.test(ch)) {
        let num = '';
        while (i < s.length && /[0-9.]/.test(s[i])) { num += s[i]; i++; }
        i--;
        out.push({ t: 'num', v: parseFloat(num) || 0 });
      } else if ('+-*/()'.indexOf(ch) >= 0) {
        out.push({ t: 'op', v: ch });
      } else {
        // 其它字符（含中文说明）一律忽略
      }
    }
    return out;
  }

  /** 把 {指标id} 替换成数值；未定义的指标按 0 处理 */
  function substitute(expr, scope) {
    return String(expr || '').replace(/\{([^}]+)\}/g, (_m, id) => {
      const key = String(id).trim();
      const v = scope && scope[key];
      return (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '0';
    });
  }

  function evalExpr(expr, scope) {
    const tk = tokenizeExpr(substitute(expr, scope));
    let i = 0;
    const peek = () => tk[i] && tk[i].v;
    const next = () => tk[i++];
    function parseExpr() {
      let v = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = next().v;
        const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function parseTerm() {
      let v = parseUnary();
      while (peek() === '*' || peek() === '/') {
        const op = next().v;
        const r = parseUnary();
        v = op === '*' ? v * r : (r === 0 ? 0 : v / r);
      }
      return v;
    }
    function parseUnary() {
      if (peek() === '-') { next(); return -parseUnary(); }
      if (peek() === '+') { next(); return parseUnary(); }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = next();
      if (!t) return 0;
      if (t.v === '(') {
        const v = parseExpr();
        if (peek() === ')') next();
        return v;
      }
      return typeof t.v === 'number' ? t.v : 0;
    }
    const v = parseExpr();
    return Number.isFinite(v) ? v : 0;
  }

  // ---------------------------------------------------------------------
  // 指标计算
  // ---------------------------------------------------------------------
  function computeMetrics(data, config) {
    const out = {};
    const list = (config && config.metrics) || [];
    const sheetOf = (name) => (data || {})[name];

    // 第一轮：普通聚合指标
    list.forEach(m => {
      if (!m || !m.id) return;
      if (m.expr) return;
      out[m.id] = aggregate(sheetOf(m.sheet), m);
    });

    // 第二轮：公式指标（允许链式引用，最多 5 轮收敛）
    const formulas = list.filter(m => m && m.id && m.expr);
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      formulas.forEach(m => {
        const v = evalExpr(m.expr, out);
        if (out[m.id] !== v) { out[m.id] = v; changed = true; }
      });
      if (!changed) break;
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // 图表：分组聚合
  // ---------------------------------------------------------------------
  function groupRows(sheet, spec) {
    if (!sheet) return [];
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, spec.where);
    const map = new Map();
    rows.forEach(r => {
      let key = pick(r, headers, spec.groupBy);
      key = (key === null || key === undefined || String(key).trim() === '') ? '（空）' : String(key);
      let st = map.get(key);
      if (!st) { st = { key, sum: 0, n: 0, max: -Infinity, min: Infinity }; map.set(key, st); }
      const num = rowNumber(r, headers, spec);
      st.n += 1;
      if (num !== null) { st.sum += num; st.max = Math.max(st.max, num); st.min = Math.min(st.min, num); }
    });
    const agg = spec.agg || 'count';
    let list = [...map.values()].map(st => {
      let value;
      switch (agg) {
        case 'sum': value = st.sum; break;
        case 'avg': value = st.n ? st.sum / st.n : 0; break;
        case 'max': value = Number.isFinite(st.max) ? st.max : 0; break;
        case 'min': value = Number.isFinite(st.min) ? st.min : 0; break;
        default: value = st.n;
      }
      return { name: st.key, value };
    });

    switch (spec.sortBy) {
      case 'valueDesc': list.sort((a, b) => b.value - a.value); break;
      case 'valueAsc': list.sort((a, b) => a.value - b.value); break;
      case 'nameAsc': list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')); break;
      default: break; // data 顺序
    }
    return list;
  }

  // ---------------------------------------------------------------------
  // 统计表
  // ---------------------------------------------------------------------
  function uniqKeys(rows) {
    const seen = new Set(), out = [];
    rows.forEach(k => { const s = String(k == null ? '' : k).trim() || '（空）'; if (!seen.has(s)) { seen.add(s); out.push(s); } });
    return out;
  }

  /** 分组表：按某字段分组，多列统计 */
  function groupTable(sheet, def) {
    if (!sheet) return { head: [], rows: [] };
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, def.where);
    const groups = uniqKeys(rows.map(r => pick(r, headers, def.groupBy)));
    const cols = (def.columns && def.columns.length) ? def.columns : [{ label: '数量', agg: 'count' }];

    const pickStat = { count: 'count', sum: 'sum', avg: 'avg', max: 'max', min: 'min', distinct: 'distinct' };
    let body = groups.map(g => {
      const rws = rows.filter(r => (String(pick(r, headers, def.groupBy) == null ? '' : pick(r, headers, def.groupBy)).trim() || '（空）') === g);
      const cells = cols.map(c => {
        const s = { agg: pickStat[c.agg] || 'count', field: c.field, scale: c.scale };
        const v = aggregate({ headers, rows: rws }, s);
        return v;
      });
      return { key: g, cells, sortValue: cells.length ? Number(cells[0]) || 0 : rws.length };
    });

    if (def.sortBy === 'valueDesc') body.sort((a, b) => b.sortValue - a.sortValue);
    else if (def.sortBy === 'valueAsc') body.sort((a, b) => a.sortValue - b.sortValue);
    else if (def.sortBy === 'nameAsc') body.sort((a, b) => String(a.key).localeCompare(String(b.key), 'zh'));
    if (def.limit && def.limit > 0) body = body.slice(0, def.limit);

    return { head: cols.map(c => c.label || ''), rows: body };
  }

  /** 交叉表：行字段 × 列字段，带合计 */
  function crossTable(sheet, def) {
    if (!sheet) return { head: [], rows: [], colTotals: [], grand: 0 };
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, def.where);
    const rowKeys = uniqKeys(rows.map(r => pick(r, headers, def.rowField)));
    const cols = ((def.crossColumns && def.crossColumns.length) ? def.crossColumns
      : uniqKeys(rows.map(r => pick(r, headers, def.colField))).map(k => ({ key: k, label: k })))
      .map(c => ({ key: String(c.key), label: c.label || String(c.key) }));

    const norm = v => (String(v == null ? '' : v).trim() || '（空）');
    const body = rowKeys.map(k => {
      const rws = rows.filter(r => norm(pick(r, headers, def.rowField)) === k);
      const cells = cols.map(c => rws.filter(r => norm(pick(r, headers, def.colField)) === c.key).length);
      return { key: k, cells, total: cells.reduce((a, b) => a + b, 0) };
    });
    const colTotals = cols.map((_c, ci) => body.reduce((a, b) => a + b.cells[ci], 0));
    const grand = colTotals.reduce((a, b) => a + b, 0);
    return { head: cols.map(c => c.label), rows: body, colTotals, grand };
  }

  /** 统一入口：按表定义渲染数据 */
  function buildTable(sheet, def) {
    return def.type === 'cross' ? crossTable(sheet, def) : groupTable(sheet, def);
  }

  // ---------------------------------------------------------------------
  // 数字格式化
  // ---------------------------------------------------------------------
  function fmtNum(v, decimals) {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
    const d = (typeof decimals === 'number' && decimals >= 0) ? decimals : 2;
    const n = Number(v);
    if (d === 0) return String(Math.round(n));
    return n.toFixed(d);
  }

  root.ConfigEngine = {
    mergeConfig, deepMerge, clone,
    pick, toNum,
    matchWhere, filterRows,
    aggregate, rowNumber,
    evalExpr, substitute, tokenizeExpr,
    computeMetrics,
    groupRows, groupTable, crossTable, buildTable,
    fmtNum,
    OPS, OP_LABEL, AGG_LABEL,
  };
})(typeof window !== 'undefined' ? window : globalThis);
