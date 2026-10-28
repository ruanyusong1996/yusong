/* ===== Excel 导入 / 导出（服务端专用纯函数模块） =====
 *
 * 为什么不用 npm 的 xlsx 包：本项目部署在 Railway（Nixpacks），
 * 多一个依赖就多一个构建失败点；而且本机沙箱里 npm install 跑不通，装不上就没法测。
 * 所以把 SheetJS CE 的单文件版直接放进了 lib/xlsx.full.min.js（跟 lib/echarts.min.js 一个待遇），
 * require 进来即可用，package.json 不用动。
 *
 * 设计原则：
 *   1. 所有函数都是纯的（除了读自己的常量），方便在 Node 里直接单测；
 *   2. 列匹配按表头名字走，不按位置 —— 用户把列拖动、删掉几列、加一列备注都不该出错；
 *   3. 系统列（序号 / 提报人 / 5 个汇入列）绝不从文件写库：
 *        序号 → 落库前统一重排
 *        提报人 → 保留文件里的值（这样「导出 → 改 → 导回」不会把提报人抹掉）
 *        汇入列 → 丢弃，由配置引擎按公式重算
 *   4. 校验口径与「收集端口提交」完全一致（必填 / 数字 / 小数位 / 下拉选项），
 *      绝不因为是从 Excel 进来的就放宽。
 */
'use strict';

const path = require('path');
const XLSX = require(path.join(__dirname, 'lib', 'xlsx.full.min.js'));

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 系统列：这些列号/计算值不接受外部输入 */
const AUTO_FIELDS = ['序号'];
const DERIVED_HINT = '系统自动计算，留空即可（填了也会被忽略）';
const AUTO_HINT = '系统自动编号，留空即可（填了也会被忽略）';
const REPORTER_FIELD = '提报人';

/* ------------------------------------------------------------------ 基础工具 */

/** 表头归一化：去掉全部空白、全角括号转半角、去 BOM 与首尾符号 —— 只用于「比对」，不改真实表头 */
function normHeader(s) {
  return String(s == null ? '' : s)
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[：:]+$/, '')
    .trim();
}

/** Excel 工作表名：不能超过 31 字符，不能含 []:*?/\ */
function sheetNameOf(key) {
  const s = String(key == null ? '' : key).replace(/[[\]*?/\\:]/g, '-').trim();
  return (s || 'Sheet1').slice(0, 31);
}

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** 取一行（数组行 / 对象行两种形态）里某列的值 */
function pick(row, headers, name) {
  if (row == null) return '';
  if (Array.isArray(row)) {
    const i = headers.indexOf(name);
    return i >= 0 && i < row.length ? row[i] : '';
  }
  return Object.prototype.hasOwnProperty.call(row, name) ? row[name] : '';
}

/** 数组行 → 对象行（写回磁盘前统一形态，避免一格里混两种） */
function toObjectRow(row, headers) {
  if (!Array.isArray(row)) return Object.assign({}, row || {});
  const o = {};
  headers.forEach((h, i) => { o[h] = i < row.length ? row[i] : ''; });
  return o;
}

/** 表头宽度（中文按 2 个字宽估算） */
function colWidth(h) {
  const s = String(h == null ? '' : h);
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return Math.max(8, Math.min(34, w + 4));
}

