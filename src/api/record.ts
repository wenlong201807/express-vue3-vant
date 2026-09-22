import type { HeartbeatPayload } from '../hooks/usePlayRecord'

/** GET /api/records/:contentId 响应（spec §6.2；空记录为零值默认） */
export interface PlayRecordResponse {
  content_id: string
  played_sec: number
  position: number
  stay_sec: number
  finished: 0 | 1
  updated_at: string
}

/** GET /api/contents 响应 content 项（spec §6.3 + 超集字段 video_url/article_html，见全局约定 #1） */
export interface ContentSummary {
  id: string
  type: 'video' | 'article'
  title: string
  duration_sec: number | null
  video_url: string | null
  article_html: string | null
}

export interface RecordSummary {
  played_sec: number
  position: number
  stay_sec: number
  finished: 0 | 1
}

export interface ContentListItem {
  content: ContentSummary
  record: RecordSummary
  status: 'not_started' | 'continue' | 'finished'
}

export async function getRecord(contentId: string, userId: string): Promise<PlayRecordResponse> {
  const res = await fetch(`/api/records/${encodeURIComponent(contentId)}?user_id=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`getRecord failed: ${res.status}`)
  return (await res.json()) as PlayRecordResponse
}

export async function getContents(userId: string): Promise<ContentListItem[]> {
  const res = await fetch(`/api/contents?user_id=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`getContents failed: ${res.status}`)
  return (await res.json()) as ContentListItem[]
}

/** 三接口封装完整性保留：供自定义 Reporter 或脚本复用（默认 Reporter 内联 fetch，见全局约定 #6） */
export async function postHeartbeat(payload: HeartbeatPayload): Promise<void> {
  const res = await fetch('/api/records/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`postHeartbeat failed: ${res.status}`)
}
