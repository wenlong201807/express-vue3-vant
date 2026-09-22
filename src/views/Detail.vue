<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import videojs from 'video.js'
import { getContents, getRecord, type ContentSummary, type PlayRecordResponse } from '../api/record'
import { usePlayRecord, type DisposablePlaySource, type PlaySource } from '../hooks/usePlayRecord'
import { videoSource, type VideoJsPlayer } from '../hooks/sources/videoSource'
import { articleSource } from '../hooks/sources/articleSource'

const route = useRoute()
const router = useRouter()

// userid 读取（spec §8.3）：route.query.userid 缺省 'guest'
const userId = typeof route.query.userid === 'string' ? route.query.userid : 'guest'
const contentId = route.params.id as string

const content = ref<ContentSummary | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const articleBox = ref<HTMLDivElement | null>(null)

let player: VideoJsPlayer | null = null
let activeSource: DisposablePlaySource | null = null

/**
 * 内容类型在异步加载后才可知，而 usePlayRecord 必须在 setup 内同步调用。
 * 以可切换的空采集源兜底，加载完成后 attach 真实 source（PlaySource 接口不变）。
 */
function createSwitchableSource(): { source: PlaySource; attach(inner: DisposablePlaySource): void } {
  let inner: PlaySource | null = null
  return {
    source: {
      getSnapshot: () => (inner ? inner.getSnapshot() : { playedDelta: 0, position: 0 })
    },
    attach(next: DisposablePlaySource) {
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
  const record: PlayRecordResponse = await getRecord(contentId, userId)
  content.value = item.content
  await nextTick()

  if (item.content.type === 'video') {
    const el = videoEl.value
    if (!el) return
    // spec §8.2：video.js 初始化，playbackRates 原生倍速菜单，控制条原生 seek
    player = videojs(el, {
      controls: true,
      playbackRates: [0.5, 1, 1.25, 1.5, 2],
      sources: [{ src: item.content.video_url ?? '', type: 'video/mp4' }]
    })
    // 续播反显：ready 后 currentTime(服务端 position)
    player.ready(() => {
      if (record.position > 0) {
        player!.currentTime(record.position)
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
    <div v-if="content?.type === 'video'" class="video-box">
      <video ref="videoEl" class="video-js vjs-default-skin vjs-big-play-centered" playsinline></video>
    </div>
    <div v-else-if="content?.type === 'article'" ref="articleBox" class="article-box">
      <div class="article-inner" v-html="content.article_html"></div>
    </div>
    <van-empty v-else description="加载中" />
  </div>
</template>

<style scoped>
.detail {
  min-height: 100vh;
}
.video-box {
  width: 100%;
}
.video-box :deep(.video-js) {
  width: 100%;
}
.article-box {
  height: calc(100vh - 46px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.article-inner {
  padding: 16px;
  line-height: 1.8;
}
</style>
