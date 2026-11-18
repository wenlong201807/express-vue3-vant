const { Router } = require('express')

// WSP 网关响应信封：前端统一按 {code, msg, data} 解析，code=200 成功
const wspOk = (data, msg = 'success') => ({ code: 200, msg, data })

/**
 * 客户收益中心（R26102373）本地联调 mock 端点，无 DB，内存演示数据。
 * 契约对齐 homeH5/src/api/incomeApi.js；种子与口径自 nestjs-server income controller 逐字搬运
 * （2026-11-16 全链路验证过的数据形状），待共性收益数据表接入后替换为真实查询。
 * 信封 { code, msg, data }，code=200 成功（与 wsp 网关一致，前端按 code===200 解析）。
 * 口径悬挂点（Q1 客户等级枚举 / Q10 亏损区间档位）以常量集中在文件头部，评审后只改这里。
 */

// Q1：客户等级口径（UI 优化 2026-11-18 对齐设计稿：金卡/钻石/财富/私银，与前端 INCOME_CUST_TYPES 同步）
const custAumColumns = [
  { type: 'all', label: '总客户', custCount: 2382, aumYi: 2698.63 },
  { type: 'gold', label: '金卡', custCount: 375, aumYi: 1235.69 },
  { type: 'diamond', label: '钻石', custCount: 1239, aumYi: 963.58 },
  { type: 'wealth', label: '财富', custCount: 2579, aumYi: 96.58 },
  { type: 'private', label: '私银', custCount: 168, aumYi: 88.66 },
]

// 区间档位（UI 优化设计稿 05：盈利/亏损两侧枚举，按收益状况快捷项切换下发；档位口径待 Q10 评审）
const profitRanges = [
  { code: 'p_80_inf', label: '80%以上' },
  { code: 'p_50_80', label: '50%~80%' },
  { code: 'p_40_60', label: '40%~60%' },
  { code: 'p_20_40', label: '20%~40%' },
  { code: 'p_0_20', label: '0%~20%' },
  { code: 'f_flat', label: '持平' },
]
const lossRanges = [
  { code: 'r_0_20', label: '0%~-20%' },
  { code: 'r_20_40', label: '-20%~-40%' },
  { code: 'r_40_60', label: '-40%~-60%' },
  { code: 'r_60_80', label: '-60%~-80%' },
  { code: 'r_80_inf', label: '-80%以上' },
]

// 区间 code → 区间收益率判定（收益状况快捷项与区间为 AND、区间多选之间 OR）
const rangePredicates = {
  // 盈利区间（设计稿 50%~80% 与 40%~60% 存在交叠，按设计稿原样保留）
  p_80_inf: (y) => y >= 80,
  p_50_80: (y) => y > 50 && y <= 80,
  p_40_60: (y) => y > 40 && y <= 60,
  p_20_40: (y) => y > 20 && y <= 40,
  p_0_20: (y) => y > 0 && y <= 20,
  f_flat: (y) => y === 0,
  // 亏损区间
  r_0_20: (y) => y < 0 && y >= -20,
  r_20_40: (y) => y < -20 && y >= -40,
  r_40_60: (y) => y < -40 && y >= -60,
  r_60_80: (y) => y < -60 && y >= -80,
  r_80_inf: (y) => y < -80,
}

