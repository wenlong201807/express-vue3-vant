/**
 * 功能说明：数据层测试——contents / play_records 两表按 spec §5 建表成功；
 *   种子数据存在（1 条视频 + 2 篇图文，视频指向 /source/7092_1790088875.mp4）；
 *   同一文件库重复初始化幂等（INSERT OR IGNORE 不重复插入）
 * 运行命令：npm run test:server   （或 node --test server/__tests__/db.test.js）
 * 前置条件：npm install 已完成；用例使用内存库与临时文件库，不触碰 data/app.db
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb } from '../db.js'

test('建表成功：contents 与 play_records 两表存在', () => {
  const db = createDb(':memory:')
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('contents', 'play_records') ORDER BY name")
    .all()
  assert.deepEqual(tables.map((t) => t.name), ['contents', 'play_records'])
  db.close()
})

test('种子数据：1 条视频 + 2 篇图文，视频指向 /source 素材', () => {
  const db = createDb(':memory:')
  const rows = db.prepare('SELECT * FROM contents ORDER BY id').all()
  assert.equal(rows.length, 3)

  const videos = rows.filter((r) => r.type === 'video')
  const articles = rows.filter((r) => r.type === 'article')
  assert.equal(videos.length, 1)
  assert.equal(articles.length, 2)

  assert.equal(videos[0].video_url, '/source/7092_1790088875.mp4')
  assert.ok(videos[0].duration_sec > 0)
  assert.equal(videos[0].article_html, null)

  assert.ok(articles.every((a) => a.video_url === null && a.duration_sec === null))
  assert.ok(articles.every((a) => typeof a.article_html === 'string' && a.article_html.length > 100))
  db.close()
})

test('文件库重复初始化幂等：种子不重复插入', () => {
  const dbPath = path.join(os.tmpdir(), `app-db-test-${process.pid}-${Date.now()}.db`)
  const first = createDb(dbPath)
  first.close()
  const second = createDb(dbPath)
  const n = second.prepare('SELECT COUNT(*) AS n FROM contents').get().n
  assert.equal(n, 3)
  second.close()
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true })
  }
})
