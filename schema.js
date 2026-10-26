/* ===== 字段定义 BUILTIN_SCHEMA =====
 * 前后端共用：浏览器挂到 window.BUILTIN_SCHEMA，Node 里走 module.exports。
 *
 * 抽出来的原因：服务端也要按 schema 校验「收集端口」提报上来的数据，
 * 以前这份定义只存在于 data-store.js（纯浏览器文件），服务端根本读不到，
 * 结果端口提交时 required / number / select 校验形同虚设。
 * 注意：服务端只读不写 schema —— 把 schema 写进数据文件会冲掉前端的自定义控件。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BUILTIN_SCHEMA = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  // 默认字段定义（兼容老数据：首次加载时若 DATA 没 schema，就用这套补齐）
    return {
    '01-组织建设': {
      '工会名称': { type: 'text', required: true, full: true },
      '依托公司': { type: 'text', required: true, full: true },
      '工会主席': { type: 'text' },
      '职工人数': { type: 'number', min: 0 },
      '组建状态': { type: 'select', options: ['已组建', '筹建中'], required: true },
      '工会级别': { type: 'select', options: ['一级工会', '二级工会', '三级工会'], required: true },
      // —— 筹建进度（v1.6）：只有「筹建中」的工会才填；想加阶段列可在后台「列管理」自行增加 ——
      '当前进度': { type: 'select', options: ['未启动', '方案制定', '会员登记', '报批审批', '选举筹备', '已成立'] },
      '进度日期': { type: 'date' },
      '工作负责人': { type: 'text' },
      // 由收集端口提报时自动写入（后台可见、不可改）
      '提报人': { type: 'text', readonly: true },
      '备注': { type: 'textarea', full: true },
    },
    '02-走访慰问': {
      '慰问类型': { type: 'select', options: ['员工直系亲属重大疾病', '员工本人重大疾病', '其他'], required: true },
      '员工姓名': { type: 'text', required: true },
      '所在大区': { type: 'text', required: true },
      '员工所在部门/门店': { type: 'text', required: true },
      '慰问日期': { type: 'date' },
      '慰问物品金额（元）': { type: 'number', min: 0 },
      // 与经费收支表「工会名称」对应，用于把本行金额汇入该工会的支出
      '费用列支账户': { type: 'text' },
      '具体事由': { type: 'textarea', full: true },
      '经办人': { type: 'text' },
      '提报人': { type: 'text', readonly: true },
      '备注': { type: 'textarea', full: true },
    },
    '03-员工活动': {
      '活动日期': { type: 'date', required: true },
      '活动内容': { type: 'text', required: true, full: true },
      '活动形式': { type: 'select', options: ['线下活动', '线上活动'], required: true },
      '活动类型': { type: 'select', options: ['社团活动', '节日主题活动', '属地关爱', '文体活动', '培训讲座', '公益活动', '技能竞赛'], required: true },
      '活动区域': { type: 'text' },
      '组织部门': { type: 'text' },
      // 工会干事：与「02-走访慰问」同名，便于看板出「干事 × 月份」矩阵
      '经办人': { type: 'text' },
      '覆盖人数': { type: 'number', min: 0 },
      '支出金额（元）': { type: 'number', min: 0 },
      // 与经费收支表「工会名称」对应，用于把本行金额汇入该工会的支出
      '费用列支账户': { type: 'text' },
      '提报人': { type: 'text', readonly: true },
      '备注': { type: 'textarea', full: true },
    },
    '04-经费收支': {
      '工会名称': { type: 'text', required: true },
      '工会全称': { type: 'text', full: true },
      '收支类型': { type: 'select', options: ['收入', '支出'], required: true },
      '经费项目': { type: 'select', options: ['上级工会反拨', '会员会费', '其他收入', '活动支出', '慰问支出', '培训支出', '其他支出'], required: true },
      '年初金额': { type: 'number', min: 0 },
      '期初金额': { type: 'number', min: 0 },
      '入账金额': { type: 'number', min: 0 },
      // ↓ 手工登记的「其它支出」（银行流水等），不含走访慰问/员工活动的支出
      '支出金额': { type: 'number', min: 0 },
      // ↓ 以下 5 列由系统按「费用列支账户 = 工会名称」自动汇入并重算，后台只读
      '慰问支出汇入（元）': { type: 'number', decimals: 2, derived: true, readonly: true },
      '活动支出汇入（元）': { type: 'number', decimals: 2, derived: true, readonly: true },
      '支出合计（元）': { type: 'number', decimals: 2, derived: true, readonly: true },
      '当前结余（元）': { type: 'number', decimals: 2, derived: true, readonly: true },
      '当前结余（万元）': { type: 'number', decimals: 2, derived: true, readonly: true },
      '事由摘要': { type: 'textarea', full: true },
      '经办人': { type: 'text' },
      '备注': { type: 'textarea', full: true },
    },
    // 瀑布（桥梁）图的专用长表：一行 = 某个工会的一个科目
    // 收支类型决定这一行进「期初 / 入账 / 支出 / 结余」哪一段；
    // 结余默认自动算（期初+入账-支出），只有填了「结余」类型的行才按手工值走。
    '05-经费瀑布': {
      '工会名称': { type: 'text', required: true },
      '工会全称': { type: 'text', full: true },
      '收支类型': { type: 'select', options: ['期初', '入账', '支出', '结余'], required: true },
      '经费项目': {
        type: 'select',
        options: ['上年结转', '上级工会反拨', '会员会费', '其他收入', '活动支出', '慰问支出', '培训支出', '其他支出'],
        required: true,
      },
      '金额（元）': { type: 'number', decimals: 3 },
      '备注': { type: 'textarea', full: true },
    },
  };
});
