/**
 * 功能说明：articleSource 滚动采集适配器单测
 *   - 百分比换算：已滚动高度 / (总高度 - 视口高度) × 100，向下取整、收敛 0-100
 *   - 节流约 200ms：窗口内首次立即计算，尾沿定时器补最新位置（最后一段滚动不丢）
 *   - playedDelta 恒 0；不可滚动容器（分母 ≤ 0）position = 100
 *   - destroy 移除 scroll 监听并清理尾沿定时器
 * 运行命令：npx vitest run src/hooks/__tests__/articleSource.test.ts
 * 前置条件：无需 DOM 与后端；滚动容器以测试替身注入；vi.useFakeTimers 同时控制 Date.now 与 setTimeout
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { articleSource, type ArticleScrollTarget } from '../sources/articleSource'

interface FakeContainer {
  container: ArticleScrollTarget
  fire: () => void
}

function makeFakeContainer(
  init: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}
): FakeContainer {
  const state = {
    scrollTop: init.scrollTop ?? 0,
    scrollHeight: init.scrollHeight ?? 1000,
    clientHeight: init.clientHeight ?? 500
  }
  const listeners: Array<() => void> = []
  const container: ArticleScrollTarget = {
    get scrollTop() {
      return state.scrollTop
    },
    set scrollTop(v: number) {
      state.scrollTop = v
    },
    get scrollHeight() {
      return state.scrollHeight
    },
    get clientHeight() {
      return state.clientHeight
    },
    addEventListener(_type: 'scroll', listener: () => void) {
      listeners.push(listener)
    },
    removeEventListener(_type: 'scroll', listener: () => void) {
      const i = listeners.indexOf(listener)
      if (i >= 0) listeners.splice(i, 1)
    }
  }
  return { container, fire: () => listeners.slice().forEach((l) => l()) }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('articleSource', () => {
  it('百分比换算：向下取整；playedDelta 恒 0', async () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)
    container.scrollTop = 100     // 100 / (1000-500) = 20%
    fire()
    expect(source.getSnapshot()).toEqual({ playedDelta: 0, position: 20 })
    container.scrollTop = 249.99  // 49.998% → 49
    fire()                        // 窗口内，尾沿定时器补发
    await vi.advanceTimersByTimeAsync(200)
    expect(source.getSnapshot().position).toBe(49)
  })

  it('收敛到 0-100：到底为 100，负偏移钳到 0', async () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)
    container.scrollTop = 500
    fire()
    expect(source.getSnapshot().position).toBe(100)
    container.scrollTop = -20
    fire()                        // 窗口内，尾沿定时器补发
    await vi.advanceTimersByTimeAsync(200)
    expect(source.getSnapshot().position).toBe(0)
  })

  it('节流 200ms：窗口内首次立即生效，尾沿定时器补最新位置', async () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)

    container.scrollTop = 100     // t0：立即计算 → 20%
    fire()
    expect(source.getSnapshot().position).toBe(20)

    container.scrollTop = 250     // t0+100ms：窗口内，暂不生效
    await vi.advanceTimersByTimeAsync(100)
    fire()
    expect(source.getSnapshot().position).toBe(20)

    await vi.advanceTimersByTimeAsync(100)   // 尾沿触发：补最新位置 50%
    expect(source.getSnapshot().position).toBe(50)
  })

  it('不可滚动容器（scrollHeight ≤ clientHeight）：position = 100', () => {
    const { container, fire } = makeFakeContainer({ scrollHeight: 500, clientHeight: 500 })
    const source = articleSource(container)
    fire()
    expect(source.getSnapshot().position).toBe(100)
  })

  it('destroy：移除监听并清理未触发的尾沿定时器', async () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)

    container.scrollTop = 100
    fire()
    container.scrollTop = 250
    await vi.advanceTimersByTimeAsync(100)
    fire()                        // 进入 pending（尾沿定时器挂起）

    source.destroy()
    await vi.advanceTimersByTimeAsync(200)
    expect(source.getSnapshot().position).toBe(20)   // 尾沿已清理

    container.scrollTop = 400
    fire()                        // 监听已移除
    expect(source.getSnapshot().position).toBe(20)
  })
})
