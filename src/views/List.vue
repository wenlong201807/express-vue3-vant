<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getContents, type ContentListItem } from '../api/record'

const route = useRoute()
const router = useRouter()

const userId = ref(typeof route.query.userid === 'string' ? route.query.userid : 'guest')
const items = ref<ContentListItem[]>([])
const loading = ref(true)

// 三态映射（spec §8.1）：未开始灰 / 继续播放蓝 / 已播完绿 —— 对应 Vant Tag default/primary/success
const STATUS_META: Record<ContentListItem['status'], { text: string; type: 'default' | 'primary' | 'success' }> = {
  not_started: { text: '未开始', type: 'default' },
  continue: { text: '继续播放', type: 'primary' },
  finished: { text: '已播完', type: 'success' }
}

function subtitle(item: ContentListItem): string {
  if (item.status === 'not_started') return '暂无播放记录'
  const c = item.content
  if (c.type === 'video' && c.duration_sec && c.duration_sec > 0) {
    const percent = Math.floor((item.record.position / c.duration_sec) * 100)
    return `已播 ${percent}% · 续播位置 ${Math.floor(item.record.position)}s`
  }
  return `已读 ${Math.floor(item.record.position)}%`
}

function goDetail(item: ContentListItem): void {
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
  <van-nav-bar title="学习内容" />
  <van-cell-group>
    <van-cell
      v-for="item in items"
      :key="item.content.id"
      :title="item.content.title"
      :label="subtitle(item)"
      is-link
      @click="goDetail(item)"
    >
      <template #value>
        <van-tag :type="STATUS_META[item.status].type">{{ STATUS_META[item.status].text }}</van-tag>
      </template>
    </van-cell>
  </van-cell-group>
  <van-empty v-if="!loading && items.length === 0" description="暂无内容" />
</template>
