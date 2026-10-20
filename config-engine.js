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
      out.push({ 工会名称: name, 收支类型: '期初', 经费项目: '上年结转', '金额（元）': r2(o.initial), 备注: '由经费收支表年初金额自动带入，请核对' });
      if (o.income) {
        const byItem = new Map();
        o.items.filter(i => i.stage === 'income').forEach(i => {
          byItem.set(i.item, (byItem.get(i.item) || 0) + i.value);
        });
        [...byItem.entries()].forEach(([item, v]) => {
          out.push({ 工会名称: name, 收支类型: '入账', 经费项目: item, '金额（元）': r2(v), 备注: '由经费收支表收入记录自动带入' });
        });
      }
      if (o.expense) out.push({ 工会名称: name, 收支类型: '支出', 经费项目: '经费支出', '金额（元）': r2(o.expense), 备注: '由经费收支表支出金额自动带入' });
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
    // 瀑布（桥梁）图
    DEFAULT_STAGES, stageOf, waterfallRows, deriveWaterfallRows,
    resolveValueField, migrateWaterfallUnit,
    // 配置升级（把模板新增项补进已有配置）
    mergeAdditions,
  };
})(typeof window !== 'undefined' ? window : globalThis);
