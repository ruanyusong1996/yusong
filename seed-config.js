/* ===== 看板配置（默认模板）=====
 * 这份配置就是"看板长什么样"的唯一来源：
 *   文字/标题 · 主题配色 · 模块与布局 · 指标卡片(数据链接+计算公式) · 图表 · 统计表
 * 后台「看板配置」页签里改的就是它；改完看板实时刷新。
 * 离线（双击 file:// 打开）时以此为初始值，存 localStorage。
 */
window.SEED_CONFIG = {
  // 模板版本：服务端启动时用它判断「要不要把新增的图表/模块块补进线上已有配置」。
  // 加了新功能就 +1，用户自己删掉的东西不会被反复加回来。
  version: 3,

  /* ---------- 文字 ---------- */
  text: {
    documentTitle: '海底捞集团工会工作数据看板',
    pageTitle: '海底捞集团工会工作数据看板',
    titleDeco: true,                       // 标题两侧的 ━━━ 装饰
    subtitleItems: [
      { type: 'text', text: '数据截止 2026 年 10 月 13 日' },
      { type: 'text', text: '数据来源：公司工会基础信息收集表' },
      { type: 'hint', text: '点击带下划线数字可跳转明细' },
      { type: 'adminLink', text: '后台管理 »' },
      { type: 'syncBadge' },
      { type: 'logout', text: '退出' },
    ],
    footer: '© 海底捞集团工会 · 数据看板 · 设计参考 Excel「数据看板」sheet1 科技蓝主题',
    detailButtonText: '查看明细 »',
  },

  /* ---------- 主题 ---------- */
  theme: {
    accent: '#4DD8FF',
    accent2: '#5FE0FF',
    bg: '#081025',
    cardBg: '#14224A',
    cardBg2: '#0E1A35',
    cardBorder: 'rgba(77,216,255,0.18)',
    subCardBg: 'rgba(20,34,74,0.55)',
    titleBar: '#1E3A70',
    text: '#E6EEFF',
    muted: '#7E93BD',
    danger: '#EF4444',
    palette: ['#4DD8FF', '#5FE0FF', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
  },

  /* ---------- 布局 ---------- */
  layout: {
    maxWidth: 1560,        // 页面最大宽度 px
    moduleGap: 18,         // 模块之间间距 px
    columnGap: 16,         // 同一模块内列间距 px
    cardRadius: 4,         // 卡片圆角 px
  },

  /* ---------- 指标卡片 ----------
   * 数据链接：sheet(哪张表) + agg(count/sum/avg/max/min/distinct) + field(统计哪个字段) + where(筛选条件)
   * 计算公式：expr 里用 {指标id} 引用其它指标，支持 + - * / ( ) 与数字，例如 "{org-established}/{org-total}*100"
   * 单位/小数位/缩放：unit、decimals、scale（结果乘数，如 元→万元 填 0.0001）
   */
  metrics: [
    {
      id: 'org-total', label: '基层工会总数', unit: '个', decimals: 0, visible: true,
      sheet: '01-组织建设', agg: 'count', where: [],
      detail: { sheet: '01-组织建设' },
    },
    {
      id: 'org-established', label: '已组建', unit: '个', decimals: 0, visible: true,
      sheet: '01-组织建设', agg: 'count', where: [{ field: '组建状态', op: '==', value: '已组建' }],
      detail: { sheet: '01-组织建设', filterField: '组建状态', filterValue: '已组建' },
    },
    {
      id: 'org-preparing', label: '筹建中', unit: '个', decimals: 0, visible: true,
      sheet: '01-组织建设', agg: 'count', where: [{ field: '组建状态', op: '==', value: '筹建中' }],
      detail: { sheet: '01-组织建设', filterField: '组建状态', filterValue: '筹建中' },
    },
    {
      id: 'visit-total', label: '走访慰问人次', unit: '人次', decimals: 0, visible: true,
      sheet: '02-走访慰问', agg: 'count', where: [],
      detail: { sheet: '02-走访慰问' },
    },
    {
      id: 'visit-amount', label: '慰问品总金额', unit: '元', decimals: 0, visible: true,
      sheet: '02-走访慰问', agg: 'sum', field: '慰问物品金额（元）', where: [],
      detail: { sheet: '02-走访慰问' },
    },
    {
      id: 'act-total', label: '活动总数量', unit: '场', decimals: 0, visible: true,
      sheet: '03-员工活动', agg: 'count', where: [],
      detail: { sheet: '03-员工活动' },
    },
    {
      id: 'act-coverage', label: '覆盖总人次', unit: '人次', decimals: 0, visible: true,
      sheet: '03-员工活动', agg: 'sum', field: '覆盖人数', where: [],
      detail: { sheet: '03-员工活动' },
    },
    {
      id: 'act-spend', label: '活动支出总额', unit: '元', decimals: 0, visible: true,
      sheet: '03-员工活动', agg: 'sum', field: '支出金额（元）', where: [],
      detail: { sheet: '03-员工活动' },
    },
    {
      id: 'fund-initial', label: '年初金额合计', unit: '万元', decimals: 2, visible: true,
      sheet: '04-经费收支', agg: 'sum', field: '年初金额', scale: 0.0001, where: [],
      detail: { sheet: '04-经费收支' },
    },
    {
      id: 'fund-spend', label: '支出金额合计', unit: '万元', decimals: 2, visible: true,
      sheet: '04-经费收支', agg: 'sum', field: '支出金额', scale: 0.0001, where: [],
      detail: { sheet: '04-经费收支' },
    },
    {
      id: 'fund-balance', label: '当前结余', unit: '万元', decimals: 2, visible: true,
      sheet: '04-经费收支', agg: 'sum', field: '当前结余（万元）',
      fallbackField: '当前结余（元）', fallbackScale: 0.0001, where: [],
      detail: { sheet: '04-经费收支' },
    },

    /* --- 公式型指标示例（可在后台自由改公式或删除）--- */
    {
      id: 'org-rate', label: '组建完成率', unit: '%', decimals: 1, visible: true,
      expr: '{org-established} / {org-total} * 100', where: [],
      detail: { sheet: '01-组织建设' },
    },
    {
      id: 'fund-per-org', label: '平均每会结余', unit: '万元', decimals: 2, visible: true,
      expr: '{fund-balance} / {org-total}', where: [],
      detail: { sheet: '04-经费收支' },
    },
  ],

  /* ---------- 图表 ---------- */
  charts: [
    {
      id: 'chart-org-pie', visible: true, title: '',
      type: 'doughnut', sheet: '01-组织建设', groupBy: '组建状态', agg: 'count', where: [],
      colors: ['#4DD8FF', '#F59E0B', '#8B5CF6', '#10B981'],
      legend: { show: true, position: 'bottom' },
      label: { show: true, formatter: '{b}: {c} ({d}%)' },
      axis: { rotate: 0, yName: '' },
      height: 230, centerLabel: true,
      detail: { sheet: '01-组织建设', groupField: '组建状态' },
    },
    {
      id: 'chart-visit-type', visible: true, title: '',
      type: 'bar', sheet: '02-走访慰问', groupBy: '慰问类型', agg: 'count', where: [],
      colors: [],
      legend: { show: false, position: 'bottom' },
      label: { show: true, formatter: '{c}' },
      axis: { rotate: 0, yName: '' },
      height: 260, barWidth: 50, wrapLabels: true,
      detail: { sheet: '02-走访慰问', groupField: '慰问类型' },
    },
    {
      id: 'chart-act-type', visible: true, title: '',
      type: 'doughnut', sheet: '03-员工活动', groupBy: '活动类型', agg: 'count', where: [],
      colors: [],
      legend: { show: true, position: 'bottom' },
      label: { show: true, formatter: '{b}: {c}' },
      axis: { rotate: 0, yName: '' },
      height: 280, centerLabel: true,
      detail: { sheet: '03-员工活动', groupField: '活动类型' },
    },
    {
      id: 'chart-fund-bar', visible: true, title: '',
      type: 'bar', sheet: '04-经费收支', groupBy: '工会名称', agg: 'sum', field: '当前结余（万元）', where: [],
      colors: [],
      legend: { show: false, position: 'bottom' },
      label: { show: true, formatter: '{c}' },
      axis: { rotate: 20, yName: '万元' },
      height: 300, barWidth: 36, wrapLabels: false, decimals: 2,
      detail: { sheet: '04-经费收支', groupField: '工会名称' },
    },
    /* --- 瀑布（桥梁）图：每个工会一行，期初 → 入账 → 支出 → 结余 --- *
     * 数据表是「长表」：一行 = 某工会的一个科目（05-经费瀑布）
     *   工会名称 | 收支类型(期初/入账/支出/结余) | 经费项目 | 金额（元）
     * 结余默认 = 期初 + 入账 − 支出；表里若填了「结余」类型的行，则按手工值显示。
     */
    {
      id: 'chart-fund-bridge', visible: true, title: '',
      type: 'waterfall', sheet: '05-经费瀑布', groupBy: '工会名称',
      stageField: '收支类型', itemField: '经费项目', field: '金额（元）', agg: 'sum',
      colors: [],
      legend: { show: true, position: 'bottom' },
      label: { show: true, formatter: '{c}' },
      axis: { rotate: 0, yName: '元' },
      height: 420, barWidth: 10, decimals: 3, sortBy: 'valueDesc',
      detail: { sheet: '05-经费瀑布', groupField: '工会名称' },
    },
  ],

  /* ---------- 统计表 ---------- */
  tables: [
    {
      id: 'tbl-org-level', visible: true, title: '工会级别 × 组建状态统计（单位：个）',
      type: 'cross', sheet: '01-组织建设',
      rowField: '工会级别', colField: '组建状态',
      crossColumns: [
        { key: '已组建', label: '已组建' },
        { key: '筹建中', label: '筹建中' },
      ],
      showTotalColumn: true, showTotalRow: true, totalLabel: '合计', sortBy: 'key',
      detail: { sheet: '01-组织建设', filterField: '工会级别' },
    },
    {
      id: 'tbl-visit-areas', visible: true, title: '各大区（区域负责人）走访人数',
      type: 'group', sheet: '02-走访慰问', groupBy: '所在大区',
      columns: [
        { label: '走访人次', agg: 'count' },
        { label: '慰问品金额（元）', agg: 'sum', field: '慰问物品金额（元）', decimals: 0 },
      ],
      sortBy: 'valueDesc', limit: 0,
      detail: { sheet: '02-走访慰问', filterField: '所在大区' },
    },
    {
      id: 'tbl-act-forms', visible: true, title: '按活动形式统计',
      type: 'group', sheet: '03-员工活动', groupBy: '活动形式',
      columns: [{ label: '场次', agg: 'count' }],
      sortBy: 'valueDesc', limit: 0,
      detail: { sheet: '03-员工活动', filterField: '活动形式' },
    },
  ],

  /* ---------- 模块与布局 ----------
   * 一个模块 = 若干「列」，每列占 12 栅格中的 width 份；
   * 每列内可纵向堆叠若干「块」：metrics(指标组) / chart(图表) / table(统计表) / note(文字块)
   */
  modules: [
    {
      id: 'm-org', visible: true, title: '一、组织建设情况', sheet: '01-组织建设', showDetail: true,
      columns: [
        {
          id: 'c-org-1', width: 5,
          blocks: [
            { id: 'b-org-metrics', type: 'metrics', visible: true, title: '工会数量 × 组建状态统计（单位：个）', metricIds: ['org-total', 'org-established', 'org-preparing'] },
            { id: 'b-org-pie', type: 'chart', visible: true, title: '', refId: 'chart-org-pie' },
          ],
        },
        {
          id: 'c-org-2', width: 7,
          blocks: [
            { id: 'b-org-table', type: 'table', visible: true, title: '', refId: 'tbl-org-level' },
          ],
        },
      ],
    },
    {
      id: 'm-visit', visible: true, title: '二、走访慰问情况', sheet: '02-走访慰问', showDetail: true,
      columns: [
        {
          id: 'c-visit-1', width: 6,
          blocks: [
            { id: 'b-visit-metrics', type: 'metrics', visible: true, title: '', metricIds: ['visit-total', 'visit-amount'] },
            { id: 'b-visit-chart', type: 'chart', visible: true, title: '', refId: 'chart-visit-type' },
          ],
        },
        {
          id: 'c-visit-2', width: 6,
          blocks: [
            { id: 'b-visit-table', type: 'table', visible: true, title: '', refId: 'tbl-visit-areas' },
          ],
        },
      ],
    },
    {
      id: 'm-act', visible: true, title: '三、员工活动情况', sheet: '03-员工活动', showDetail: true,
      columns: [
        {
          id: 'c-act-1', width: 12,
          blocks: [
            { id: 'b-act-metrics', type: 'metrics', visible: true, title: '', metricIds: ['act-total', 'act-coverage', 'act-spend'] },
            { id: 'b-act-metrics2', type: 'metrics', visible: true, title: '关键派生指标（示例：可在后台改公式）', metricIds: ['org-rate', 'fund-per-org'] },
          ],
        },
        {
          id: 'c-act-2', width: 6,
          blocks: [
            { id: 'b-act-table', type: 'table', visible: true, title: '', refId: 'tbl-act-forms' },
          ],
        },
        {
          id: 'c-act-3', width: 6,
          blocks: [
            { id: 'b-act-chart', type: 'chart', visible: true, title: '', refId: 'chart-act-type' },
          ],
        },
      ],
    },
    {
      id: 'm-fund', visible: true, title: '四、经费收支情况', sheet: '04-经费收支', showDetail: true,
      columns: [
        {
          id: 'c-fund-1', width: 12,
          blocks: [
            { id: 'b-fund-metrics', type: 'metrics', visible: true, title: '', metricIds: ['fund-initial', 'fund-spend', 'fund-balance'] },
          ],
        },
        {
          id: 'c-fund-2', width: 12,
          blocks: [
            { id: 'b-fund-chart', type: 'chart', visible: true, title: '各工会经费结余（万元）', refId: 'chart-fund-bar' },
          ],
        },
        {
          id: 'c-fund-3', width: 12,
          blocks: [
            {
              id: 'b-fund-bridge', type: 'chart', visible: true,
              title: '各工会经费「期初 → 入账 → 支出 → 结余」桥梁图（元）',
              refId: 'chart-fund-bridge',
            },
          ],
        },
      ],
    },
  ],
};
