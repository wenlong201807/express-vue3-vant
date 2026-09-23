/**
 * 内存固定源数据存储（v1.1.0 起替代 sqlite 落库）：
 * - contents 为模块级固定源数据，进程内只读；records 为运行期内存写入，重启清零。
 * - upsertRecord 写库规则与原 SQL 语义逐条等价（spec §6.1）：
 *   无记录 INSERT / 有记录 UPDATE；played_sec、stay_sec 取 MAX(旧, 新)；
 *   position 直接覆盖；视频 position ≥ duration_sec × 0.95、图文 ≥ 95 判完；
 *   finished 一旦为 1 永久保持 1（先短路已有 finished）。
 */

// 源数据字段与值自原 server/db.js 种子数据逐字搬运
export const SOURCE_CONTENTS = [
  {
    id: 'video-7092',
    type: 'video',
    title: '企业微信培训视频',
    video_url: '/source/7092_1790088875.mp4',
    // duration_sec：ffprobe 实测素材时长 61.485958s，取三位小数。
    // 可调：替换 source/ 下素材后按实际时长修改（服务端按 position ≥ duration_sec × 0.95 判播完）。
    duration_sec: 61.486,
    article_html: null,
    created_at: '2026-09-20 10:00:00'
  },
  {
    id: 'article-001',
    type: 'article',
    title: '图文：心跳上报机制说明',
    video_url: null,
    duration_sec: null,
    article_html: `
      <h2>为什么需要心跳上报</h2>
      <p>播放记录系统需要采集三个核心指标：播放时长、播放时间位置、页面停留时间。播放时长按视频内容时间口径累计，页面停留时长按墙钟时间累计，倍速播放时两个指标自然分离。</p>
      <p>客户端按固定间隔组装全量快照上报，服务端以 MAX 口径幂等合并。心跳失败静默忽略，不做重试，下一次快照会自然覆盖自愈。</p>
      <h2>退出补报</h2>
      <p>页面关闭、路由跳转、切换后台都属于退出页面。退出时的上报不能由心跳定时器触发，而是由 visibilitychange、pagehide、beforeunload 事件驱动，经 sendBeacon 一次性补报最后一段数据。</p>
      <p>sendBeacon 以 Blob 且 type 为 application/json 发送，与心跳共用同一个上报端点。当 sendBeacon 不可用时，降级为 fetch keepalive 请求。</p>
      <h2>播完判定</h2>
      <p>播完由服务端判定：视频按秒，播放位置达到内容时长的 95% 即判完；图文按滚动百分比，达到 95 判完。finished 一旦为 1 永久保持 1。</p>
      <p>阅读本文时，滚动容器会按约 200ms 节流采集滚动百分比，位置换算公式为：已滚动高度除以总高度减视口高度之差，再乘以一百并向下取整。</p>
      <h2>小结</h2>
      <p>心跳机制保证运行期指标实时落库，退出补报保证最后一段数据不丢，服务端幂等保证重复与乱序上报不会破坏数据。三者配合，构成完整的播放记录链路。</p>
    `,
    created_at: '2026-09-20 10:01:00'
  },
  {
    id: 'article-002',
    type: 'article',
    title: '图文：企业微信 WebView 嵌入指南',
    video_url: null,
    duration_sec: null,
    article_html: `
      <h2>嵌入方式</h2>
      <p>前端页面以 H5 形式嵌入企业微信 WebView。列表页展示内容与播放状态，详情页按内容类型二态渲染：视频型使用 video.js 播放器，图文型渲染 HTML 正文并提供滚动阅读。</p>
      <p>用户身份通过 URL query 参数 userid 传递，前端读取后随心跳透传，缺省为 guest。</p>
      <h2>倍速与拖动</h2>
      <p>视频型详情页初始化 video.js 时配置 playbackRates 数组，提供 0.5 到 2 倍的原生速率菜单；拖动播放由 video.js 自带进度条提供，不自行实现。</p>
      <p>采集侧对 timeupdate 差值做过滤：相邻两次 currentTime 差值达到一秒及以上判定为 seek 拖动，该差值不计入播放时长，防止拖动与倍速场景虚增指标。</p>
      <h2>后台与关闭</h2>
      <p>切换后台时页面可见性变为 hidden，停留时钟冻结，心跳停止；回到前台后心跳重启，停留时钟继续累计。</p>
      <p>页面被关闭时走 pagehide 与 beforeunload 路径补报。iOS 企业微信 WebView 以 pagehide 为关键路径。</p>
      <h2>小结</h2>
      <p>嵌入场景的核心矛盾是不可控的页面生命周期。事件驱动的补报矩阵覆盖了可见性变化、页面隐藏与组件卸载三类退出路径，保证指标完整。</p>
    `,
    created_at: '2026-09-20 10:02:00'
  }
]

