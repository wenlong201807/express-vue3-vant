import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
export const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'app.db')

export const SEED_CONTENTS = [
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

export function createDb(dbPath = DB_PATH) {
  let db
  if (dbPath === ':memory:') {
    db = new Database(':memory:')
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    db = new Database(dbPath)
  }
  db.pragma('journal_mode = WAL')

  // 表结构按 spec §5 字段级定义
  db.exec(`
    CREATE TABLE IF NOT EXISTS contents (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL CHECK (type IN ('video', 'article')),
      title        TEXT NOT NULL,
      video_url    TEXT,
      duration_sec REAL,
      article_html TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS play_records (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT NOT NULL,
      content_id      TEXT NOT NULL,
      played_sec      REAL NOT NULL DEFAULT 0,
      position        REAL NOT NULL DEFAULT 0,
      stay_sec        REAL NOT NULL DEFAULT 0,
      finished        INTEGER NOT NULL DEFAULT 0,
      first_report_at TEXT,
      updated_at      TEXT,
      UNIQUE (user_id, content_id)
    );
  `)

  seedContents(db)
  return db
}

function seedContents(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO contents (id, type, title, video_url, duration_sec, article_html, created_at)
    VALUES (@id, @type, @title, @video_url, @duration_sec, @article_html, @created_at)
  `)
  const run = db.transaction(() => {
    for (const content of SEED_CONTENTS) {
      insert.run(content)
    }
  })
  run()
}
