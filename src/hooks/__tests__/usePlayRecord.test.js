/**
 * 功能说明：usePlayRecord 核心 hook 单元测试（mock Reporter 注入 + vi.useFakeTimers + jsdom）
 *   - 心跳按 interval 节奏触发，payload = 历史基线 + 会话增量（全量快照口径）
 *   - 退出矩阵四事件：hidden 停跳+beacon 补报 / visible 重启 / pagehide、beforeunload beacon /
 *     unmount 补报+移除全部监听
 *   - hidden 期间停留时钟冻结、无任何定时器上报
 *   - 心跳失败静默不重试；pause/resume/reportNow；onReport 回调
 *   - 基线 GET 与首跳竞态：首跳零基线+增量，基线落定后快照自纠（服务端 MAX 自愈）
 *   - onReport 在 unmount 补报路径抛错不阻断卸载清理（interval 停 + 三监听移除）
 *   - createDefaultReporter：sendBeacon 可用走 beacon、不可用 fallback fetch keepalive；
 *     heartbeat fetch 带 keepalive（页面回收不取消 hidden 中 reportNow 的快照）
 *   - ready 守卫（v1.3.0）：未就绪期间心跳与四条退出路径补报双通道全零、latest 不更新；
 *     转就绪后下一跳恢复且 payload = 基线 + 全部会话增量
 * 运行命令：npx vitest run src/hooks/__tests__/usePlayRecord.test.js
 * 前置条件：无需起后端（fetch 以 stub 返回历史基线零值/固定基线）；jsdom 环境由 vite.config test.environment 提供
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createDefaultReporter, usePlayRecord } from '../usePlayRecord'

const BASELINE = {
  content_id: 'c1',
  played_sec: 10,
  position: 5,
  stay_sec: 100,
  finished: 0,
  updated_at: ''
}

function makeMockReporter() {
  const heartbeat = vi.fn(async (_payload) => {})
  const beacon = vi.fn((_payload) => {})
  return { reporter: { heartbeat, beacon }, mocks: { heartbeat, beacon } }
}

function makeSource(playedDelta = 3, position = 7) {
  return { getSnapshot: () => ({ playedDelta, position }) }
}

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

let fetchMock

function mountHook(source, reporter, onReport, extraOptions = {}) {
  let handle
  const Comp = defineComponent({
    setup() {
      handle = usePlayRecord({ contentId: 'c1', userId: 'u1', interval: 15000, source, reporter, onReport, ...extraOptions })
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
    const beacon = vi.fn((_p) => {})
    const { wrapper } = mountHook(makeSource(1, 1), { heartbeat, beacon })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(heartbeat).toHaveBeenCalledTimes(2)       // 失败后照常进入下一跳（全量快照自愈口径）
    wrapper.unmount()
  })

  it('基线 GET >15s 才落定：首跳以零基线+增量上报，落定后快照自纠为基线+增量', async () => {
    const { reporter, mocks } = makeMockReporter()
    let resolveBaseline
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBaseline = resolve
        })
    )
    const { wrapper, handle } = mountHook(makeSource(3, 7), reporter)

    await vi.advanceTimersByTimeAsync(15000)         // 首跳先于基线落定：零基线 + 会话增量（预期行为）
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)
    expect(mocks.heartbeat.mock.calls[0][0]).toMatchObject({ played_sec: 3, stay_sec: 15 })

    resolveBaseline({ ok: true, json: async () => ({ ...BASELINE }) })
    await vi.advanceTimersByTimeAsync(0)             // 基线落定：latest 自纠为 基线 + 累计增量
    expect(handle.latest.value).toMatchObject({ played_sec: 13, stay_sec: 115 })

    await vi.advanceTimersByTimeAsync(15000)         // 下一跳恢复全量快照（服务端 MAX 兜底自愈）
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2)
    expect(mocks.heartbeat.mock.calls[1][0]).toMatchObject({ played_sec: 13, stay_sec: 130 })
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

  it('onReport 在 unmount 补报路径抛错：清理仍先完成（interval 停 + 三监听移除）', async () => {
    const { reporter, mocks } = makeMockReporter()
    const onReport = vi.fn(() => {
      throw new Error('onReport boom')
    })
    const { wrapper } = mountHook(makeSource(5, 9), reporter, onReport)

    await vi.advanceTimersByTimeAsync(0)
    wrapper.unmount()                               // 补报路径上 onReport 同步抛错

    await vi.advanceTimersByTimeAsync(60000)         // interval 已停：无任何定时器上报（硬约束）
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('pagehide'))      // 三监听已移除：不再补报
    setVisibility('hidden')
    expect(mocks.beacon).toHaveBeenCalledTimes(1)    // 仅 unmount 补报那一次（补报先于清理时抛错会跳过全部清理）
    expect(mocks.beacon.mock.calls[0][0]).toMatchObject({ user_id: 'u1', content_id: 'c1' })
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

describe('ready 守卫（内容未就绪期间零上报零污染，v1.3.0）', () => {
  it('未就绪期间 interval 照跑但每跳直接跳过：零心跳零 beacon、latest 不更新，unmount 补报同样为零', async () => {
    const { reporter, mocks } = makeMockReporter()
    let readyFlag = false
    const { wrapper, handle } = mountHook(makeSource(3, 7), reporter, undefined, { ready: () => readyFlag })

    await vi.advanceTimersByTimeAsync(0)             // 基线 GET 照常（ready 只拦上报，不拦基线拉取）
    expect(handle.latest.value).toMatchObject({ played_sec: 13, stay_sec: 100 })   // 基线落定刷新 latest

    await vi.advanceTimersByTimeAsync(60000)         // 4 跳全部被 ready 守卫拦截（interval 节奏不受影响）
    expect(mocks.heartbeat).not.toHaveBeenCalled()
    expect(mocks.beacon).not.toHaveBeenCalled()
    expect(handle.latest.value.stay_sec).toBe(100)   // latest 不更新（仍为基线落定时的快照）

    wrapper.unmount()                                // 未就绪退出：补报也跳过（未就绪快照 position=0 会覆盖历史续播位置）
    expect(mocks.beacon).not.toHaveBeenCalled()
    expect(mocks.heartbeat).not.toHaveBeenCalled()
  })

  it('转就绪后下一跳恢复上报，payload = 基线 + 全部会话增量（含未就绪期间的停留墙钟）', async () => {
    const { reporter, mocks } = makeMockReporter()
    let readyFlag = false
    const { wrapper } = mountHook(makeSource(3, 7), reporter, undefined, { ready: () => readyFlag })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30000)         // 未就绪：两跳被拦
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    readyFlag = true
    await vi.advanceTimersByTimeAsync(15000)         // 就绪后下一跳：恢复上报
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)
    expect(mocks.heartbeat.mock.calls[0][0]).toMatchObject({
      played_sec: 13,                                // 基线 10 + 会话增量 3
      position: 7,
      stay_sec: 145                                  // 基线 100 + 可见墙钟 45s（未就绪期间墙钟照累计）
    })
    wrapper.unmount()
  })

  it('未就绪期间 hidden / pagehide / beforeunload / unmount 四条退出路径的 beacon 补报全部跳过', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(3, 7), reporter, undefined, { ready: () => false })

    await vi.advanceTimersByTimeAsync(0)
    setVisibility('hidden')                          // 停 interval + 冻结停留时钟照常（生命周期簿记不受守卫影响）
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.beacon).not.toHaveBeenCalled()      // 三条退出路径的补报均被拦截
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    wrapper.unmount()                                // 第四条（unmount）同样为零
    expect(mocks.beacon).not.toHaveBeenCalled()
    expect(mocks.heartbeat).not.toHaveBeenCalled()
  })
})

describe('createDefaultReporter（默认上报通道）', () => {
  it('heartbeat：POST /api/records/heartbeat，JSON body', async () => {
    const reporter = createDefaultReporter()
    await reporter.heartbeat({ user_id: 'u', content_id: 'c', played_sec: 1, position: 2, stay_sec: 3, client_ts: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/records/heartbeat')
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toMatchObject({ user_id: 'u', content_id: 'c' })
  })

  it('heartbeat：fetch 带 keepalive: true（hidden 中 ended→reportNow 的丢报窗口加固）', async () => {
    const reporter = createDefaultReporter()
    await reporter.heartbeat({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    const init = fetchMock.mock.calls[0][1]
    expect(init.keepalive).toBe(true)
  })

  it('beacon：sendBeacon 可用且成功时走 sendBeacon，不走 fetch', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(navigator.sendBeacon).toHaveBeenCalledWith('/api/records/heartbeat', expect.any(Blob))
    expect(navigator.sendBeacon.mock.calls[0][1]['type']).toBe('application/json')
  })

  it('beacon：sendBeacon 不可用时 fallback fetch keepalive', async () => {
    vi.stubGlobal('navigator', { sendBeacon: undefined })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1]
    expect(init.keepalive).toBe(true)
    expect(init.method).toBe('POST')
  })

  it('beacon：sendBeacon 返回 false（队列拒绝）时同样 fallback fetch keepalive', async () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true)
  })
})
