/**
 * 功能说明：播放记录心跳系统 e2e（真实前后端，断言走 HTTP 黑盒）
 *   - 心跳定时上报：播放 17s 后三指标（played_sec/position/stay_sec）均 > 0（经 GET /api/records/:contentId 校验）
 *   - 退出补报与心跳停止：visibilitychange hidden 触发 beacon 补报，hidden 期间无定时器上报；
 *     路由跳转（unmount）触发补报
 *   - 列表页三态渲染（not_started/continue/finished）
 *   - 详情页续播反显（ready 后 currentTime = 服务端 position）
 *   - video.js 渲染（.vjs-play-control / .vjs-playback-rate 控制条元素存在）
 * 运行命令：npm run test:e2e
 * 前置条件：无需手动起服务（webServer 自动拉起 dev:server/dev:client，播放记录为服务端内存存储）；
 *   需本机安装 Google Chrome（内置 Chromium 无 H.264 无法播放 mp4）；运行前停掉手工 dev 进程
 */
import { test, expect } from '@playwright/test'

const API_BASE = 'http://localhost:3000'
const VIDEO_ID = 'video-7092'
const ts = Date.now()

interface PlayRow {
  played_sec: number
  position: number
  stay_sec: number
  finished: number
  updated_at: string
}

// HTTP 黑盒读取播放记录：GET /api/records/:contentId。
// 空记录时接口返回零值默认（HTTP 200），以 updated_at 空串区分「从未上报」→ 返回 null。
async function fetchRecord(userId: string, contentId: string): Promise<PlayRow | null> {
  const res = await fetch(`${API_BASE}/api/records/${contentId}?user_id=${encodeURIComponent(userId)}`)
  expect(res.ok).toBeTruthy()
  const j = (await res.json()) as PlayRow
  return j.updated_at === '' ? null : j
}

async function seedRecordViaApi(userId: string, body: Record<string, number | string>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/records/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, content_id: VIDEO_ID, client_ts: Date.now(), ...body })
  })
  expect(res.ok).toBeTruthy()
}

test('心跳定时上报：播放数秒后三指标增长', async ({ page }) => {
  const user = `e2e-hb-${ts}`
  await page.goto(`/detail/${VIDEO_ID}?userid=${user}`)
  await page.click('.vjs-big-play-button')
  await page.waitForTimeout(17000)   // 心跳默认 15s 一跳
  const rec = await fetchRecord(user, VIDEO_ID)
  expect(rec).not.toBeNull()
  expect(rec!.played_sec).toBeGreaterThan(0)
  expect(rec!.position).toBeGreaterThan(0)
  expect(rec!.stay_sec).toBeGreaterThan(0)
})

test('退出补报（hidden）：beacon 补报发生，且 hidden 期间无任何定时器上报', async ({ page }) => {
  const user = `e2e-hidden-${ts}`
  await page.goto(`/detail/${VIDEO_ID}?userid=${user}`)
  await page.click('.vjs-big-play-button')
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(500)
  const rec = await fetchRecord(user, VIDEO_ID)
  expect(rec).not.toBeNull()                 // beacon 补报已写入
  expect(rec!.played_sec).toBeGreaterThan(0)

  const updated = rec!.updated_at
  const played = rec!.played_sec
  await page.waitForTimeout(5000)           // hidden 期间：心跳停止、停留冻结
  const rec2 = await fetchRecord(user, VIDEO_ID)
  expect(rec2!.updated_at).toBe(updated)    // 无新上报
  expect(rec2!.played_sec).toBe(played)
})

test('退出补报（路由跳转）：详情页返回列表触发补报', async ({ page }) => {
  const user = `e2e-route-${ts}`
  await page.goto(`/list?userid=${user}`)
  await page.click('.van-cell')             // 第一条即 video-7092（created_at 排序）
  await page.waitForSelector('.video-js')
  await page.click('.vjs-big-play-button')
  await page.waitForTimeout(3000)
  await page.click('.van-nav-bar__left')    // 返回 → unmount → 补报
  await page.waitForSelector('.van-cell')
  await page.waitForTimeout(500)
  const rec = await fetchRecord(user, VIDEO_ID)
  expect(rec).not.toBeNull()
  expect(rec!.played_sec).toBeGreaterThan(0)
})

test('列表三态渲染：not_started / continue / finished', async ({ page }) => {
  const fresh = `e2e-fresh-${ts}`
  const mid = `e2e-mid-${ts}`
  const done = `e2e-done-${ts}`
  await seedRecordViaApi(mid, { played_sec: 10, position: 10, stay_sec: 12 })
  await seedRecordViaApi(done, { played_sec: 61, position: 61.486, stay_sec: 70 })

  await page.goto(`/list?userid=${fresh}`)
  await expect(page.locator('.van-tag').first()).toContainText('未开始')
  expect(await page.locator('.van-tag').first().getAttribute('class')).toContain('van-tag--default')

  await page.goto(`/list?userid=${mid}`)
  await expect(page.locator('.van-tag').first()).toContainText('继续播放')
  expect(await page.locator('.van-tag').first().getAttribute('class')).toContain('van-tag--primary')

  await page.goto(`/list?userid=${done}`)
  await expect(page.locator('.van-tag').first()).toContainText('已播完')
  expect(await page.locator('.van-tag').first().getAttribute('class')).toContain('van-tag--success')
})

test('续播反显与 video.js 控制条（.vjs-play-control / .vjs-playback-rate）', async ({ page }) => {
  const user = `e2e-resume-${ts}`
  await seedRecordViaApi(user, { played_sec: 60, position: 61.486, stay_sec: 65 })

  await page.goto(`/detail/${VIDEO_ID}?userid=${user}`)
  await page.waitForTimeout(2500)           // player ready → currentTime(服务端 position)
  const currentTime = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)
  expect(currentTime).toBeGreaterThan(55)   // 服务端 position = 61.486

  await page.hover('.video-js')
  await expect(page.locator('.vjs-play-control')).toHaveCount(1)
  await expect(page.locator('button.vjs-playback-rate')).toHaveCount(1)
})