/** 单元格导出值：数字形态的列尽量存成真正的数字，方便用户在 Excel 里直接求和 */
function cellOf(v, def) {
  if (v === null || v === undefined) return '';
  const type = (def && def.type) || '';
  if (type === 'number') {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(String(v).replace(/[,，\s]/g, ''));
    if (String(v).trim() !== '' && Number.isFinite(n)) return n;
    return isBlank(v) ? '' : String(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/* ------------------------------------------------------------------ 导出 */

/**
 * 把若干张表合成一个工作簿
 * @param {Array<{key:string, headers:string[], rows:any[], schema?:object}>} sheets
 * @returns {Buffer}
 */
function buildWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  (sheets || []).forEach(({ key, headers, rows, schema }) => {
    const H = (headers || []).slice();
    const S = schema || {};
    const aoa = [H.slice()];
    (rows || []).forEach(r => aoa.push(H.map(h => cellOf(pick(r, H, h), S[h]))));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = H.map(h => ({ wch: colWidth(h) }));
    XLSX.utils.book_append_sheet(wb, ws, sheetNameOf(key));
  });
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

/**
 * 单表模板：表头行 + 一张「填写说明」工作表
 * 模板里**不放示例数据**，避免用户误把示例当真实数据导进来。
 */
function buildTemplate({ key, headers, schema }) {
  const H = (headers || []).slice();
  const S = schema || {};
  const wb = XLSX.utils.book_new();

  const ws = XLSX.utils.aoa_to_sheet([H.slice()]);
  ws['!cols'] = H.map(h => ({ wch: colWidth(h) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetNameOf(key));

  const TYPE_LABEL = {
    text: '文本', textarea: '多行长文本', number: '数字', select: '下拉选择', date: '日期',
  };
  const rows = [
    [`表格：${key}`],
    ['填写要求：第 1 行是表头，列名不要改；从第 2 行开始填写，一行一条记录；空行会被自动跳过。'],
    ['下拉选择列请严格使用「可选项」里的写法，否则整张表不会导入（会逐行报错提示）。'],
    [''],
    ['列名', '是否必填', '类型', '可选项', '填写说明'],
  ];
  H.forEach(h => {
    const def = S[h] || {};
    let note = '';
    if (AUTO_FIELDS.indexOf(h) >= 0) note = AUTO_HINT;
    else if (def.derived) note = DERIVED_HINT;
    else if (def.readonly) note = '系统写入（端口提报时自动盖章），导入时按文件里的值保留';
    else if (def.type === 'number' && typeof def.decimals === 'number') note = `最多 ${def.decimals} 位小数`;
    else if (def.type === 'number' && typeof def.min === 'number') note = `不能小于 ${def.min}`;
    rows.push([
      h,
      def.required ? '必填' : '选填',
      TYPE_LABEL[def.type] || '文本',
      Array.isArray(def.options) ? def.options.join(' / ') : '',
      note,
    ]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(rows);
  ws2['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 56 }, { wch: 42 }];
  XLSX.utils.book_append_sheet(wb, ws2, '填写说明');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

/* ------------------------------------------------------------------ 导入 */

/** Date → YYYY-MM-DD（用 UTC 分量，避免时区把日期推到前一天） */
function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 把单元格原始值按列定义转成要落库的字符串/数字，返回 { value, error } */
function coerceCell(def, raw, colName) {
  const out = (value, error) => ({ value, error: error || null });
  if (isBlank(raw)) {
    if (def.required) return out('', `「${colName}」不能为空`);
    return out('');
  }

  if (def.type === 'number') {
    let n;
    if (typeof raw === 'number') n = raw;
    else if (raw instanceof Date) n = Number.NaN;
    else n = Number(String(raw).replace(/[,，\s]/g, '').replace(/[¥￥]|元$/, ''));
    if (!Number.isFinite(n)) return out('', `「${colName}」不是数字（填的是 ${String(raw).slice(0, 20)}）`);
    if (typeof def.min === 'number' && n < def.min) return out(n, `「${colName}」不能小于 ${def.min}`);
    const dec = (typeof def.decimals === 'number' && def.decimals >= 0) ? def.decimals : 2;
    const frac = String(Math.abs(n)).split('.')[1] || '';
    if (frac.length > dec) return out(n, `「${colName}」最多 ${dec} 位小数（填的是 ${n}）`);
    // 用「四舍五入到 dec 位」再转回数字，去掉浮点尾巴
    return out(Number(n.toFixed(dec)));
  }

  if (def.type === 'date') {
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return out(fmtDate(raw));
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // 没吃到 cellDates 的 Excel 日期序列号 → 按 1900 基准还原
      const d = XLSX.SSF.parse_date_code(raw);
      if (d) return out(`${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`);
    }
    return out(String(raw).trim());
  }

  // 文本 / 下拉
  const s = (raw instanceof Date ? fmtDate(raw) : String(raw)).trim();
  if (def.type === 'select' && Array.isArray(def.options) && def.options.length) {
    if (def.options.indexOf(s) < 0) {
      return out(s, `「${colName}」只能取：${def.options.join(' / ')}（填的是 ${s}）`);
    }
  }
  return out(s);
}

/**
 * 解析上传的文件（.xlsx / .xls / .csv 都吃）
 * @returns {{sheetNames:string[], sheetName:string, headerRowNo:number, aoa:any[][]}}
 */
function readAoa(buf, key) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true, cellNF: false, cellText: false });
  } catch (e) {
    const err = new Error('无法读取这个文件：' + (e && e.message ? e.message : '格式不支持') + '（请用 .xlsx，或另存为 .csv 后重试）');
    err.code = 'BAD_FILE';
    throw err;
  }
  const names = (wb.SheetNames || []).slice();
  if (!names.length) {
    const err = new Error('文件里没有任何工作表');
    err.code = 'BAD_FILE';
    throw err;
  }
  const want = normHeader(key);
  // 优先按表名找（导出文件就是这么命名的），其次跳过「填写说明」取第一张
  let name = names.find(n => normHeader(n) === want);
  if (!name) name = names.find(n => !/说明|help|readme/i.test(n));
  if (!name) name = names[0];
  const ws = wb.Sheets[name];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  return { sheetNames: names, sheetName: name, aoa };
}

/**
 * 把二维表解析成「对象行 + 错误清单」
 *
 * @param {Buffer} buf       文件内容
 * @param {object} opts      { key, headers, schema }
 * @returns {{
 *   rows: object[], errors: string[], warnings: string[],
 *   unknownColumns: string[], missingColumns: string[],
 *   sheetName: string, headerRowNo: number, dataRows: number, skippedEmpty: number,
 *   columns: {header:string, from:string}[],
 * }}
 */
function parseSheet(buf, opts) {
  const key = opts.key;
  const headers = (opts.headers || []).slice();
  const schema = opts.schema || {};
  const { sheetName, aoa } = readAoa(buf, key);

  const known = new Map();
  headers.forEach(h => known.set(normHeader(h), h));

  // ---- 1. 找表头行：在前 8 行里挑「命中已知列最多」的一行
  let headerIdx = -1, bestHit = 0;
  for (let i = 0; i < Math.min(aoa.length, 8); i++) {
    const row = aoa[i] || [];
    let hit = 0;
    row.forEach(c => { if (c != null && known.has(normHeader(c))) hit += 1; });
    if (hit > bestHit) { bestHit = hit; headerIdx = i; }
  }
  if (headerIdx < 0 || bestHit < 2) {
    const err = new Error(`没能在「${sheetName}」里认出表头：请确认第 1 行是列名（可先下载模板照着填）`);
    err.code = 'NO_HEADER';
    throw err;
  }

  // ---- 2. 列映射 + 未知列
  const colOf = new Map();     // 表头名 → 列下标
  const unknownColumns = [];
  const dupColumns = [];
  (aoa[headerIdx] || []).forEach((cell, idx) => {
    if (isBlank(cell)) return;
    const real = known.get(normHeader(cell));
    if (!real) { unknownColumns.push(String(cell).trim()); return; }
    if (colOf.has(real)) { dupColumns.push(real); return; }
    colOf.set(real, idx);
  });

  const errors = [];
  const warnings = [];

  if (dupColumns.length) errors.push(`文件里有重复的列：${dupColumns.join('、')}（请只保留一列）`);

  // ---- 3. 缺列检查：必填列 + 系统列可以缺（序号/汇入列缺了照样能导）
  const missingColumns = [];
  headers.forEach(h => {
    const def = schema[h] || {};
    if (AUTO_FIELDS.indexOf(h) >= 0 || def.derived || def.readonly) return;
    if (!colOf.has(h)) {
      missingColumns.push(h);
      if (def.required) errors.push(`缺少必填列「${h}」`);
    }
  });
  if (unknownColumns.length) {
    warnings.push(`文件里有 ${unknownColumns.length} 个不认识的列，已忽略：${unknownColumns.slice(0, 8).join('、')}${unknownColumns.length > 8 ? ' …' : ''}`);
  }

  // ---- 4. 逐行转换
  const rows = [];
  let skippedEmpty = 0;
  let dataRows = 0;
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const src = aoa[i] || [];
    const rowNo = i + 1;                       // Excel 里的真实行号，报错要按它来
    const notEmpty = src.some(v => !isBlank(v));
    if (!notEmpty) { skippedEmpty += 1; continue; }
    dataRows += 1;

    const rec = {};
    let rowHadError = false;
    headers.forEach(h => {
      const def = schema[h] || {};
      if (AUTO_FIELDS.indexOf(h) >= 0) { rec[h] = ''; return; }      // 序号统一重排
      if (def.derived) { rec[h] = ''; return; }                      // 汇入列交给引擎重算
      const idx = colOf.get(h);
      if (idx === undefined) { rec[h] = ''; return; }                // 文件里没这列
      const { value, error } = coerceCell(def, src[idx], h);
      if (error) { errors.push(`第 ${rowNo} 行${error}`); rowHadError = true; }
      rec[h] = value;
    });
    // 提报人：后台导入按文件里的值保留（导出→改→导回 不会丢归属），没填就留空
    if (colOf.has(REPORTER_FIELD) && !rowHadError) {
      const raw = src[colOf.get(REPORTER_FIELD)];
      rec[REPORTER_FIELD] = isBlank(raw) ? '' : String(raw).trim();
    }
    rows.push(rec);
  }

  return {
    rows, errors, warnings, unknownColumns, missingColumns,
    sheetName, headerRowNo: headerIdx + 1, dataRows, skippedEmpty,
    columns: headers.filter(h => colOf.has(h)).map(h => ({ header: h })),
  };
}

/* ------------------------------------------------------------------ 导出文件命名 */

function filenameOf(key, suffix) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  const base = String(key || '全部数据').replace(/[[\]*?/\\:]/g, '-');
  return `${base}_${suffix || '导出'}_${stamp}.xlsx`;
}

module.exports = {
  MIME_XLSX,
  AUTO_FIELDS,
  REPORTER_FIELD,
  normHeader,
  sheetNameOf,
  pick,
  toObjectRow,
  coerceCell,
  fmtDate,
  buildWorkbook,
  buildTemplate,
  parseSheet,
  readAoa,
  filenameOf,
};
