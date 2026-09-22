/**
 * 功能说明：usePlayRecord 核心 hook 单元测试（mock Reporter 注入 + vi.useFakeTimers + jsdom）
 *   - 心跳按 interval 节奏触发，payload = 历史基线 + 会话增量（全量快照口径）
 *   - 退出矩阵四事件：hidden 停跳+beacon 补报 / visible 重启 / pagehide、beforeunload beacon /
 *     unmount 补报+移除全部监听
 *   - hidden 期间停留时钟冻结、无任何定时器上报
 *   - 心跳失败静默不重试；pause/resume/reportNow；onReport 回调
 *   - createDefaultReporter：sendBeacon 可用走 beacon、不可用 fallback fetch keepalive
 * 运行命令：npx vitest run src/hooks/__tests__/usePlayRecord.test.ts
 * 前置条件：无需起后端（fetch 以 stub 返回历史基线零值/固定基线）；jsdom 环境由 vite.config.ts test.environment 提供
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  createDefaultReporter,
  usePlayRecord,
  type HeartbeatPayload,
  type PlayRecordHandle,
  type PlaySource,
  type Reporter
} from '../usePlayRecord'

const BASELINE = {
  content_id: 'c1',
  played_sec: 10,
  position: 5,
  stay_sec: 100,
  finished: 0,
  updated_at: ''
}

interface ReporterMocks {
  heartbeat: ReturnType<typeof vi.fn>
  beacon: ReturnType<typeof vi.fn>
}

function makeMockReporter(): { reporter: Reporter; mocks: ReporterMocks } {
  const heartbeat = vi.fn(async (_payload: HeartbeatPayload) => {})
  const beacon = vi.fn((_payload: HeartbeatPayload) => {})
  return { reporter: { heartbeat, beacon }, mocks: { heartbeat, beacon } }
}

function makeSource(playedDelta = 3, position = 7): PlaySource {
  return { getSnapshot: () => ({ playedDelta, position }) }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

let fetchMock: ReturnType<typeof vi.fn>

function mountHook(
  source: PlaySource,
  reporter: Reporter,
  onReport?: (payload: HeartbeatPayload) => void
): { wrapper: VueWrapper; handle: PlayRecordHandle } {
  let handle!: PlayRecordHandle
  const Comp = defineComponent({
    setup() {
      handle = usePlayRecord({ contentId: 'c1', userId: 'u1', interval: 15000, source, reporter, onReport })
      return () => h('div')
    }
  })
  const wrapper = mount(Comp)
  return { wrapper, handle }
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ...BASELINE }) }))
  vi.stubGlobal('fetch', fetchMock)
  setVisibility('visible')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('心跳调度与全量快照', () => {
  it('按 interval 节奏触发；payload = 历史基线 + 会话增量', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(3, 7), reporter)

    await vi.advanceTimersByTimeAsync(0)            // 等 hook 内基线 GET 落定（played 10 / stay 100）
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)
    expect(mocks.heartbeat.mock.calls[0][0]).toMatchObject({
      user_id: 'u1',
      content_id: 'c1',
      played_sec: 13,                                // 基线 10 + 会话增量 3
      position: 7,
      stay_sec: 115                                  // 基线 100 + 可见墙钟 15s
    })

    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2)
    expect(mocks.heartbeat.mock.calls[1][0].stay_sec).toBe(130)
    expect(mocks.heartbeat.mock.calls[1][0].played_sec).toBe(13)
    wrapper.unmount()
  })

  it('onReport 在每次快照组装后回调，拿到同一 payload', async () => {
    const { reporter } = makeMockReporter()
    const onReport = vi.fn()
    const { wrapper } = mountHook(makeSource(3, 7), reporter, onReport)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(onReport).toHaveBeenCalledTimes(1)
    expect(onReport.mock.calls[0][0]).toMatchObject({ content_id: 'c1', played_sec: 13 })
    wrapper.unmount()
    expect(onReport).toHaveBeenCalledTimes(2)        // unmount 补报同样触发
  })

  it('心跳失败静默：不抛未处理异常、不重试、节奏不乱', async () => {
    const heartbeat = vi.fn(async () => {
      throw new Error('network down')
    })
    const beacon = vi.fn((_p: HeartbeatPayload) => {})
    const { wrapper } = mountHook(makeSource(1, 1), { heartbeat, beacon })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(heartbeat).toHaveBeenCalledTimes(2)       // 失败后照常进入下一跳（全量快照自愈口径）
    wrapper.unmount()
  })
})

describe('退出矩阵（全部不由定时器触发）', () => {
  it('visibilitychange → hidden：停 interval + beacon 补报最后快照；停留时钟冻结', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper, handle } = mountHook(makeSource(2, 4), reporter)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10000)         // 可见停留 10s（未到首跳 15s）
    setVisibility('hidden')

    expect(mocks.beacon).toHaveBeenCalledTimes(1)
    expect(mocks.beacon.mock.calls[0][0].stay_sec).toBe(110)   // 基线 100 + 10
    expect(mocks.heartbeat).not.toHaveBeenCalled()  // 心跳从未触发过

    await vi.advanceTimersByTimeAsync(30000)         // hidden 期间：无定时器上报、停留冻结
    expect(mocks.heartbeat).not.toHaveBeenCalled()
    expect(handle.latest.value.stay_sec).toBe(110)

    setVisibility('visible')                          // visible：重启 interval、时钟继续
    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)
    expect(mocks.heartbeat.mock.calls[0][0].stay_sec).toBe(125) // 110 + 15
    wrapper.unmount()
  })

  it('pagehide 与 beforeunload：各触发一次 beacon 补报', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(1, 1), reporter)

    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('pagehide'))
    expect(mocks.beacon).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.beacon).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    expect(mocks.beacon).toHaveBeenCalledTimes(3)   // unmount 再补报一次
  })

  it('unmount（路由跳转）：补报一次 + 停 interval + 移除全部事件监听', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(5, 9), reporter)

    await vi.advanceTimersByTimeAsync(0)
    wrapper.unmount()

    expect(mocks.beacon).toHaveBeenCalledTimes(1)   // 退出补报
    expect(mocks.beacon.mock.calls[0][0]).toMatchObject({ user_id: 'u1', content_id: 'c1' })

    await vi.advanceTimersByTimeAsync(60000)        // interval 已停
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('pagehide'))     // 监听已移除，不再补报
    setVisibility('hidden')
    expect(mocks.beacon).toHaveBeenCalledTimes(1)
  })
})

describe('手动控制与返回值', () => {
  it('pause 停跳、resume 恢复、reportNow 立即上报一次', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper, handle } = mountHook(makeSource(1, 2), reporter)

    await vi.advanceTimersByTimeAsync(0)
    handle.pause()
    await vi.advanceTimersByTimeAsync(20000)
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    handle.resume()
    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)

    handle.reportNow()
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2)  // reportNow 走心跳通道，供 ended 调用
    wrapper.unmount()
  })

  it('latest 暴露当前快照（基线 + 增量）', async () => {
    const { reporter } = makeMockReporter()
    const { wrapper, handle } = mountHook(makeSource(3, 7), reporter)
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.latest.value).toMatchObject({ played_sec: 13, position: 7, stay_sec: 100 })
    wrapper.unmount()
  })
})

describe('createDefaultReporter（默认上报通道）', () => {
  it('heartbeat：POST /api/records/heartbeat，JSON body', async () => {
    const reporter = createDefaultReporter()
    await reporter.heartbeat({ user_id: 'u', content_id: 'c', played_sec: 1, position: 2, stay_sec: 3, client_ts: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/records/heartbeat')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toMatchObject({ user_id: 'u', content_id: 'c' })
  })

  it('beacon：sendBeacon 可用且成功时走 sendBeacon，不走 fetch', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(navigator.sendBeacon).toHaveBeenCalledWith('/api/records/heartbeat', expect.any(Blob))
    expect((navigator.sendBeacon as ReturnType<typeof vi.fn>).mock.calls[0][1]['type']).toBe('application/json')
  })

  it('beacon：sendBeacon 不可用时 fallback fetch keepalive', async () => {
    vi.stubGlobal('navigator', { sendBeacon: undefined })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit & { keepalive?: boolean }
    expect(init.keepalive).toBe(true)
    expect(init.method).toBe('POST')
  })

  it('beacon：sendBeacon 返回 false（队列拒绝）时同样 fallback fetch keepalive', async () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][1] as RequestInit & { keepalive?: boolean }).keepalive).toBe(true)
  })
})