// 演示客户：覆盖 盈利/亏损/无持仓 三态与管辖客户归属场景
const handmadeCustomers = [
  {
    custId: 'C0001',
    custName: '张*远',
    custLevel: '私银客户',
    rankChg: 3,
    productLines: ['public', 'private', 'financial'],
    wealthScoreChg: 25,
    gender: '男',
    age: 52,
    custNo: '1673********73',
    aumTotal: 3568986.56,
    canContact: true,
    hasBill: true,
    intervalProfit: 189025.39,
    intervalYield: 18.49,
    annualYield: 4.51,
  },
  {
    custId: 'C0002',
    custName: '李*敏',
    custLevel: '财富客户',
    rankChg: -2,
    productLines: ['public'],
    wealthScoreChg: -18,
    gender: '女',
    age: 38,
    custNo: '1302********09',
    ownerManagerName: '陈经理', // 管辖客户：追加归属理财经理（R19）
    aumTotal: 486520.1,
    canContact: false,
    hasBill: true,
    intervalProfit: -15230.1,
    intervalYield: -3.21,
    annualYield: -0.88,
  },
  {
    custId: 'C0003',
    custName: '王*国',
    custLevel: '金卡客户',
    productLines: [], // 无持仓 → 三条线均无
    wealthScoreChg: 0,
    gender: '男',
    age: 45,
    custNo: '4406********31',
    aumTotal: 98350.0,
    canContact: false,
    hasBill: false,
    intervalProfit: null, // 无持仓 → 前端展示 '--'（R19）
    intervalYield: null,
    annualYield: null,
  },
]

// 分页联调种子：追加生成数据至 45 条（超过一页 pageSize=20），验证上拉加载/下拉刷新；
// 字段形状与脱敏口径与手工条目一致（姓名打码、custNo 中段掩码、含负收益与归属经理）
const generatedCustomers = Array.from({ length: 42 }, (_, i) => {
  const surnames = '赵钱孙周吴郑王冯陈'
  const given = '伟芳娜秀敏静丽强磊军洋勇艳杰娟涛明超霞平刚桂英'
  const profit = ((i * 37) % 21) - 7 // -7 ~ 13，含负收益
  return {
    custId: `C${String(i + 4).padStart(4, '0')}`,
    custName: `${surnames[i % surnames.length]}*${given[(i * 7) % given.length]}`,
    custLevel: ['金卡客户', '钻石客户', '财富客户', '私银客户'][i % 4],
    rankChg: ((i * 13) % 9) - 4, // 排名变动（UI 优化设计稿 02）：-4~4，0 不展示箭头
    // 持有产品线（产品类型过滤数据源，UI 优化设计稿 04）：四型轮转
    productLines: [
      ['public', 'private', 'financial'],
      ['public'],
      ['private', 'financial'],
      ['financial'],
    ][i % 4],
    wealthScoreChg: ((i * 11) % 41) - 20,
    gender: i % 2 ? '女' : '男',
    age: 26 + ((i * 3) % 45),
    custNo: `${1000 + i * 13}********${String(10 + (i % 89)).padStart(2, '0')}`,
    ...(i % 5 === 0
      ? { ownerManagerName: `理财经理${String.fromCharCode(65 + (i % 26))}` }
      : {}),
    aumTotal: Math.round(50000 + i * 123456.78),
    canContact: i % 3 === 0,
    hasBill: i % 2 === 0,
    intervalProfit: profit * 1000 + i,
    intervalYield: Number((profit * 1.7).toFixed(2)),
    annualYield: Number((profit * 0.9).toFixed(2)),
  }
})

const customers = [...handmadeCustomers, ...generatedCustomers]

// 收益状况过滤（txt 接口3 语义：条件决定人数，0 不可跳转）：
// profit 留收益率>0，loss 留<0，空串不过滤；亏损区间多选 OR、与快捷项 AND 并存（txt 7.1）
const applyIncomeFilters = (rows, q) => {
  let out = [...rows]
  const yieldOf = (r) => Number(r.intervalYield)
  // 产品类型（UI 优化设计稿 04 追加维度，多选 OR-任一命中；无持仓客户无产品线自然被排除）
  const types = String(q.productTypes || '')
    .split(',')
    .filter(Boolean)
  if (types.length) {
    out = out.filter((r) => (r.productLines || []).some((t) => types.includes(t)))
  }
  if (q.pnlQuick === 'profit') {
    out = out.filter((r) => yieldOf(r) > 0)
  } else if (q.pnlQuick === 'loss') {
    out = out.filter((r) => yieldOf(r) < 0)
  }
  const codes = String(q.lossRanges || '')
    .split(',')
    .filter(Boolean)
  if (codes.length) {
    const preds = codes.map((c) => rangePredicates[c]).filter(Boolean)
    out = out.filter((r) => preds.some((p) => p(yieldOf(r))))
  }
  // 客户类型过滤（all 不过滤；演示列 label 拼接口径与种子 custLevel 一致）
  if (q.custType && q.custType !== 'all') {
    const keep = custAumColumns.find((c) => c.type === q.custType)
    out = out.filter((r) => keep && r.custLevel === `${keep.label}客户`)
  }
  return out
}

