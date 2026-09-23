<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import videojs from 'video.js'
import { getContents, getRecord } from '../api/record'
import { usePlayRecord } from '../hooks/usePlayRecord'
import { videoSource } from '../hooks/sources/videoSource'
import { articleSource } from '../hooks/sources/articleSource'

const route = useRoute()
const router = useRouter()

// userid 读取（spec §8.3）：route.query.userid 缺省 'guest'
const userId = typeof route.query.userid === 'string' ? route.query.userid : 'guest'
const contentId = route.params.id

const content = ref(null)
// 纯展示：服务端 position（图文顶部信息条「已读 N%」），不参与任何上报
const initialPosition = ref(0)
const videoEl = ref(null)
const articleBox = ref(null)

let player = null
let activeSource = null

/**
 * 内容类型在异步加载后才可知，而 usePlayRecord 必须在 setup 内同步调用。
 * 以可切换的空采集源兜底，加载完成后 attach 真实 source（PlaySource 接口不变）。
 * @returns {{ source: import('../hooks/usePlayRecord').PlaySource, attach: (inner: import('../hooks/usePlayRecord').DisposablePlaySource) => void }}
 */
function createSwitchableSource() {
  let inner = null
  return {
    source: {
      getSnapshot: () => (inner ? inner.getSnapshot() : { playedDelta: 0, position: 0 })
    },
    attach(next) {
      inner = next
    }
  }
}

const switchable = createSwitchableSource()
// hook 先注册 onBeforeUnmount：unmount 时先补报（此时 source 仍存活），再由下方清理播放器
const handle = usePlayRecord({ contentId, userId, source: switchable.source })

onMounted(async () => {
  const items = await getContents(userId)
  const item = items.find((i) => i.content.id === contentId)
  if (!item) return
  const record = await getRecord(contentId, userId)
  initialPosition.value = record.position
  content.value = item.content
  await nextTick()

  if (item.content.type === 'video') {
    const el = videoEl.value
    if (!el) return
    // spec §8.2：video.js 初始化，playbackRates 原生倍速菜单，控制条原生 seek
    player = videojs(el, {
      controls: true,
      playbackRates: [0.5, 1, 1.25, 1.5, 2],
      sources: [{ src: item.content.video_url ?? '', type: 'video/mp4' }],
      // 常驻控制条：禁用无操作自动隐藏（时间/进度条一直可见）
      inactivityTimeout: 0,
      // 时间显示：当前播放位置 / 视频总时长（替代默认的剩余时间 -1:00 格式）
      controlBar: {
        remainingTimeDisplay: false,
        currentTimeDisplay: true,
        durationDisplay: true
      }
    })
    // 续播反显：ready 后 currentTime(服务端 position)
    player.ready(() => {
      if (record.position > 0) {
        player.currentTime(record.position)
      }
    })
    // 播完立即上报一次（spec §7.2 reportNow 用途）
    player.on('ended', () => handle.reportNow())
    const source = videoSource(player)
    activeSource = source
    switchable.attach(source)
  } else {
    const box = articleBox.value
    if (!box) return
    const source = articleSource(box)
    activeSource = source
    switchable.attach(source)
    await nextTick()
    // 进入页面按服务端 position 百分比滚动定位（spec §8.2 article 形态）
    const scrollable = box.scrollHeight - box.clientHeight
    if (scrollable > 0 && record.position > 0) {
      box.scrollTop = (record.position / 100) * scrollable
    }
  }
})

onBeforeUnmount(() => {
  activeSource?.destroy()
  activeSource = null
  if (player) {
    player.dispose()   // 释放 video.js 资源，与 hook 清理联动（spec §8.2）
    player = null
  }
})
</script>

