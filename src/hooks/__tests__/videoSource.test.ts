/**
 * 功能说明：videoSource 采集适配器单测
 *   - timeupdate 差值累加为 playedDelta；position 取 currentTime
 *   - 差值 ≥ 1s 的 seek 跳变不计入播放时长；负差值（回拖）不计入
 *   - 2x 倍速下正常差值（约 0.5s）正常计入
 *   - destroy 移除 timeupdate 监听，之后不再累计
 * 运行命令：npx vitest run src/hooks/__tests__/videoSource.test.ts
 * 前置条件：无需真实播放器与后端；video.js Player 以测试替身注入
 */
import { describe, expect, it, vi } from 'vitest'
import { videoSource } from '../sources/videoSource'

type Handler = () => void

interface FakePlayer {
  currentTime: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  __setTime: (seconds: number) => void
}

function makeFakePlayer(): FakePlayer {
  let t = 0
  const handlers: Record<string, Handler[]> = {}
  return {
    currentTime: vi.fn(() => t),
    on: vi.fn((event: string, handler: Handler) => {
      handlers[event] = handlers[event] || []
      handlers[event].push(handler)
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers[event] = (handlers[event] || []).filter((h) => h !== handler)
    }),
    __setTime(seconds: number) {
      t = seconds
      ;(handlers.timeupdate || []).slice().forEach((h) => h())
    }
  }
}

describe('videoSource', () => {
  it('正常播放序列：差值累加为 playedDelta，position 为当前 currentTime', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    // 0.25s 均匀节拍（timeupdate 常态）：首拍建基线，其后三拍差值 0.25×3 = 0.75
    player.__setTime(0.25)
    player.__setTime(0.5)
    player.__setTime(0.75)
    player.__setTime(1.0)
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.75, position: 1.0 })
  })

  it('seek 跳变：差值 ≥ 1s 不计入播放时长，position 跟随最新位置', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.25)
    player.__setTime(30)      // 前跳 29.75s：seek，不计
    player.__setTime(30.25)
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.5, position: 30.25 })
  })

  it('回拖：负差值不计入（同属 seek 语义）', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(10)
    player.__setTime(5)       // 回拖 -5s：不计
    player.__setTime(5.25)
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.25, position: 5.25 })
  })

  it('2x 倍速：正常差值约 0.5s，计入不受 seek 过滤影响', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.5)
    player.__setTime(1.0)
    player.__setTime(1.5)
    expect(source.getSnapshot()).toEqual({ playedDelta: 1.5, position: 1.5 })
  })

  it('destroy：移除 timeupdate 监听，之后不再累计', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.5)
    source.destroy()
    expect(player.off).toHaveBeenCalledWith('timeupdate', expect.any(Function))
    player.__setTime(1.5)     // 监听已移除
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.5, position: 0.5 })
  })
})
