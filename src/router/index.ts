import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/list' },
    { path: '/list', name: 'list', component: () => import('../views/List.vue') },
    { path: '/detail/:id', name: 'detail', component: () => import('../views/Detail.vue') }
  ]
})

export default router
