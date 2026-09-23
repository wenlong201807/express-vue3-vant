import { onBeforeUnmount, ref, unref } from 'vue'

/**
 * 心跳/补报共用 payload（字段与 spec §6.1 请求 body 一致）
 * @typedef {object} HeartbeatPayload
 * @property {string} user_id
 * @property {string} content_id
 * @property {number} played_sec
 * @property {number} position
 * @property {number} stay_sec
 * @property {number} client_ts
 */

/**
 * 扩展点 1：采集适配器（本次会话内累计）
 * @typedef {object} PlaySource
 * @property {() => { playedDelta: number, position: number }} getSnapshot
 */

/**
 * 扩展点 2：上报通道
 * @typedef {object} Reporter
 * @property {(payload: HeartbeatPayload) => Promise<void>} heartbeat   心跳通道
 * @property {(payload: HeartbeatPayload) => void} beacon               退出补报通道（sendBeacon，失败 fallback fetch keepalive）
 */

/**
 * @typedef {object} PlayRecordOptions
 * @property {import('vue').MaybeRef<string>} contentId
 * @property {import('vue').MaybeRef<string>} userId
 * @property {number} [interval]                 心跳间隔 ms，默认 15000
 * @property {PlaySource} source                 扩展点1：采集适配器
 * @property {Reporter} [reporter]               扩展点2：上报通道，默认实现 fetch 心跳 + sendBeacon 退出补报；测试可注入 mock
 * @property {(payload: HeartbeatPayload) => void} [onReport]
 */

/**
 * 带释放语义的采集源（videoSource / articleSource 实际返回类型）
 * @typedef {PlaySource & { destroy: () => void }} DisposablePlaySource
 */

/**
 * hook 返回值（spec §7.2 第 6 项）
 * @typedef {object} PlayRecordHandle
 * @property {() => void} pause
 * @property {() => void} resume
 * @property {() => void} reportNow
 * @property {import('vue').Ref<HeartbeatPayload>} latest
 */

const HEARTBEAT_URL = '/api/records/heartbeat'

/**
 * 默认 Reporter（spec §7.1 扩展点2 默认实现）：
 * - heartbeat：fetch POST JSON + keepalive（hidden 中 ended→reportNow 走本通道，页面回收不取消请求）
 * - beacon：navigator.sendBeacon(Blob type: application/json) → 失败/不可用 fallback fetch keepalive（spec §9）
 * @returns {Reporter}
 */
export function createDefaultReporter() {
  return {
    async heartbeat(payload) {
      await fetch(HEARTBEAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      })
    },
    beacon(payload) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(HEARTBEAT_URL, blob)
      ) {
        return
      }
      void fetch(HEARTBEAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {
        // 补报失败静默：服务端 MAX 幂等 + 下次全量快照覆盖自愈（spec §7.2 第 5 项）
      })
    }
  }
}

/**
 * @typedef {object} Baseline
 * @property {number} played_sec
 * @property {number} position
 * @property {number} stay_sec
 * @property {number} finished
 */

/**
 * @param {number} n
 * @returns {number}
 */
function round3(n) {
  return Math.round(n * 1000) / 1000
}

/**
 * @param {PlayRecordOptions} options
 * @returns {PlayRecordHandle}
 */
