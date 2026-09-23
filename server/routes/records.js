import { Router } from 'express'

export default function recordsRouter(store) {
  const router = Router()

  // 心跳上报与退出补报共用的唯一写入口（spec §6.1）
  router.post('/records/heartbeat', (req, res) => {
    const body = req.body || {}
    const required = ['user_id', 'content_id', 'played_sec', 'position', 'stay_sec']
    for (const key of required) {
      if (body[key] === undefined || body[key] === null) {
        return res.status(400).json({ ok: false, error: `${key} is required` })
      }
    }
    const { user_id, content_id } = body
    const played = Number(body.played_sec) || 0
    const position = Number(body.position) || 0
    const stay = Number(body.stay_sec) || 0

    if (!store.contents.get(content_id)) {
      return res.status(404).json({ ok: false, error: `content ${content_id} not found` })
    }

    // MAX 幂等 / position 覆盖 / 95% 判完与 finished 永久性均在 store.upsertRecord 内（spec §6.1）
    store.upsertRecord(user_id, content_id, { played_sec: played, position, stay_sec: stay })

    return res.json({ ok: true })
  })

  // 存储内全部播放记录当前最新快照，按 updated_at 降序（v1.1.0 新增，供黑盒查看/排查）
  router.get('/records', (_req, res) => {
    const records = [...store.records.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ user_id, content_id, played_sec, position, stay_sec, finished, first_report_at, updated_at }) => ({
        user_id,
        content_id,
        played_sec,
        position,
        stay_sec,
        finished,
        first_report_at,
        updated_at
      }))
    return res.json({ count: records.length, records })
  })

  // 按内容 id 查询播放记录，供详情页反显续播（spec §6.2）
  router.get('/records/:contentId', (req, res) => {
    const { contentId } = req.params
    const userId = String(req.query.user_id || 'guest')
    // 无记录时 getRecord 返回零值默认（空记录口径 spec §6.2）：HTTP 200，不做 404
    const record = store.getRecord(userId, contentId)
    return res.json({ content_id: contentId, ...record })
  })

  // 内容列表 + 播放状态聚合，列表页数据源（spec §6.3）
  router.get('/contents', (req, res) => {
    const userId = String(req.query.user_id || 'guest')
    return res.json(store.listContentsWithRecord(userId))
  })

  return router
}
