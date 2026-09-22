import { Router } from 'express'

/**
 * 播完判定（spec §6.1 写库规则 4）：
 * - 视频型：position ≥ duration_sec × 0.95 判完
 * - 图文型：position ≥ 95 判完
 * 返回 1/0；「已为 1 不回退」的永久性由调用方保护。
 */
function judgeFinished(content, position) {
  if (content.type === 'video') {
    return position >= (content.duration_sec || 0) * 0.95 ? 1 : 0
  }
  return position >= 95 ? 1 : 0
}

export default function recordsRouter(db) {
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

    const content = db.prepare('SELECT type, duration_sec FROM contents WHERE id = ?').get(content_id)
    if (!content) {
      return res.status(404).json({ ok: false, error: `content ${content_id} not found` })
    }

    const now = new Date().toISOString()
    const existing = db
      .prepare('SELECT played_sec, stay_sec, finished FROM play_records WHERE user_id = ? AND content_id = ?')
      .get(user_id, content_id)

    // 播完永久性：已为 1 不回退（spec §5.2 / §6.1）
    const finished = existing
      ? existing.finished === 1 ? 1 : judgeFinished(content, position)
      : judgeFinished(content, position)

    if (!existing) {
      db.prepare(`
        INSERT INTO play_records (user_id, content_id, played_sec, position, stay_sec, finished, first_report_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user_id, content_id, played, position, stay, finished, now, now)
    } else {
      // played_sec / stay_sec 取 MAX(库中旧值, 请求新值)：幂等、防重复、防乱序回退；
      // position 直接以请求值覆盖：续播语义 = 最后位置（spec §6.1 写库规则 2/3）
      db.prepare(`
        UPDATE play_records
        SET played_sec = MAX(played_sec, ?),
            position = ?,
            stay_sec = MAX(stay_sec, ?),
            finished = ?,
            updated_at = ?
        WHERE user_id = ? AND content_id = ?
      `).run(played, position, stay, finished, now, user_id, content_id)
    }

    return res.json({ ok: true })
  })

  // 按内容 id 查询播放记录，供详情页反显续播（spec §6.2）
  router.get('/records/:contentId', (req, res) => {
    const { contentId } = req.params
    const userId = String(req.query.user_id || 'guest')
    const row = db
      .prepare('SELECT content_id, played_sec, position, stay_sec, finished, updated_at FROM play_records WHERE user_id = ? AND content_id = ?')
      .get(userId, contentId)

    if (!row) {
      // 空记录口径（spec §6.2）：零值默认记录，HTTP 200，不做 404
      return res.json({ content_id: contentId, played_sec: 0, position: 0, stay_sec: 0, finished: 0, updated_at: '' })
    }
    return res.json(row)
  })

  // 内容列表 + 播放状态聚合，列表页数据源（spec §6.3）
  router.get('/contents', (req, res) => {
    const userId = String(req.query.user_id || 'guest')
    const contents = db
      .prepare('SELECT id, type, title, duration_sec, video_url, article_html FROM contents ORDER BY created_at, id')
      .all()
    const getRecord = db.prepare(
      'SELECT played_sec, position, stay_sec, finished FROM play_records WHERE user_id = ? AND content_id = ?'
    )

    const items = contents.map((content) => {
      const record = getRecord.get(userId, content.id)
      if (!record) {
        return {
          content,
          record: { played_sec: 0, position: 0, stay_sec: 0, finished: 0 },
          status: 'not_started'
        }
      }
      return {
        content,
        record,
        status: record.finished === 1 ? 'finished' : 'continue'
      }
    })
    return res.json(items)
  })

  return router
}
