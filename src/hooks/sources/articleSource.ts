import type { DisposablePlaySource } from '../usePlayRecord'

/** 滚动容器最小接口（任意可滚动元素，便于测试替身注入） */
export interface ArticleScrollTarget {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  addEventListener(type: 'scroll', listener: () => void, options?: { passive?: boolean }): void
  removeEventListener(type: 'scroll', listener: () => void): void
}

/**
 * 图文滚动采集适配器（spec §7.3）：
 * - 滚动事件节流约 200ms（首沿立即 + 尾沿补发，最后一段滚动位置不丢）
 * - position = 已滚动高度 / (总高度 - 视口高度) × 100，向下取整并收敛到 0-100
 * - playedDelta 恒 0
 * - 容器不可滚动（分母 ≤ 0）时 position = 100（一屏全文可见 = 已读到文末）
 */
export function articleSource(scrollContainer: ArticleScrollTarget, throttleMs = 200): DisposablePlaySource {
  let position = 0
  let lastEmit = 0
  let pending = false
  let timerId: ReturnType<typeof setTimeout> | null = null

  function compute(): void {
    const scrollable = scrollContainer.scrollHeight - scrollContainer.clientHeight
    if (scrollable <= 0) {
      position = 100
      return
    }
    const ratio = scrollContainer.scrollTop / scrollable
    position = Math.max(0, Math.min(100, Math.floor(ratio * 100)))
  }

  const onScroll = (): void => {
    const now = Date.now()
    if (now - lastEmit >= throttleMs) {
      lastEmit = now
      compute()
      return
    }
    if (!pending) {
      pending = true
      const delay = throttleMs - (now - lastEmit)
      timerId = setTimeout(() => {
        pending = false
        lastEmit = Date.now()
        compute()
      }, delay)
    }
  }

  scrollContainer.addEventListener('scroll', onScroll, { passive: true })

  return {
    getSnapshot: () => ({ playedDelta: 0, position }),
    destroy: () => {
      if (timerId !== null) clearTimeout(timerId)
      scrollContainer.removeEventListener('scroll', onScroll)
    }
  }
}