/**
 * 播完判定（spec §6.1 写库规则 4）：
 * - 视频型：position ≥ duration_sec × 0.95 判完
 * - 图文型：position ≥ 95 判完
 * 返回 1/0；「已为 1 不回退」的永久性由调用方保护。
 */
function judgeFinished(content, position) {
  if (content.type === 'video') {
    return position >= (content.duration_sec || 0) * 0.95 ? 1 : 0
  }
  return position >= 95 ? 1 : 0
}

/**
 * 创建内存存储实例。
 * @returns {{ contents: Map<string, object>, records: Map<string, object>, upsertRecord, getRecord, listContentsWithRecord }}
 *   - contents：Map<id, content>，固定源数据（字段与原 contents 表一致）
 *   - records：Map<`${user_id}:${content_id}`>，
 *     值含 played_sec/position/stay_sec/finished/first_report_at/updated_at（另冗余 user_id/content_id 便于快照序列化）
 */
export function createStore() {
  const contents = new Map(SOURCE_CONTENTS.map((content) => [content.id, content]))
  const records = new Map()

  /**
   * 心跳快照写入，等价原 INSERT / UPDATE 两条 SQL（spec §6.1）：
   * - played_sec / stay_sec 取 MAX(旧, 新)：幂等、防重复、防乱序回退
   * - position 直接以请求值覆盖：续播语义 = 最后位置
   * - finished：已有为 1 先短路保持；否则按内容类型 95% 口径判定
   * @returns {object|null} 写入后的完整记录；content_id 未知时返回 null
   */
  function upsertRecord(user_id, content_id, { played_sec, position, stay_sec }) {
    const content = contents.get(content_id)
    if (!content) {
      return null
    }

    const now = new Date().toISOString()
    const existing = records.get(`${user_id}:${content_id}`)

    // 播完永久性：已为 1 不回退（spec §5.2 / §6.1）
    const finished = existing
      ? existing.finished === 1 ? 1 : judgeFinished(content, position)
      : judgeFinished(content, position)

    if (!existing) {
      const record = {
        user_id,
        content_id,
        played_sec,
        position,
        stay_sec,
        finished,
        first_report_at: now,
        updated_at: now
      }
      records.set(`${user_id}:${content_id}`, record)
      return record
    }

    existing.played_sec = Math.max(existing.played_sec, played_sec)
    existing.position = position
    existing.stay_sec = Math.max(existing.stay_sec, stay_sec)
    existing.finished = finished
    existing.updated_at = now
    return existing
  }

  /**
   * 查询单条播放记录（字段口径与原 GET /api/records/:contentId 的 SELECT 一致）。
   * 无记录返回零值默认对象（空记录口径 spec §6.2：零值默认，不做 404）。
   */
  function getRecord(user_id, content_id) {
    const existing = records.get(`${user_id}:${content_id}`)
    if (!existing) {
      return { played_sec: 0, position: 0, stay_sec: 0, finished: 0, updated_at: '' }
    }
    const { played_sec, position, stay_sec, finished, updated_at } = existing
    return { played_sec, position, stay_sec, finished, updated_at }
  }

  /**
   * 内容列表 + 播放状态三态聚合（列表页数据源，spec §6.3）：
   * status = not_started（无记录）/ finished（record.finished === 1）/ continue；
   * content 含超集字段 video_url / article_html（详情页二态渲染的数据源），
   * 排序与原 SQL 一致：ORDER BY created_at, id。
   */
  function listContentsWithRecord(user_id) {
    return [...contents.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((content) => {
        const { id, type, title, duration_sec, video_url, article_html } = content
        const record = getRecord(user_id, id)
        const hasRecord = records.has(`${user_id}:${id}`)
        return {
          content: { id, type, title, duration_sec, video_url, article_html },
          record: hasRecord
            ? { played_sec: record.played_sec, position: record.position, stay_sec: record.stay_sec, finished: record.finished }
            : { played_sec: 0, position: 0, stay_sec: 0, finished: 0 },
          status: !hasRecord ? 'not_started' : record.finished === 1 ? 'finished' : 'continue'
        }
      })
  }

  return { contents, records, upsertRecord, getRecord, listContentsWithRecord }
}
