<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <!-- 按路由 fullPath 重挂载：usePlayRecord 不 watch contentId/userId（MaybeRef 仅快照时取值），
       Detail 在 /detail/a → /detail/b（或仅 query 变化）间若被 vue-router 复用组件实例，
       会把旧基线与新 content_id 组合上报。router-view 加 key 强制路由变化即重挂载（Task 4 质量审 Minor 2）。 -->
  <router-view :key="route.fullPath" />
</template>