// 排序：income 模式按指标，asset 模式按总资产（互斥 R17）；null 指标沉底
const sortCustomers = (rows, q) => {
  const metric = q.sortMode === 'asset' ? 'aumTotal' : q.sortMetric || 'intervalYield'
  const out = [...rows]
  out.sort((a, b) => {
    const av = Number(a[metric] ?? -Infinity)
    const bv = Number(b[metric] ?? -Infinity)
    return q.sortOrder === 'asc' ? av - bv : bv - av
  })
  return out
}

function incomeRouter() {
  const router = Router()

  // 收益中心入口身份（R01/R02）：演示为三级理财经理（默认全部客户）
  router.get('/identity', (_req, res) => {
    res.json(wspOk({ authLevel: '3', allowAllCust: true, defaultCustType: 'all' }))
  })

  // 看板：客户数量+AUM（R05/R06，每日跑批落表数据的演示态）
  router.get('/dashboard/custAum', (_req, res) => {
    res.json(wspOk({ updateDate: '11月5日', columns: custAumColumns }))
  })

  // 看板/主页面：盈亏四分类（R08），演示态随 period/custType 轻微变化以验证联动
  router.get('/dashboard/pnl', (req, res) => {
    const period = String(req.query.period || 'near1y')
    const custType = String(req.query.custType || 'all')
    const productLine = String(req.query.productLine || 'all')
    const shift = (period.length + custType.length + productLine.length) % 7
    res.json(
      wspOk({
        // 基数对齐设计稿 02（28/5/13/698，覆盖 744）；shift 演示 period/custType 联动
        profitCnt: 28 - shift,
        lossCnt: 5,
        flatCnt: 13,
        noPositionCnt: 698,
        calcTime: '2026-11-05 06:00:00',
      })
    )
  })

  // 主页面：客户收益列表（txt 接口2 契约：POST，分页+排序+筛选三场景复用一个接口）
  router.post('/cust/list', (req, res) => {
    const q = req.body || {}
    let rows = applyIncomeFilters(customers, q)
    rows = sortCustomers(rows, q)
    // Q28：明文姓名演示——plainName=1 时返回完整姓名
    if (String(q.plainName) === '1') {
      rows = rows.map((r) => ({
        ...r,
        custName: String(r.custName).replace('*', String(r.custId).slice(-1)),
      }))
    }
    const pi = Math.max(1, Number(q.pageIndex) || 1)
    const ps = Math.max(1, Number(q.pageSize) || 20)
    res.json(wspOk({ total: rows.length, list: rows.slice((pi - 1) * ps, pi * ps) }))
  })

  // 筛选页：条件计数（txt 接口3：入参筛选条件返回数字，为 0 时前端不允许跳转）；
  // 与列表共用同一过滤逻辑，保证确定按钮人数与列表 total 一致（txt 10.2）
  router.get('/cust/filterCount', (req, res) => {
    const rows = applyIncomeFilters(customers, req.query)
    res.json(wspOk({ count: rows.length }))
  })

  // 筛选页：区间枚举（UI 优化设计稿 05：type=profit 盈利区间 / loss 亏损区间，随收益状况快捷项切换）
  router.get('/enum/lossRanges', (req, res) => {
    const ranges = req.query.type === 'profit' ? profitRanges : lossRanges
    res.json(wspOk({ ranges }))
  })

  return router
}

module.exports = incomeRouter
