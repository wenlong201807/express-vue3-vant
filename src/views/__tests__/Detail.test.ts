/**
 * 功能说明：Detail.vue 详情页组件测试（video / article 二态）
 *   - video：videojs 以 controls + playbackRates [0.5,1,1.25,1.5,2] + mp4 source 初始化；
 *     ready 后 currentTime(服务端 position) 续播反显；ended 触发 reportNow（POST heartbeat）；
 *     unmount 时 player.dispose 被调用
 *   - article：v-html 渲染正文；进入页面按服务端 position 百分比定位滚动容器
 * 运行命令：npx vitest run src/views/__tests__/Detail.test.ts
 * 前置条件：无需起后端；api/record 与 video.js 均为 mock；fetch 以 stub 提供 hook 基线；
 *   article 用例通过覆写 HTMLElement.prototype 的 scrollHeight/clientHeight 提供布局尺寸
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import Vant from 'vant'
import Detail from '../Detail.vue'

const { fakePlayer, videojsFactory } = vi.hoisted(() => {
  const fakePlayer = {
    currentTime: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    ready: vi.fn(),
    dispose: vi.fn()
  }
  // 参数签名对齐 videojs(el, options) 真实调用形：零参 vi.fn 会使 mock.calls 元组为 []，
  // 导致 options 取值 calls[0][1] 处 vue-tsc 报 TS2493/TS2352（仅类型层面，运行时不变）
  return { fakePlayer, videojsFactory: vi.fn((_el: unknown, _options?: unknown) => fakePlayer) }
})

const { getContentsMock, getRecordMock } = vi.hoisted(() => ({
  getContentsMock: vi.fn(),
  getRecordMock: vi.fn()
}))

vi.mock('video.js', () => ({ default: videojsFactory }))
vi.mock('../../api/record', () => ({
  getContents: getContentsMock,
  getRecord: getRecordMock,
  postHeartbeat: vi.fn()
}))

const VIDEO_CONTENT = {
  id: 'video-7092',
  type: 'video',
  title: '企业微信培训视频',
  duration_sec: 61.486,
  video_url: '/source/7092_1790088875.mp4',
  article_html: null
} as const

const ARTICLE_CONTENT = {
  id: 'article-001',
  type: 'article',
  title: '图文：心跳上报机制说明',
  duration_sec: null,
  video_url: null,
  article_html: '<h2>标题</h2><p>正文段落</p>'
} as const

let router: Router
let wrapper: VueWrapper | null = null
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ content_id: 'c', played_sec: 0, position: 0, stay_sec: 0, finished: 0, updated_at: '' })
  }))
  vi.stubGlobal('fetch', fetchMock)
  fakePlayer.currentTime.mockReset()
  fakePlayer.on.mockReset()
  fakePlayer.off.mockReset()
  fakePlayer.ready.mockReset()
  fakePlayer.dispose.mockReset()
  videojsFactory.mockClear()
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/list', component: { template: '<div />' } },
      { path: '/detail/:id', component: { template: '<div />' } }
    ]
  })
})

afterEach(() => {
  if (wrapper) {
    wrapper.unmount()
    wrapper = null
  }
  vi.unstubAllGlobals()
})

async function mountDetail(path: string): Promise<VueWrapper> {
  await router.push(path)
  await router.isReady()
  wrapper = mount(Detail, { global: { plugins: [router, Vant] } })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('Detail - video 形态', () => {
  beforeEach(() => {
    getContentsMock.mockResolvedValue([
      { content: VIDEO_CONTENT, record: { played_sec: 5, position: 30, stay_sec: 12, finished: 0 }, status: 'continue' }
    ])
    getRecordMock.mockResolvedValue({
      content_id: 'video-7092',
      played_sec: 5,
      position: 30,
      stay_sec: 12,
      finished: 0,
      updated_at: ''
    })
  })

  it('videojs 初始化：controls + playbackRates [0.5,1,1.25,1.5,2] + mp4 source + 常驻控制条与当前/总时长显示', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    expect(videojsFactory).toHaveBeenCalledTimes(1)
    const options = videojsFactory.mock.calls[0][1] as {
      controls: boolean
      playbackRates: number[]
      sources: Array<{ src: string; type: string }>
      inactivityTimeout: number
      controlBar: { remainingTimeDisplay: boolean; currentTimeDisplay: boolean; durationDisplay: boolean }
    }
    expect(options.controls).toBe(true)
    expect(options.playbackRates).toEqual([0.5, 1, 1.25, 1.5, 2])
    expect(options.sources).toEqual([{ src: '/source/7092_1790088875.mp4', type: 'video/mp4' }])
    // 常驻：禁用无操作自动隐藏；时间格式：当前/总时长（关闭剩余时间显示）
    expect(options.inactivityTimeout).toBe(0)
    expect(options.controlBar).toEqual({ remainingTimeDisplay: false, currentTimeDisplay: true, durationDisplay: true })
  })

  it('续播反显：player ready 后 currentTime(服务端 position)', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    const readyCallback = fakePlayer.ready.mock.calls[0][0] as () => void
    readyCallback()
    expect(fakePlayer.currentTime).toHaveBeenCalledWith(30)
  })

  it('ended 事件：reportNow 立即上报（POST /api/records/heartbeat，user_id/content_id 正确）', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    const endedCallback = fakePlayer.on.mock.calls.find((c) => c[0] === 'ended')![1] as () => void
    endedCallback()
    await flushPromises()
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/records/heartbeat')
    expect(call).toBeDefined()
    const init = call![1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ user_id: 'u9', content_id: 'video-7092' })
  })

  it('unmount：player.dispose 被调用（与 usePlayRecord 清理联动）', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    wrapper!.unmount()
    wrapper = null
    expect(fakePlayer.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('Detail - article 形态', () => {
  beforeEach(() => {
    getContentsMock.mockResolvedValue([
      { content: ARTICLE_CONTENT, record: { played_sec: 0, position: 60, stay_sec: 50, finished: 0 }, status: 'continue' }
    ])
    getRecordMock.mockResolvedValue({
      content_id: 'article-001',
      played_sec: 0,
      position: 60,
      stay_sec: 50,
      finished: 0,
      updated_at: ''
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 500 })
  })

  it('渲染 article_html 并按服务端 position 百分比定位滚动容器', async () => {
    await mountDetail('/detail/article-001?userid=u9')
    const box = wrapper!.find('.article-box').element as HTMLDivElement
    expect(box.innerHTML).toContain('正文段落')
    expect(box.scrollTop).toBe(300)    // 60% × (1000 - 500)
  })
})
