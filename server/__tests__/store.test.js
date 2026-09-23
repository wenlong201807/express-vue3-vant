/**
 * 功能说明：数据层测试——内存固定源数据结构（1 条视频 + 2 篇图文，视频指向 /source/7092_1790088875.mp4，
 *   duration_sec 精确 61.486）；getRecord 无记录返回零值默认；listContentsWithRecord 三态聚合
 *   （not_started / continue / finished，content 含超集字段 video_url / article_html）
 * 运行命令：npm run test:server   （或 node --test server/__tests__/store.test.js）
 * 前置条件：npm install 已完成；纯内存对象，无落盘、无端口
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, SOURCE_CONTENTS } from '../store.js'

test('源数据结构：3 条（1 视频 + 2 图文），字段齐且视频 duration_sec 精确 61.486', () => {
  assert.equal(SOURCE_CONTENTS.length, 3)

  const store = createStore()
  assert.equal(store.contents.size, 3)

  const videos = [...store.contents.values()].filter((c) => c.type === 'video')
  const articles = [...store.contents.values()].filter((c) => c.type === 'article')
  assert.equal(videos.length, 1)
  assert.equal(articles.length, 2)

  const video = videos[0]
  assert.equal(video.id, 'video-7092')
  assert.equal(video.video_url, '/source/7092_1790088875.mp4')
  assert.equal(video.duration_sec, 61.486)
  assert.equal(video.article_html, null)
  for (const key of ['id', 'type', 'title', 'video_url', 'duration_sec', 'article_html', 'created_at']) {
    assert.ok(key in video, `视频缺少字段 ${key}`)
  }

  assert.ok(articles.every((a) => a.video_url === null && a.duration_sec === null))
  assert.ok(articles.every((a) => typeof a.article_html === 'string' && a.article_html.length > 100))
})

test('getRecord 零值默认：无记录返回零值对象（与 GET 接口语义一致）', () => {
  const store = createStore()
  assert.deepEqual(store.getRecord('nobody', 'video-7092'), {
    played_sec: 0,
    position: 0,
    stay_sec: 0,
    finished: 0,
    updated_at: ''
  })
  assert.equal(store.records.size, 0)   // 查询不产生写入
})

test('listContentsWithRecord 三态：not_started / continue / finished', () => {
  const store = createStore()
  const duration = store.contents.get('video-7092').duration_sec

  // 无记录 → not_started；content 含超集字段
  let items = store.listContentsWithRecord('u1')
  assert.equal(items.length, 3)
  assert.ok(items.every((i) => i.status === 'not_started'))
  const videoItem = items.find((i) => i.content.id === 'video-7092')
  assert.equal(videoItem.content.duration_sec, 61.486)
  assert.equal(videoItem.content.video_url, '/source/7092_1790088875.mp4')
  assert.ok(items.find((i) => i.content.id === 'article-001').content.article_html.length > 100)
  assert.deepEqual(videoItem.record, { played_sec: 0, position: 0, stay_sec: 0, finished: 0 })

  // 有记录未完 → continue
  store.upsertRecord('u1', 'video-7092', { played_sec: 20, position: 20, stay_sec: 25 })
  items = store.listContentsWithRecord('u1')
  assert.equal(items.find((i) => i.content.id === 'video-7092').status, 'continue')

  // position ≥ duration × 0.95 → finished
  store.upsertRecord('u1', 'video-7092', { played_sec: 61, position: duration, stay_sec: 70 })
  items = store.listContentsWithRecord('u1')
  const done = items.find((i) => i.content.id === 'video-7092')
  assert.equal(done.status, 'finished')
  assert.equal(done.record.finished, 1)
})
