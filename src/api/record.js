/**
 * GET /api/records/:contentId 响应（spec §6.2；空记录为零值默认）
 * @typedef {object} PlayRecordResponse
 * @property {string} content_id
 * @property {number} played_sec
 * @property {number} position
 * @property {number} stay_sec
 * @property {0 | 1} finished
 * @property {string} updated_at
 */

/**
 * GET /api/contents 响应 content 项（spec §6.3 + 超集字段 video_url/article_html，见全局约定 #1）
 * @typedef {object} ContentSummary
 * @property {string} id
 * @property {'video' | 'article'} type
 * @property {string} title
 * @property {number | null} duration_sec
 * @property {string | null} video_url
 * @property {string | null} article_html
 */

/**
 * @typedef {object} RecordSummary
 * @property {number} played_sec
 * @property {number} position
 * @property {number} stay_sec
 * @property {0 | 1} finished
 */

/**
 * @typedef {object} ContentListItem
 * @property {ContentSummary} content
 * @property {RecordSummary} record
 * @property {'not_started' | 'continue' | 'finished'} status
 */

/** @typedef {import('../hooks/usePlayRecord').HeartbeatPayload} HeartbeatPayload */

/**
 * @param {string} contentId
 * @param {string} userId
 * @returns {Promise<PlayRecordResponse>}
 */
export async function getRecord(contentId, userId) {
  const res = await fetch(`/api/records/${encodeURIComponent(contentId)}?user_id=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`getRecord failed: ${res.status}`)
  return await res.json()
}

/**
 * @param {string} userId
 * @returns {Promise<ContentListItem[]>}
 */
export async function getContents(userId) {
  const res = await fetch(`/api/contents?user_id=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`getContents failed: ${res.status}`)
  return await res.json()
}

/**
 * 三接口封装完整性保留：供自定义 Reporter 或脚本复用（默认 Reporter 内联 fetch，见全局约定 #6）
 * @param {HeartbeatPayload} payload
 * @returns {Promise<void>}
 */
export async function postHeartbeat(payload) {
  const res = await fetch('/api/records/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`postHeartbeat failed: ${res.status}`)
}
