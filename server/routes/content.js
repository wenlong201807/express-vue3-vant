const { Router } = require('express')

// WSP 网关响应信封：前端统一按 {code, msg, data} 解析，code=200 成功
const wspOk = (data, msg = 'success') => ({ code: 200, msg, data })

/**
 * homeH5 首页域 mock（/h5/content/*，无 DB）。
 * 目前承接"驾驶舱功能参数"配置接口（funcShow 指令数据源）：
 * 本地联调放开收益中心相关功能码、关闭被替代的老看板，生产灰度由真实配置驱动不受影响。
 */

// 功能码开关表：income 系放开，老客户陪伴看板关闭（R26102373 互斥灰度的本地态）
const FUNC_SWITCH = {
  income_center_show: '1',
  income_dashboard_show: '1',
  cust_comp_show: '0',
}

function contentRouter() {
  const router = Router()

  // 获取驾驶舱功能参数配置信息（入参 functionParameterCode 为逗号拼接的功能码）
  router.get('/area/function/parameter', (req, res) => {
    const codes = String(req.query.functionParameterCode || '')
      .split(',')
      .filter(Boolean)
    res.json(
      wspOk(
        codes.map((functionCode) => ({
          functionCode,
          functionParameter: FUNC_SWITCH[functionCode] ?? '0',
        }))
      )
    )
  })

  return router
}

module.exports = contentRouter