<template>
  <div class="detail">
    <van-nav-bar :title="content?.title ?? '详情'" left-arrow @click-left="router.back()" />

    <!-- 加载态：纸底骨架（content 为空时，与原「加载中」占位同语义） -->
    <div v-if="!content" class="detail-skeleton">
      <van-skeleton title :row="4" />
    </div>

    <template v-else>
      <!-- 视频型：播放器卡片（圆角裁切）+ 信息卡 -->
      <div v-if="content.type === 'video'" class="video-box">
        <div class="media-card">
          <video ref="videoEl" class="video-js vjs-default-skin vjs-big-play-centered" playsinline></video>
        </div>
        <section class="info-card">
          <h1 class="info-card__title">{{ content.title }}</h1>
          <p class="info-card__meta">
            <span class="type-badge type-badge--sm type-badge--video" aria-hidden="true">▶</span>
            <span>视频 · 时长 {{ Math.round(content.duration_sec ?? 0) }} 秒</span>
          </p>
        </section>
      </div>

      <!-- 图文型：顶部信息条 + 沉浸阅读区 -->
      <div v-else-if="content.type === 'article'" ref="articleBox" class="article-box">
        <header class="article-head">
          <h1 class="article-head__title">{{ content.title }}</h1>
          <p class="article-head__meta">
            <span class="type-badge type-badge--sm type-badge--article" aria-hidden="true">≡</span>
            <span>已读 {{ Math.floor(initialPosition) }}%</span>
          </p>
        </header>
        <div class="article-inner" v-html="content.article_html"></div>
      </div>

      <van-empty v-else description="加载中" />
    </template>
  </div>
</template>

<style scoped>
.detail {
  min-height: 100vh;
  background: var(--paper);
}

/* —— 加载骨架 —— */
.detail-skeleton {
  padding: 20px var(--page-padding) 0;
}
.detail-skeleton :deep(.van-skeleton-avatar),
.detail-skeleton :deep(.van-skeleton-paragraph) {
  border-radius: 4px;
}

/* —— 视频型：播放器卡片（圆角裁切，不触碰 video.js 内部 DOM） —— */
.video-box {
  padding: 12px var(--page-padding) 0;
}
.media-card {
  overflow: hidden;
  border-radius: var(--radius-card);
  background: #17130f;
  box-shadow: var(--shadow-card);
}
.video-box :deep(.video-js) {
  display: block;
  width: 100%;
  /* 竖屏视频限高：防止控制条被顶出视口（9:16 视频在 375px 宽下高约 960px，控制条贴底则不可见） */
  max-height: 70vh;
  background: #000;
}
/* 等比缩放：限高后视频上下留黑边，不拉伸变形 */
.video-box :deep(.vjs-tech) {
  object-fit: contain;
}

/* 信息卡：宋体标题 + 类型/时长行 */
.info-card {
  margin: 12px var(--page-padding) 0;
  padding: 18px 16px;
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.info-card__title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.3px;
  line-height: 1.45;
  color: var(--ink);
}
.info-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}

/* —— 图文型：阅读区（纸底沉浸排版） —— */
.article-box {
  height: calc(100vh - 46px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

/* 顶部信息条：吸顶，纸感毛玻璃 */
.article-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 14px 20px 12px;
  background: rgba(250, 246, 239, 0.94);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--line);
}
.article-head__title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--ink);
}
.article-head__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  font-size: 12px;
  letter-spacing: 0.5px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/* 正文：16px / 1.8 行高 / 段间距 */
.article-inner {
  padding: 20px 20px 56px;
  font-size: 16px;
  line-height: 1.8;
  color: var(--ink);
  word-break: break-word;
}
.article-inner :deep(p) {
  margin: 0 0 1.25em;
}
.article-inner :deep(p:last-child) {
  margin-bottom: 0;
}
.article-inner :deep(h1),
.article-inner :deep(h2),
.article-inner :deep(h3) {
  margin: 1.6em 0 0.8em;
  font-family: var(--font-serif);
  font-weight: 700;
  line-height: 1.4;
  color: var(--ink);
}
.article-inner :deep(h1:first-child),
.article-inner :deep(h2:first-child),
.article-inner :deep(h3:first-child) {
  margin-top: 0;
}
.article-inner :deep(h1) {
  font-size: 22px;
}
.article-inner :deep(h2) {
  font-size: 19px;
}
.article-inner :deep(h3) {
  font-size: 17px;
}
.article-inner :deep(img) {
  max-width: 100%;
  border-radius: 10px;
}
.article-inner :deep(blockquote) {
  margin: 1.25em 0;
  padding: 8px 16px;
  border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0;
  background: var(--surface);
  color: var(--ink-2);
}
.article-inner :deep(a) {
  color: var(--accent);
}
.article-inner :deep(ul),
.article-inner :deep(ol) {
  margin: 0 0 1.25em;
  padding-left: 1.4em;
}
.article-inner :deep(li) {
  margin-bottom: 0.4em;
}
</style>
