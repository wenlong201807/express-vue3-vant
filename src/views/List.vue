<script setup>
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getContents } from '../api/record'

const route = useRoute()
const router = useRouter()

const userId = ref(typeof route.query.userid === 'string' ? route.query.userid : 'guest')
const items = ref([])
const loading = ref(true)

// 三态映射（spec §8.1）：未开始灰 / 继续播放蓝 / 已播完绿 —— 对应 Vant Tag default/primary/success
const STATUS_META = {
  not_started: { text: '未开始', type: 'default' },
  continue: { text: '继续播放', type: 'primary' },
  finished: { text: '已播完', type: 'success' }
}

/**
 * @param {import('../api/record').ContentListItem} item
 * @returns {string}
 */
function subtitle(item) {
  if (item.status === 'not_started') return '暂无播放记录'
  const c = item.content
  if (c.type === 'video' && c.duration_sec && c.duration_sec > 0) {
    const percent = Math.floor((item.record.position / c.duration_sec) * 100)
    return `已播 ${percent}% · 续播位置 ${Math.floor(item.record.position)}s`
  }
  return `已读 ${Math.floor(item.record.position)}%`
}

/**
 * 纯展示辅助：进度条填充百分比（视频按 position/duration，图文 position 即百分比），不参与任何上报
 * @param {import('../api/record').ContentListItem} item
 * @returns {number}
 */
function progressPercent(item) {
  const c = item.content
  const raw =
    c.type === 'video' && c.duration_sec && c.duration_sec > 0
      ? (item.record.position / c.duration_sec) * 100
      : item.record.position
  return Math.min(100, Math.max(0, Math.floor(raw)))
}

/**
 * @param {import('../api/record').ContentListItem} item
 */
function goDetail(item) {
  router.push(`/detail/${item.content.id}?userid=${encodeURIComponent(userId.value)}`)
}

onMounted(async () => {
  try {
    items.value = await getContents(userId.value)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="list-page">
    <!-- 编辑部队头 -->
    <header class="masthead">
      <h1 class="masthead__title">内容研习</h1>
      <p class="masthead__subtitle">当前用户：{{ userId }}</p>
    </header>

    <!-- 加载态：两张骨架卡 -->
    <div v-if="loading" class="card-stack" aria-hidden="true">
      <div v-for="i in 2" :key="i" class="skeleton-card">
        <van-skeleton title :row="2" avatar avatar-shape="square" />
      </div>
    </div>

    <div v-else class="card-stack">
      <van-cell
        v-for="item in items"
        :key="item.content.id"
        class="content-card"
        :border="false"
        is-link
        @click="goDetail(item)"
      >
        <template #icon>
          <span
            class="type-badge"
            :class="item.content.type === 'video' ? 'type-badge--video' : 'type-badge--article'"
            aria-hidden="true"
          >{{ item.content.type === 'video' ? '▶' : '≡' }}</span>
        </template>
        <template #title>
          <span class="card-title">{{ item.content.title }}</span>
        </template>
        <template #label>
          <span class="card-sub">{{ subtitle(item) }}</span>
          <span
            class="card-progress"
            :class="{ 'card-progress--idle': item.status === 'not_started' }"
            aria-hidden="true"
          >
            <span class="card-progress__fill" :style="{ width: progressPercent(item) + '%' }"></span>
          </span>
        </template>
        <template #value>
          <van-tag class="card-tag" :type="STATUS_META[item.status].type">
            {{ STATUS_META[item.status].text }}
          </van-tag>
        </template>
      </van-cell>

      <van-empty v-if="items.length === 0" description="暂无内容" />
    </div>
  </div>
</template>

<style scoped>
.list-page {
  min-height: 100vh;
  padding: 0 var(--page-padding) 40px;
  background: var(--paper);
}

/* —— 编辑部队头：宋体大标题 + 朱砂小引线 + 用户标识 —— */
.masthead {
  padding: 32px 4px 20px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--line);
}
.masthead__title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 3px;
  line-height: 1.25;
  color: var(--ink);
}
.masthead__subtitle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}
.masthead__subtitle::before {
  content: '';
  flex-shrink: 0;
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
}

/* —— 卡片堆叠 —— */
.card-stack {
  min-height: 240px;
}
.content-card {
  align-items: flex-start;
  padding: 16px;
  margin-bottom: 12px;
  overflow: hidden;
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.content-card:active {
  background: #fdfaf4;
}

/* cell 骨架重排：徽标 | 标题列 | 状态签 | 箭头 */
.content-card :deep(.type-badge) {
  margin-top: 2px;
  margin-right: 12px;   /* #icon 插槽无 van-cell__left-icon 包裹，自带间距 */
}
.content-card :deep(.van-cell__title) {
  flex: 1;
  min-width: 0;
  margin-top: 1px;
}
.content-card :deep(.van-cell__value) {
  flex: none;
  margin-left: 12px;
}
.content-card :deep(.van-cell__right-icon) {
  margin-top: 6px;
  margin-left: 8px;
  color: var(--ink-2);
}
.content-card :deep(.van-cell__label) {
  margin-top: 8px;
  line-height: inherit;
}

/* 宋体标题：最多两行截断 */
.card-title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.2px;
  line-height: 1.5;
  color: var(--ink);
}

/* 副文案（已播/已读/暂无播放记录） */
.card-sub {
  display: block;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  font-variant-numeric: tabular-nums;
}

/* 可视化进度条：6px 细条，朱砂填充，未开始灰 */
.card-progress {
  display: block;
  height: 6px;
  margin-top: 12px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--track);
}
.card-progress__fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.3s ease;
}
.card-progress--idle .card-progress__fill {
  background: #ddd3c1;
}

/* 状态签微调：与标题行顶对齐 */
.content-card :deep(.card-tag) {
  flex-shrink: 0;
  margin-top: 3px;
}

/* 加载骨架卡 */
.skeleton-card {
  padding: 16px;
  margin-bottom: 12px;
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: var(--shadow-card);
}
.skeleton-card :deep(.van-skeleton) {
  padding: 0;
}
.skeleton-card :deep(.van-skeleton-avatar) {
  border-radius: 10px;
}
.skeleton-card :deep(.van-skeleton-paragraph) {
  border-radius: 3px;
}

/* 空态留白 */
.list-page :deep(.van-empty) {
  padding: 56px 0;
}
</style>