export function usePlayRecord(options) {
  const interval = options.interval ?? 15000
  const reporter = options.reporter ?? createDefaultReporter()
  const source = options.source

  let baseline = { played_sec: 0, position: 0, stay_sec: 0, finished: 0 }
  let staySessionMs = 0                    // 本次会话内可见期间累计墙钟 ms（hidden 冻结）
  let visibleSince = document.visibilityState === 'visible' ? Date.now() : null
  let timerId = null
  let manualPaused = false
  let disposed = false

  const latest = ref(makeSnapshot())

  function currentStaySessionMs() {
    return visibleSince === null ? staySessionMs : staySessionMs + (Date.now() - visibleSince)
  }

  /**
   * 全量快照 = 历史基线（played/stay）+ 会话增量 + 采集源当前位置（spec §7.2 第 2 项）
   * @returns {HeartbeatPayload}
   */
  function makeSnapshot() {
    const snap = source.getSnapshot()
    return {
      user_id: unref(options.userId),
      content_id: unref(options.contentId),
      played_sec: round3(baseline.played_sec + snap.playedDelta),
      position: snap.position,
      stay_sec: round3(baseline.stay_sec + currentStaySessionMs() / 1000),
      client_ts: Date.now()
    }
  }

  /**
   * @param {('heartbeat' | 'beacon')} channel
   */
  function emitAndReport(channel) {
    const payload = makeSnapshot()
    latest.value = payload
    if (channel === 'heartbeat') {
      reporter.heartbeat(payload).catch(() => {
        // 心跳失败静默、不重试（spec §7.2 第 5 项）
      })
    } else {
      reporter.beacon(payload)
    }
    options.onReport?.(payload)
  }

  function startTimer() {
    if (disposed || manualPaused || timerId !== null) return
    if (document.visibilityState !== 'visible') return  // hidden 期间不启动（由 visible 事件重启）
    timerId = setInterval(() => emitAndReport('heartbeat'), interval)
  }

  function stopTimer() {
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  /**
   * 历史基线（spec §7.2 第 1 项）：挂载时 GET /api/records/:contentId
   * @returns {Promise<void>}
   */
  async function loadBaseline() {
    const url = `/api/records/${encodeURIComponent(unref(options.contentId))}?user_id=${encodeURIComponent(unref(options.userId))}`
    try {
      const res = await fetch(url)
      if (!res.ok) return
      const data = await res.json()
      baseline = {
        played_sec: data.played_sec ?? 0,
        position: data.position ?? 0,
        stay_sec: data.stay_sec ?? 0,
        finished: data.finished ?? 0
      }
      latest.value = makeSnapshot()   // 基线落定后刷新 latest（spec §7.2 第 6 项：latest 为当前快照，供反显）
    } catch {
      // 基线拉取失败按 0 基线继续：全量快照口径下服务端 MAX 保护兜底
    }
  }

  /** 退出矩阵（spec §7.2 第 4 项，全部事件驱动、不由定时器触发） */
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      visibleSince = Date.now()            // 停留时钟继续
      startTimer()                         // 重启 interval
    } else {
      staySessionMs = currentStaySessionMs() // 冻结停留时钟
      visibleSince = null
      stopTimer()                          // 停 interval
      emitAndReport('beacon')              // beacon 补报最后快照
    }
  }

  function onPageExit() {
    emitAndReport('beacon')                // pagehide / beforeunload（iOS 企业微信 WebView 关键路径）
  }

  onBeforeUnmount(() => {
    if (disposed) return
    // 先清理再补报（质量审加固）：补报路径（getSnapshot/onReport）抛错时 interval 与三监听仍必被拆除，
    // 「退出页面后不得再由定时器触发上报」为硬约束；beacon 通道不受 disposed 守卫影响，清理后照常直发
    disposed = true
    stopTimer()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageExit)
    window.removeEventListener('beforeunload', onPageExit)
    try {
      emitAndReport('beacon')              // 路由跳转补报（默认实现 sendBeacon→fetch keepalive fallback）
    } catch {
      // 补报组装抛错静默：清理已完成，全量快照口径下次覆盖自愈
    }
  })

  void loadBaseline()
  startTimer()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageExit)
  window.addEventListener('beforeunload', onPageExit)

  return {
    pause() {
      manualPaused = true
      stopTimer()
    },
    resume() {
      manualPaused = false
      startTimer()
    },
    reportNow() {
      if (!disposed) emitAndReport('heartbeat')   // 供视频 ended 事件调用（spec §7.2 第 6 项）
    },
    latest
  }
}
