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
  /**
   * 从日期字段里取「YYYY-MM」月份键。
   * 支持：Date 对象 / 2026-08-05 / 2026/8/5 / 2026.8.5 / 2026年8月5日 / 2026-08 / Excel 日期序列号。
   * 取不到月份一律返回 null —— 调用方据此把「日期不是正规日期」的行排除出月度统计
   * （这些行仍然计入总人次/总场次，只是月度分布里看不到，属于待补录数据）。
   */
  function monthKey(v) {
    if (v === null || v === undefined || v === '') return null;
    // 鸭子类型判断而不是 instanceof Date：跨 iframe / vm 沙箱时 instanceof 会失效
    if (typeof v.getFullYear === 'function' && typeof v.getMonth === 'function') {
      const t = typeof v.getTime === 'function' ? v.getTime() : NaN;
      if (Number.isNaN(t)) return null;
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
    }
    const s = String(v).trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})/);
    if (m) {
      const mo = Number(m[2]);
      if (mo >= 1 && mo <= 12) return `${m[1]}-${String(mo).padStart(2, '0')}`;
      return null;
    }
    // 纯数字：Excel 日期序列号（1900 起点；20000 ≈ 1954 年，太小的一律不算日期）
    const n = Number(s);
    if (Number.isFinite(n) && n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    return null;
  }

  /** 分组用的键：dateGroup='month' 时取月份（取不到返回 null = 这行不参与） */
  function groupKey(row, headers, spec) {
    const raw = pick(row, headers, spec.groupBy);
    if (spec.dateGroup === 'month') return monthKey(raw);
    if (raw === null || raw === undefined || String(raw).trim() === '') return '（空）';
    return String(raw);
  }

  function groupRows(sheet, spec) {
    if (!sheet) return [];
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, spec.where);
    const map = new Map();
    rows.forEach(r => {
      const key = groupKey(r, headers, spec);
      if (key === null) return;          // 月度分组时：日期不规范的行跳过
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

    // 时间维度即使没指定排序也要按月份升序，否则月度趋势图会乱序
    if (spec.dateGroup === 'month' && !spec.sortBy) {
      list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    }
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

  /** 交叉表：行字段 × 列字段，带合计
   *  增强点（v1.6）：
   *   - colDateGroup / rowDateGroup = 'month'：按月份当行/列（日期不规范的行排除）
   *   - value = { agg, field, scale }：单元格可以是求和/平均，不只是计数
   *   - colSort = 'asc' | 'desc'：列排序；按月分组时默认按月份升序
   */
  function crossTable(sheet, def) {
    if (!sheet) return { head: [], rows: [], colTotals: [], grand: 0 };
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, def.where);
    const norm = v => (String(v == null ? '' : v).trim() || '（空）');

    // 某一维的取值：dateGroup='month' 时返回月份键，取不到返回 null（该行不计入）
    const dimKey = (row, field, dateGroup) => {
      if (dateGroup === 'month') return monthKey(pick(row, headers, field));
      return norm(pick(row, headers, field));
    };
    const keep = (row, field, dateGroup) => dimKey(row, field, dateGroup) !== null;

    const rowDim = { field: def.rowField, dg: def.rowDateGroup };
    const colDim = { field: def.colField, dg: def.colDateGroup };

    const inRows = rows.filter(r => keep(r, rowDim.field, rowDim.dg) && keep(r, colDim.field, colDim.dg));

    // 行/列取值集合（去重、保序）
    const collect = (dim) => {
      const seen = new Set(), out = [];
      inRows.forEach(r => {
        const k = dimKey(r, dim.field, dim.dg);
        if (k === null || seen.has(k)) return;
        seen.add(k); out.push(k);
      });
      return out;
    };
    // hideEmptyRows：行字段为空的行不单列出来。
    // 「经办人」这类新加的列往往还没补录，全空时会出现一行孤零零的「（空）」，
    // 看着像坏了；关掉它反而更诚实（下面会显示"暂无数据"提示行）。
    const rowKeys = collect(rowDim)
      .filter(k => !(def.hideEmptyRows && k === '（空）'));
    let colKeys = collect(colDim);
    if (def.colSort === 'asc' || (colDim.dg === 'month' && def.colSort !== 'desc')) {
      colKeys.sort((a, b) => String(a).localeCompare(String(b), 'zh'));
    } else if (def.colSort === 'desc') {
      colKeys.sort((a, b) => String(b).localeCompare(String(a), 'zh'));
    }

    const cols = ((def.crossColumns && def.crossColumns.length) ? def.crossColumns
      : colKeys.map(k => ({ key: k, label: k })))
      .map(c => ({ key: String(c.key), label: c.label || String(c.key) }));

    // 单元格取值方式：默认计数（保持老配置行为不变）
    const val = def.value && def.value.agg ? def.value : { agg: 'count' };
    const cellValue = (subset) => aggregate(
      { headers, rows: subset },
      { agg: val.agg, field: val.field, scale: val.scale }
    );

    const body = rowKeys.map(k => {
      const rws = inRows.filter(r => dimKey(r, rowDim.field, rowDim.dg) === k);
      const cells = cols.map(c =>
        cellValue(rws.filter(r => String(dimKey(r, colDim.field, colDim.dg)) === c.key)));
      return { key: k, cells, total: cellValue(rws) };
    });
    const colTotals = cols.map(c =>
      cellValue(inRows.filter(r => String(dimKey(r, colDim.field, colDim.dg)) === c.key)));
    const grand = cellValue(inRows);
    return { head: cols.map(c => c.label), rows: body, colTotals, grand, columns: cols };
  }

  /**
   * 明细（列表）表：一行 = 数据表里的一行，列 = 配置里指定的字段。
   * 用于「筹建中工会筹建进度」这类要逐条看、又要能自由增删列的场景
   * （用户在后台「列管理」给数据表加一列，再到这里加一列就能显示出来）。
   * def: { sheet, where, columns: [{ field, label, render?, stages? }], sortBy, sortField, limit }
   * render: 'text'(默认) | 'progress'(进度条) | 'number'(数字格式化)
   */
  function listTable(sheet, def) {
    if (!sheet) return { head: [], rows: [], columns: [] };
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, def.where);
    const cols = (def.columns && def.columns.length)
      ? def.columns
      : [{ field: headers[1] || '', label: headers[1] || '名称' }];

    let body = rows.map((r, i) => {
      const cells = cols.map(c => pick(r, headers, c.field));
      return {
        key: String(cells[0] == null ? '' : cells[0]),
        cells,
        index: i,
        detailValue: (def.detail && def.detail.filterField) ? String(pick(r, headers, def.detail.filterField) || '') : '',
      };
    });

    if (def.sortBy === 'nameDesc') body.sort((a, b) => String(b.key).localeCompare(String(a.key), 'zh'));
    else if (def.sortBy === 'nameAsc') body.sort((a, b) => String(a.key).localeCompare(String(b.key), 'zh'));
    else if (def.sortBy === 'field' && def.sortField) {
      const fi = cols.findIndex(c => c.field === def.sortField);
      if (fi >= 0) body.sort((a, b) => String(a.cells[fi] == null ? '' : a.cells[fi]).localeCompare(String(b.cells[fi] == null ? '' : b.cells[fi]), 'zh'));
    }
    if (def.limit && def.limit > 0) body = body.slice(0, def.limit);
    return { head: cols.map(c => c.label || c.field || ''), rows: body, columns: cols };
  }

  /** 统一入口：按表定义渲染数据 */
  function buildTable(sheet, def) {
    if (def.type === 'list') return listTable(sheet, def);
    return def.type === 'cross' ? crossTable(sheet, def) : groupTable(sheet, def);
  }

  // ---------------------------------------------------------------------
  // 瀑布（桥梁）图：期初 → 入账 → 支出 → 结余
  // ---------------------------------------------------------------------
  // 数据表是「长表」：一行 = 某个工会的某个科目
  //   工会名称 | 收支类型(期初/入账/支出/结余) | 经费项目 | 金额（元）
  // 同一个收支类型可以有多行（多个入账项目、多个支出项目），自动累加。
  // 「结余」类型的行是手工指定值；没有这类行时结余 = 期初 + 入账 - 支出。
  // 金额统一按「元」返回：万一数据表还是老版本的「金额（万元）」，这里自动 ×10000。

  const DEFAULT_STAGES = { initial: '期初', income: '入账', expense: '支出', balance: '结余' };

  /**
   * 找出瀑布表里存金额的那一列，以及换算成「元」的乘数。
   * 优先用图表配置里指定的列；配置写的列不存在（比如老配置还写着万元、表已升级为元）时
   * 按表头自动兜底，避免整张图因为一个列名对不上而变成空白。
   */
  function resolveValueField(headers, def) {
    const H = headers || [];
    const candidates = [];
    if (def && def.field) candidates.push(def.field);
    candidates.push('金额（元）', '金额（万元）', '金额');
    for (let i = 0; i < candidates.length; i++) {
      const f = candidates[i];
      if (!f || H.indexOf(f) < 0) continue;
      return { field: f, scale: /万元/.test(f) ? 10000 : 1 };
    }
    return { field: (def && def.field) || '金额（元）', scale: 1 };
  }

  /** 阶段名 → initial / income / expense / balance；认不出来返回 null */
  function stageOf(value, def) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return null;
    const st = Object.assign({}, DEFAULT_STAGES, (def && def.stages) || {});
    if (s === st.initial) return 'initial';
    if (s === st.income) return 'income';
    if (s === st.expense) return 'expense';
    if (s === st.balance) return 'balance';
    // 兜底：用户可能填「年初金额」「上年结转」「收入」等近义词
    if (/期初|年初|上年结转|结转/.test(s)) return 'initial';
    if (/入账|收入|拨入|反拨/.test(s)) return 'income';
    if (/支出|开支/.test(s)) return 'expense';
    if (/结余|余额/.test(s)) return 'balance';
    return null;
  }

  /**
   * 汇总成每个工会一行：{ name, initial, income, expense, balance, manual, items }
   * manual=true 表示结余是手工指定的（表里有「结余」类型的行）
   */
  function waterfallRows(sheet, def) {
    if (!sheet) return [];
    const headers = sheet.headers || [];
    const rows = filterRows(sheet, def && def.where);
    const groupBy = (def && def.groupBy) || '工会名称';
    const stageField = (def && def.stageField) || '收支类型';
    const itemField = (def && def.itemField) || '经费项目';
    const vf = resolveValueField(headers, def);
    const valueField = vf.field;
    const map = new Map();

    rows.forEach(r => {
      const stage = stageOf(pick(r, headers, stageField), def);
      if (!stage) return;
      const key = String(pick(r, headers, groupBy) == null ? '' : pick(r, headers, groupBy)).trim() || '（空）';
      const num = toNum(pick(r, headers, valueField));
      const v = (num === null ? 0 : num) * vf.scale;
      let o = map.get(key);
      if (!o) {
        o = { name: key, initial: 0, income: 0, expense: 0, balanceManual: null, items: [] };
        map.set(key, o);
      }
      if (stage === 'initial') o.initial += v;
      else if (stage === 'income') o.income += v;
      else if (stage === 'expense') o.expense += Math.abs(v);
      else if (stage === 'balance') o.balanceManual = (o.balanceManual || 0) + v;
      o.items.push({ stage, item: String(pick(r, headers, itemField) == null ? '' : pick(r, headers, itemField)), value: v });
    });

    let list = [...map.values()].map(o => {
      const auto = o.initial + o.income - o.expense;
      return {
        name: o.name,
        initial: o.initial,
        income: o.income,
        expense: o.expense,
        balance: o.balanceManual === null ? auto : o.balanceManual,
        manual: o.balanceManual !== null,
        items: o.items,
      };
    });

    switch (def && def.sortBy) {
      case 'valueDesc': list.sort((a, b) => b.balance - a.balance); break;
      case 'valueAsc': list.sort((a, b) => a.balance - b.balance); break;
      case 'nameAsc': list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')); break;
      default: break;
    }
    if (def && def.limit && def.limit > 0) list = list.slice(0, def.limit);
    return list;
  }

  /** 从「经费收支」明细表推导出瀑布长表需要的行（补齐缺失的瀑布表时用） */
  const YUAN = 10000;
  function deriveWaterfallRows(sheet, groupField) {
    if (!sheet) return [];
    const headers = sheet.headers || [];
    const gf = groupField || (headers.indexOf('工会名称') >= 0 ? '工会名称' : '工会全称');
    const map = new Map();
    (sheet.rows || []).forEach(r => {
      const key = String(pick(r, headers, gf) == null ? '' : pick(r, headers, gf)).trim()
        || String(pick(r, headers, '工会全称') == null ? '' : pick(r, headers, '工会全称')).trim();
      if (!key) return;
      let o = map.get(key);
      if (!o) { o = { initial: 0, income: 0, expense: 0, items: [] }; map.set(key, o); }
      const type = String(pick(r, headers, '收支类型') == null ? '' : pick(r, headers, '收支类型'));
      const proj = String(pick(r, headers, '经费项目') == null ? '' : pick(r, headers, '经费项目')) || '未分类';

      // 经费收支表里「年初金额 / 支出金额 / 当前结余（元）」本身就是元；
      // 只有带（万元）后缀的列才 ×10000，绝不猜。
      const initYuan = toNum(pick(r, headers, '年初金额（元）'));
      const init = initYuan !== null ? initYuan : toNum(pick(r, headers, '年初金额'));
      const initWan = toNum(pick(r, headers, '年初金额（万元）'));
      if (init !== null) o.initial += init;
      else if (initWan !== null) o.initial += initWan * YUAN;

      const outYuan = toNum(pick(r, headers, '支出金额（元）'));
      const out = outYuan !== null ? outYuan : toNum(pick(r, headers, '支出金额'));
      const outWan = toNum(pick(r, headers, '支出金额（万元）'));
      if (out !== null) o.expense += Math.abs(out);
      else if (outWan !== null) o.expense += Math.abs(outWan) * YUAN;

      const balYuan = toNum(pick(r, headers, '当前结余（元）'));
      const balWan = toNum(pick(r, headers, '当前结余（万元）'));
      let bal = balYuan !== null ? balYuan : (balWan !== null ? balWan * YUAN : null);
      if (bal !== null && /收入|拨入|反拨/.test(type)) {
        o.income += bal;
        o.items.push({ stage: 'income', item: proj, value: bal });
      }
    });

    const out = [];
    [...map.entries()].forEach(([name, o]) => {
      // 保留 2 位小数（0.01 元）：与经费收支表「元」列的精度一致
      const r2 = v => Math.round(v * 100) / 100;
      // 期初行总是生成（哪怕为 0），方便后台直接改金额，不用先新增行
      out.push({ 工会名称: name, 收支类型: '期初', 经费项目: '上年结转', '金额（元）': round2(o.initial), 备注: '由经费收支表年初金额自动带入，请核对' });
      if (o.income) {
        const byItem = new Map();
        o.items.filter(i => i.stage === 'income').forEach(i => {
          byItem.set(i.item, (byItem.get(i.item) || 0) + i.value);
        });
        [...byItem.entries()].forEach(([item, v]) => {
          out.push({ 工会名称: name, 收支类型: '入账', 经费项目: item, '金额（元）': round2(v), 备注: '由经费收支表收入记录自动带入' });
        });
      }
      if (o.expense) out.push({ 工会名称: name, 收支类型: '支出', 经费项目: '经费支出', '金额（元）': round2(o.expense), 备注: '由经费收支表支出金额自动带入' });
    });
    return out;
  }

  /**
   * 单位迁移（v1.4）：把「05-经费瀑布」的金额列从「万元」换成「元」。
   * 幂等：表头已经是「金额（元）」且没有残留旧列名的行，就当没事发生。
   *
   * 换算不是简单的 ×10000：老列只存了 4 位小数的万元（＝1 元的精度），
   * 4.0891 万元 直接乘会变成 40891.00 元，而经费收支表里其实是 40891.19 元。
   * 所以先用经费收支表「元」列重算一遍，只有在老值与该重算值吻合（说明这行没被手工改过）
   * 时才采用精确值；对不上的一律按 ×10000 处理 —— 绝不用推导值覆盖用户手改的数字。
   *
   * ⚠️ 行有两种形态：服务器落地的是数组行（按 headers 顺序），
   * 但经过后台编辑保存的数据是**对象行**（key 就是列名）。以前只处理数组行，
   * 结果对象行一个都没换算，图表直接全变 0。这里两种都要认。
   */
  const OLD_AMOUNT_FIELD = '金额（万元）';
  const NEW_AMOUNT_FIELD = '金额（元）';

  function migrateWaterfallUnit(data) {
    const sheet = data && data['05-经费瀑布'];
    if (!sheet || !Array.isArray(sheet.headers) || !Array.isArray(sheet.rows)) return false;
    const H = sheet.headers;
    const headOld = H.indexOf(OLD_AMOUNT_FIELD);
    const headNew = H.indexOf(NEW_AMOUNT_FIELD);
    if (headOld < 0 && headNew < 0) return false;

    // 已经切成「元」的表头，但还有行停留在旧列名上（后台改列名 / 老数据混存）
    const hasStaleRows = sheet.rows.some(r => r && !Array.isArray(r) && r[OLD_AMOUNT_FIELD] !== undefined);
    if (headOld < 0 && !hasStaleRows) return false;

    const iName = H.indexOf('工会名称');
    const iStage = H.indexOf('收支类型');
    const iItem = H.indexOf('经费项目');
    const fieldOf = (r, name) => (Array.isArray(r) ? r[H.indexOf(name)] : r[name]);

    let exact = null;
    if (data['04-经费收支'] && iName >= 0 && iStage >= 0 && iItem >= 0) {
      try {
        exact = new Map();
        deriveWaterfallRows(data['04-经费收支'], '工会名称').forEach(o => {
          exact.set([o['工会名称'], o['收支类型'], o['经费项目']].join('\u0001'), Number(o['金额（元）']) || 0);
        });
      } catch (_) { exact = null; }
    }

    let converted = 0, exactRows = 0;
    const convert = (r, wan) => {
      if (exact) {
        const key = [fieldOf(r, '工会名称'), fieldOf(r, '收支类型'), fieldOf(r, '经费项目')]
          .map(x => String(x == null ? '' : x).trim()).join('\u0001');
        const ex = exact.get(key);
        // 把精确值折回 1 元精度的万元，和老值一致 ⇒ 这行没被手改
        if (ex !== undefined && Math.abs(Math.round(ex) / 10000 - wan) < 1e-6) {
          exactRows++;
          return ex;
        }
      }
      return Math.round(wan * YUAN * 100) / 100;
    };

    sheet.rows.forEach(r => {
      if (!r) return;
      if (Array.isArray(r)) {
        if (headOld < 0) return;
        const wan = Number(r[headOld]);
        if (!Number.isFinite(wan)) return;
        r[headOld] = convert(r, wan);
        converted++;
        return;
      }
      if (typeof r !== 'object') return;
      if (r[OLD_AMOUNT_FIELD] === undefined) return;      // 已经是元
      const wan = Number(r[OLD_AMOUNT_FIELD]);
      r[NEW_AMOUNT_FIELD] = Number.isFinite(wan) ? convert(r, wan) : 0;
      delete r[OLD_AMOUNT_FIELD];
      converted++;
    });

    if (headOld >= 0) H[headOld] = NEW_AMOUNT_FIELD;
    data._meta = Object.assign({}, data._meta || {}, { waterfallUnit: 'yuan' });
    console.log(`[migrate] 05-经费瀑布 金额单位 万元→元（换算 ${converted} 行，其中 ${exactRows} 行用经费表的元值精确还原）`);
    return true;
  }

  // ---------------------------------------------------------------------
  // 配置升级：把「默认模板里新增的东西」补进已有配置，不动用户改过的部分
  // ---------------------------------------------------------------------
  /**
   * 场景：线上配置是用户改过的，新版本给模板加了图表/指标/模块块，
   * 直接替换会丢用户设置，不补则新功能永远看不见。
   * 这里只做「加法」：id 不存在才追加。
   * 返回 { cfg, added } —— added 是人类可读的变更清单，便于写日志/提示。
   */
  function mergeAdditions(stored, seed) {
    const added = [];
    if (!seed || typeof seed !== 'object') return { cfg: stored, added };
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { cfg: clone(seed), added: ['（无有效配置，直接使用默认模板）'] };

    const cfg = clone(stored);
    const has = (arr, id) => (arr || []).some(x => x && x.id === id);

    // 标量分组：缺哪个键补哪个键（用户改过的键保持原值）
    ['text', 'theme', 'layout'].forEach(group => {
      if (!seed[group] || typeof seed[group] !== 'object') return;
      cfg[group] = cfg[group] && typeof cfg[group] === 'object' ? cfg[group] : {};
      Object.keys(seed[group]).forEach(k => {
        if (cfg[group][k] === undefined) {
          cfg[group][k] = clone(seed[group][k]);
          added.push(`${group}.${k}`);
        }
      });
    });

    // 列表：metrics / charts / tables
    ['metrics', 'charts', 'tables'].forEach(coll => {
      if (!Array.isArray(seed[coll])) return;
      if (!Array.isArray(cfg[coll])) cfg[coll] = [];
      seed[coll].forEach(item => {
        if (!item || !item.id) return;
        if (!has(cfg[coll], item.id)) {
          cfg[coll].push(clone(item));
          added.push(`${coll}: ${item.id}`);
        }
      });
    });

    // 模块 / 列 / 块：只补缺失的，不重排用户已有的
    if (Array.isArray(seed.modules)) {
      if (!Array.isArray(cfg.modules)) cfg.modules = [];
      seed.modules.forEach(sm => {
        if (!sm || !sm.id) return;
        let m = cfg.modules.find(x => x && x.id === sm.id);
        if (!m) {
          cfg.modules.push(clone(sm));
          added.push(`模块: ${sm.title || sm.id}`);
          return;
        }
        if (!Array.isArray(m.columns)) m.columns = [];
        (sm.columns || []).forEach(sc => {
          if (!sc || !sc.id) return;
          let c = m.columns.find(x => x && x.id === sc.id);
          if (!c) {
            m.columns.push(clone(sc));
            added.push(`模块「${sm.title || sm.id}」新增列 ${sc.id}`);
            return;
          }
          if (!Array.isArray(c.blocks)) c.blocks = [];
          (sc.blocks || []).forEach(sb => {
            if (!sb || !sb.id) return;
            if (!c.blocks.some(x => x && x.id === sb.id)) {
              c.blocks.push(clone(sb));
              added.push(`模块「${sm.title || sm.id}」新增内容块 ${sb.id}`);
            }
          });
        });
      });
    }

    return { cfg, added };
  }

  // ---------------------------------------------------------------------
  // 经费汇入（v1.7）：走访慰问 / 员工活动 的支出 → 经费收支
  // ---------------------------------------------------------------------

  const FUND_SHEET_KEY = '04-经费收支';
  const FUND_COL = {
    union: '工会名称',
    initial: '期初金额',
    income: '入账金额',
    expense: '支出金额',           // 手工登记的其它支出（银行流水等）
    visitIn: '慰问支出汇入（元）',   // 系统按账户汇入
    actIn: '活动支出汇入（元）',     // 系统按账户汇入
    total: '支出合计（元）',         // = 支出金额 + 两条汇入
    balanceYuan: '当前结余（元）',   // = 期初 + 入账 − 支出合计
    balanceWan: '当前结余（万元）',  // = 当前结余（元） ÷ 10000
  };

  /** 04 表里由系统算出来的列（后台只读，不允许手工编辑） */
  const FUND_DERIVED_COLS = [FUND_COL.visitIn, FUND_COL.actIn, FUND_COL.total, FUND_COL.balanceYuan, FUND_COL.balanceWan];

  /**
   * 汇入来源：哪张表的「费用列支账户」对应 04 的「工会名称」，取哪一列金额。
   * amount 列里的值一律按「元」处理（列名带「万元」时自动 ×10000）。
   */
  const FUND_ROLLUP_SOURCES = [
    { sheet: '02-走访慰问', account: '费用列支账户', amount: '慰问物品金额（元）', target: FUND_COL.visitIn, label: '走访慰问' },
    { sheet: '03-员工活动', account: '费用列支账户', amount: '支出金额（元）', target: FUND_COL.actIn, label: '员工活动' },
  ];

  const normText = v => String(v == null ? '' : v).trim();
  /** 这个格子算不算「填了东西」（区分 0 和空） */
  const filled = v => v !== null && v !== undefined && String(v).trim() !== '';
  /** 金额统一保留 2 位小数（0.01 元） */
  const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

  /** 取某行某字段的数值（元）；列名带万元自动 ×10000 */
  function amountInYuan(row, headers, field) {
    const n = toNum(pick(row, headers, field));
    if (n === null) return 0;
    return /万元/.test(String(field)) ? n * 10000 : n;
  }

  /** 去掉列名末尾的单位括号：「慰问物品金额（元）」→「慰问物品金额」 */
  const baseName = h => String(h == null ? '' : h).replace(/（[^）]*）\s*$/, '').trim();

  /**
   * 在表头里找一个列。
   *
   * 线上真实数据的列名和种子不完全一致（单位一会儿「元」一会儿「万元」，
   * 账户列也可能多几个字），写死列名一碰就静默变成 0 —— 这种错最难查。
   * 所以按 精确 → 去单位后缀 → 互相包含 三级兜底。
   */
  function resolveField(headers, wanted) {
    if (!Array.isArray(headers) || !wanted) return null;
    if (headers.indexOf(wanted) >= 0) return wanted;
    const wb = baseName(wanted);
    if (wb) {
      const exact = headers.find(h => baseName(h) === wb);
      if (exact) return exact;
      const loose = headers.filter(h => {
        const hb = baseName(h);
        return hb && (hb.indexOf(wb) >= 0 || wb.indexOf(hb) >= 0);
      });
      if (loose.length) return loose[0];
    }
    return null;
  }

  /**
   * 按「费用列支账户 = 工会名称」把业务表的支出汇入经费收支表，并重算结余。
   * 纯函数：返回新对象，不改入参。
   *
   *   慰问支出汇入（元） = Σ 02.慰问物品金额 WHERE 02.费用列支账户 = 本行工会名称
   *   活动支出汇入（元） = Σ 03.支出金额     WHERE 03.费用列支账户 = 本行工会名称
   *   支出合计（元）     = 支出金额（手工其它支出）+ 两条汇入
   *   当前结余（元）     = 期初金额 + 入账金额 − 支出合计（元）
   *   当前结余（万元）   = 当前结余（元） ÷ 10000
   *
   * 「当前结余（元）/（万元）」是**派生值**（等于 期初 + 入账 − 支出合计），后台只读。
   * ⚠️ 若表里原本手填的结余与公式结果对不上（历史脏数据），这里会以公式为准覆盖它，
   *    并在日志里记一条 warning —— 覆盖前有自动快照，可在「安全设置 → 备份」里找回。
   *    想手工调整某个工会的结余，改它的「期初金额」即可。
   */
  function rollupFundExpense(data, warnings) {
    if (!data || typeof data !== 'object') return data;
    const fund = data[FUND_SHEET_KEY];
    if (!fund || !Array.isArray(fund.headers) || !Array.isArray(fund.rows)) return data;

    const H = fund.headers;
    const iUnion = H.indexOf(FUND_COL.union);
    const iInitial = H.indexOf(FUND_COL.initial);
    const iIncome = H.indexOf(FUND_COL.income);
    const iExpense = H.indexOf(FUND_COL.expense);
    const iBalYuan = H.indexOf(FUND_COL.balanceYuan);
    const iBalWan = H.indexOf(FUND_COL.balanceWan);
    if (iUnion < 0) return data;

    // 每张来源表：账户名 → 金额合计（元）
    const maps = new Map();
    FUND_ROLLUP_SOURCES.forEach(s => {
      const src = data[s.sheet];
      const map = new Map();
      if (src && Array.isArray(src.headers) && Array.isArray(src.rows)) {
        const SH = src.headers;
        const accField = resolveField(SH, s.account);
        const amtField = resolveField(SH, s.amount);
        if (accField && amtField) {
          src.rows.forEach(r => {
            const acc = normText(pick(r, SH, accField));
          if (!acc) return;
            const v = amountInYuan(r, SH, amtField);
            map.set(acc, (map.get(acc) || 0) + Math.abs(v));
          });
        }
      }
      maps.set(s.target, map);
    });

    const out = clone(data);
    const warn = warnings || [];

    out[FUND_SHEET_KEY].rows = fund.rows.map((r, idx) => {
      const getName = () => normText(pick(r, H, FUND_COL.union));
      const name = getName();
      const visitIn = round2((maps.get(FUND_COL.visitIn) || new Map()).get(name) || 0);
      const actIn = round2((maps.get(FUND_COL.actIn) || new Map()).get(name) || 0);
      const manualExpense = Math.abs(toNum(pick(r, H, FUND_COL.expense)) || 0);
      const total = round2(manualExpense + visitIn + actIn);

      let initial = toNum(pick(r, H, FUND_COL.initial)) || 0;
      const income = toNum(pick(r, H, FUND_COL.income)) || 0;

      const setCell = (fname, val) => {
        if (Array.isArray(r)) {
          const i = H.indexOf(fname);
          if (i >= 0) r[i] = val; else return;
        } else if (r && typeof r === 'object') {
          r[fname] = val;
        }
      };

      setCell(FUND_COL.visitIn, visitIn);
      setCell(FUND_COL.actIn, actIn);
      setCell(FUND_COL.total, total);

      const old = toNum(pick(r, H, FUND_COL.balanceYuan));

      // 历史数据里「期初金额 / 入账金额」可能整行为空，而「当前结余（元）」是手工登记的。
      // 这种情况不能直接套公式——会把用户手填的结余算成 0（等于抹掉数据）。
      // 这里做一次「校准」：用结余反推期初金额，让等式重新成立。
      // 只跑一次（期初被填上后下次就走正常公式了），且写前有自动快照，可在备份里找回。
      const hasLedger = filled(pick(r, H, FUND_COL.initial)) || filled(pick(r, H, FUND_COL.income));
      if (!hasLedger && old !== null) {
        initial = round2(old + total);
        setCell(FUND_COL.initial, initial);
        warn.push(`经费收支「${name || '（空）'}」未登记期初/入账金额，已按当前结余 ${old} 元反推期初金额 ${initial} 元（可在备份中找回旧值）`);
      }

      const computed = round2(initial + income - total);
      if (old !== null && Math.abs(old - computed) > 0.011) {
        warn.push(`经费收支「${name || '（空）'}」原有结余 ${old} 元与公式结果 ${computed} 元不一致，已按公式更新（可在备份中找回旧值）`);
      }
      setCell(FUND_COL.balanceYuan, computed);
      setCell(FUND_COL.balanceWan, round2(computed / 10000));
      return r;
    });

    return out;
  }

  /**
   * 统计「有金额但对不上任何经费账户」的业务支出。
   * 用于后台提示：这些钱不会被汇入经费收支，需要补填正确的账户名。
   * 返回 [{ sheet, label, account, amount, count }]
   */
  function findUnmatchedExpense(data) {
    const out = [];
    if (!data || typeof data !== 'object') return out;
    const fund = data[FUND_SHEET_KEY];
    const FH = (fund && fund.headers) || [];
    const iUnion = FH.indexOf(FUND_COL.union);
    const known = new Set(
      iUnion >= 0
        ? (fund.rows || []).map(r => normText(pick(r, FH, FUND_COL.union))).filter(Boolean)
        : []
    );

    FUND_ROLLUP_SOURCES.forEach(s => {
      const src = data[s.sheet];
      if (!src || !Array.isArray(src.headers) || !Array.isArray(src.rows)) return;
      const SH = src.headers;
      const accField = resolveField(SH, s.account);
      const amtField = resolveField(SH, s.amount);
      if (!accField || !amtField) return;
      const buckets = new Map();
      src.rows.forEach(r => {
        const v = Math.abs(amountInYuan(r, SH, amtField));
        if (!v) return;
        const acc = normText(pick(r, SH, accField));
        if (acc && known.has(acc)) return;        // 能对上 → 正常汇入
        const key = acc || '（未填账户）';
        const b = buckets.get(key) || { sheet: s.sheet, label: s.label, account: key, amount: 0, count: 0 };
        b.amount = round2(b.amount + v);
        b.count += 1;
        buckets.set(key, b);
      });
      buckets.forEach(b => out.push(b));
    });

    return out;
  }

  /** 往 sheet 里补一列（数组行 splice / 对象行补 key，两种形态都处理） */
  function addMissingColumn(sheet, name, def, afterField) {
    if (!sheet || !Array.isArray(sheet.headers)) return false;
    if (sheet.headers.indexOf(name) >= 0) return false;
    const H = sheet.headers;
    let at = H.length;
    if (afterField) {
      const p = H.indexOf(afterField);
      if (p >= 0) at = p + 1;
    }
    if (at <= 0) at = 1;                    // 「序号」永远在第一位
    H.splice(at, 0, name);
    sheet.schema = Object.assign({}, sheet.schema || {}, { [name]: def || { type: 'number', decimals: 2 } });
    (sheet.rows || []).forEach(r => {
      if (Array.isArray(r)) {
        while (r.length < at) r.push('');
        r.splice(at, 0, '');
      } else if (r && typeof r === 'object' && r[name] === undefined) {
        r[name] = '';
      }
    });
    return true;
  }

  /**
   * 确保 04 表有汇入相关的列（幂等；只补不删）。
   * 放在这里而不是 server.js，是为了让离线模式（localStorage）也有同样的列。
   */
  function ensureFundColumns(data) {
    if (!data || typeof data !== 'object') return data;
    const fund = data[FUND_SHEET_KEY];
    if (!fund || !Array.isArray(fund.headers)) return data;
    const derived = { type: 'number', decimals: 2, derived: true, readonly: true };
    addMissingColumn(fund, FUND_COL.visitIn, derived, FUND_COL.expense);
    addMissingColumn(fund, FUND_COL.actIn, derived, FUND_COL.visitIn);
    addMissingColumn(fund, FUND_COL.total, derived, FUND_COL.actIn);
    return data;
  }

  /** 列名常量：端口提报人（后台只读） */
  const REPORTER_FIELD = '提报人';

  /** 确保三张业务表都有「提报人」列（幂等；端口写入前调用） */
  function ensureReporterColumns(data) {
    if (!data || typeof data !== 'object') return data;
    ['01-组织建设', '02-走访慰问', '03-员工活动'].forEach(key => {
      const sh = data[key];
      if (!sh || !Array.isArray(sh.headers)) return;
      addMissingColumn(sh, REPORTER_FIELD, { type: 'text', readonly: true }, null);
    });
    return data;
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
    groupRows, groupTable, crossTable, listTable, buildTable,
    monthKey, groupKey,
    fmtNum,
    OPS, OP_LABEL, AGG_LABEL,
    // 瀑布（桥梁）图
    DEFAULT_STAGES, stageOf, waterfallRows, deriveWaterfallRows,
    resolveValueField, migrateWaterfallUnit,
    // 配置升级（把模板新增项补进已有配置）
    mergeAdditions,
    // 经费汇入（v1.7）
    FUND_SHEET_KEY, FUND_COL, FUND_DERIVED_COLS, FUND_ROLLUP_SOURCES,
    rollupFundExpense, findUnmatchedExpense, addMissingColumn, ensureFundColumns,
    REPORTER_FIELD, ensureReporterColumns,
  };
})(typeof window !== 'undefined' ? window : globalThis);
