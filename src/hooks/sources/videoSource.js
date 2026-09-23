import videojs from 'video.js'

/**
 * video.js Player 类型（经默认导出推导，规避 dist/types 子路径导出差异）
 * @typedef {ReturnType<typeof videojs>} VideoJsPlayer
 */

/**
 * video.js 采集适配器（spec §7.3）：
 * - player.on('timeupdate') 监听、player.currentTime() 取值
 * - 相邻两次 currentTime 差值累加为 playedDelta
 * - 差值 ≥ 1 秒判定为 seek 拖动不计入；负差值（回拖）同属 seek 不计入；
 *   2x 倍速下 timeupdate 正常差值约 0.5s 不受影响（防拖动/倍速虚增）
 * - position = player.currentTime()
 * - PlaySource 接口签名不变：播放器实现可替换，hook 与服务端零改动
 * @param {VideoJsPlayer} player
 * @returns {import('../usePlayRecord').DisposablePlaySource}
 */
export function videoSource(player) {
  let playedDelta = 0
  let position = 0
  let lastTime = null

  const onTimeUpdate = () => {
    const t = player.currentTime()
    if (typeof t !== 'number') return   // 类型守卫：video.js 8 类型 currentTime() 返回 number | undefined，未就绪时跳过
    if (lastTime !== null) {
      const diff = t - lastTime
      if (diff >= 0 && diff < 1) {
        playedDelta += diff
      }
    }
    lastTime = t
    position = t
  }

  player.on('timeupdate', onTimeUpdate)

  return {
    getSnapshot: () => ({ playedDelta, position }),
    destroy: () => {
      player.off('timeupdate', onTimeUpdate)
    }
  }
}
