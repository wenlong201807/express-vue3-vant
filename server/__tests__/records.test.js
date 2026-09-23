/**
 * 功能说明：后端 4 接口（heartbeat / records 全量快照 / records 查询 / contents 聚合）全量接口测试
 *   - heartbeat：INSERT/UPDATE 分支、MAX 幂等（同快照重发不变）、乱序不回退、position 覆盖、
 *     视频/图文各自 95% 播完判定、finished 永久性、必传字段 400、未知内容 404
 *   - GET /api/records：存储内全部记录快照，count + updated_at 降序
 *   - GET /api/records/:contentId：空记录返回零值默认记录（HTTP 200，不做 404）
 *   - GET /api/contents：三态 status 聚合（not_started / continue / finished）
 * 运行命令：npm run test:server   （或 node --test server/__tests__/records.test.js）
 * 前置条件：npm install 已完成；每个用例独立内存 store + 随机端口，无需起服务、无落盘
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createStore } from '../store.js'
import recordsRouter from '../routes/records.js'

async function startApi() {
  const store = createStore()
  const app = express()
  app.use(express.json())
  app.use('/api', recordsRouter(store))
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, store, base: `http://localhost:${server.address().port}` })
    })
  })
}

async function postHeartbeat(api, body) {
  const res = await fetch(`${api.base}/api/records/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

async function getRecord(api, contentId, userId) {
  const res = await fetch(`${api.base}/api/records/${contentId}?user_id=${userId}`)
  return { status: res.status, json: await res.json() }
}

function videoDuration(api) {
  return api.store.contents.get('video-7092').duration_sec
}

test('heartbeat 首次上报走 INSERT 分支，GET 返回落库值', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  const r1 = await postHeartbeat(api, { user_id: 'u1', content_id: 'video-7092', played_sec: 5, position: 5, stay_sec: 6, client_ts: 1 })
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.json, { ok: true })

  const r2 = await getRecord(api, 'video-7092', 'u1')
  assert.equal(r2.status, 200)
  assert.equal(r2.json.played_sec, 5)
  assert.equal(r2.json.position, 5)
  assert.equal(r2.json.stay_sec, 6)
  assert.equal(r2.json.finished, 0)
})

test('MAX 幂等：同一快照重发，played_sec / stay_sec 不变', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  const body = { user_id: 'u2', content_id: 'video-7092', played_sec: 12, position: 10, stay_sec: 8, client_ts: 2 }
  await postHeartbeat(api, body)
  await postHeartbeat(api, body)

  const r = await getRecord(api, 'video-7092', 'u2')
  assert.equal(r.json.played_sec, 12)
  assert.equal(r.json.stay_sec, 8)
})

test('乱序不回退：旧快照后到取 MAX；position 以最后请求覆盖', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  await postHeartbeat(api, { user_id: 'u3', content_id: 'video-7092', played_sec: 50, position: 40, stay_sec: 60, client_ts: 3 })
  await postHeartbeat(api, { user_id: 'u3', content_id: 'video-7092', played_sec: 20, position: 3, stay_sec: 30, client_ts: 4 })

  const r = await getRecord(api, 'video-7092', 'u3')
  assert.equal(r.json.played_sec, 50)   // MAX(旧值, 新值) 防乱序回退
  assert.equal(r.json.stay_sec, 60)
  assert.equal(r.json.position, 3)      // position 覆盖口径：续播取最后位置
})

test('视频 95% 判完：达到阈值 finished=1，position 回落不回退（永久性）', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })
  const threshold = videoDuration(api) * 0.95

  await postHeartbeat(api, { user_id: 'u4', content_id: 'video-7092', played_sec: 1, position: threshold + 0.01, stay_sec: 1, client_ts: 5 })
  let r = await getRecord(api, 'video-7092', 'u4')
  assert.equal(r.json.finished, 1)

  await postHeartbeat(api, { user_id: 'u4', content_id: 'video-7092', played_sec: 2, position: 1, stay_sec: 2, client_ts: 6 })
  r = await getRecord(api, 'video-7092', 'u4')
  assert.equal(r.json.finished, 1)      // 一旦为 1 永久保持
  assert.equal(r.json.position, 1)      // position 仍如实覆盖
})

test('视频未达 95% 不判完', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })
  const threshold = videoDuration(api) * 0.95

  await postHeartbeat(api, { user_id: 'u5', content_id: 'video-7092', played_sec: 30, position: threshold - 1, stay_sec: 31, client_ts: 7 })
  const r = await getRecord(api, 'video-7092', 'u5')
  assert.equal(r.json.finished, 0)
})

test('图文 95% 判完：position ≥ 95 判完，94 不判完', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  await postHeartbeat(api, { user_id: 'u6', content_id: 'article-001', played_sec: 0, position: 95, stay_sec: 40, client_ts: 8 })
  let r = await getRecord(api, 'article-001', 'u6')
  assert.equal(r.json.finished, 1)

  await postHeartbeat(api, { user_id: 'u7', content_id: 'article-001', played_sec: 0, position: 94, stay_sec: 10, client_ts: 9 })
  r = await getRecord(api, 'article-001', 'u7')
  assert.equal(r.json.finished, 0)
})

test('GET records 空记录：返回零值默认记录，HTTP 200 不做 404', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  const r = await getRecord(api, 'video-7092', 'nobody')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, {
    content_id: 'video-7092',
    played_sec: 0,
    position: 0,
    stay_sec: 0,
    finished: 0,
    updated_at: ''
  })
})

test('heartbeat 必传字段缺失返回 400', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  const r = await postHeartbeat(api, { content_id: 'video-7092', played_sec: 1, position: 1, stay_sec: 1 })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
})

test('heartbeat 未知 content_id 返回 404', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  const r = await postHeartbeat(api, { user_id: 'u8', content_id: 'no-such', played_sec: 1, position: 1, stay_sec: 1 })
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
})

test('GET contents 三态聚合：not_started / continue / finished', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })
  const threshold = videoDuration(api) * 0.95

  // 无记录 → not_started
  let res = await fetch(`${api.base}/api/contents?user_id=fresh`)
  let items = await res.json()
  assert.equal(items.length, 3)
  assert.ok(items.every((i) => i.status === 'not_started'))

  const videoItem = items.find((i) => i.content.id === 'video-7092')
  assert.equal(videoItem.content.type, 'video')
  assert.equal(videoItem.content.duration_sec, videoDuration(api))
  assert.equal(videoItem.record.finished, 0)
  // 超集字段（全局约定 #1）：详情页二态渲染的数据源
  assert.equal(videoItem.content.video_url, '/source/7092_1790088875.mp4')
  const articleItem = items.find((i) => i.content.id === 'article-001')
  assert.ok(articleItem.content.article_html.length > 100)

  // 有记录未完 → continue
  await postHeartbeat(api, { user_id: 'half', content_id: 'video-7092', played_sec: 20, position: 20, stay_sec: 25, client_ts: 10 })
  res = await fetch(`${api.base}/api/contents?user_id=half`)
  items = await res.json()
  assert.equal(items.find((i) => i.content.id === 'video-7092').status, 'continue')

  // 已完 → finished
  await postHeartbeat(api, { user_id: 'done', content_id: 'video-7092', played_sec: 61, position: videoDuration(api), stay_sec: 70, client_ts: 11 })
  res = await fetch(`${api.base}/api/contents?user_id=done`)
  items = await res.json()
  const done = items.find((i) => i.content.id === 'video-7092')
  assert.equal(done.status, 'finished')
  assert.equal(done.record.finished, 1)
})

test('GET records 缺 user_id 时服务端缺省 guest', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  await postHeartbeat(api, { user_id: 'guest', content_id: 'article-002', played_sec: 0, position: 10, stay_sec: 5, client_ts: 12 })
  const res = await fetch(`${api.base}/api/records/article-002`)
  const json = await res.json()
  assert.equal(json.position, 10)
})

test('GET /api/records：心跳两笔后返回 count 与 updated_at 降序 records', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close() })

  await postHeartbeat(api, { user_id: 'first', content_id: 'video-7092', played_sec: 5, position: 5, stay_sec: 6, client_ts: 13 })
  await new Promise((resolve) => setTimeout(resolve, 5))   // 保证两笔 updated_at 严格可分先后
  await postHeartbeat(api, { user_id: 'second', content_id: 'article-001', played_sec: 0, position: 96, stay_sec: 10, client_ts: 14 })

  const res = await fetch(`${api.base}/api/records`)
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.count, 2)
  assert.equal(json.records.length, 2)

  // 降序：后上报的 second 在前
  assert.equal(json.records[0].user_id, 'second')
  assert.equal(json.records[0].content_id, 'article-001')
  assert.equal(json.records[1].user_id, 'first')
  assert.ok(json.records[0].updated_at >= json.records[1].updated_at)

  // 每条快照字段齐：含 first_report_at，且 second 的图文 96 ≥ 95 已判完
  for (const key of ['user_id', 'content_id', 'played_sec', 'position', 'stay_sec', 'finished', 'first_report_at', 'updated_at']) {
    assert.ok(key in json.records[0], `records[0] 缺少字段 ${key}`)
  }
  assert.equal(json.records[0].finished, 1)
  assert.equal(json.records[0].first_report_at, json.records[0].updated_at)
})
