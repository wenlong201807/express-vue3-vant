/**
 * 功能说明：List.vue 列表页组件测试
 *   - Vant Cell 列表 + Vant Tag 三态：未开始灰(default) / 继续播放蓝(primary) / 已播完绿(success)
 *   - 副标题：视频展示已播百分比与续播位置，图文展示已读百分比，未开始显示暂无播放记录
 *   - 点击跳转 /detail/:id?userid=xxx（query 缺省时透传 guest）
 * 运行命令：npx vitest run src/views/__tests__/List.test.ts
 * 前置条件：无需起后端（api/record 为 mock）；真实 vue-router（memory history）驱动跳转断言
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import Vant from 'vant'
import List from '../List.vue'

const { getContentsMock } = vi.hoisted(() => ({ getContentsMock: vi.fn() }))
vi.mock('../../api/record', () => ({
  getContents: getContentsMock,
  getRecord: vi.fn(),
  postHeartbeat: vi.fn()
}))

const ITEMS = [
  {
    content: { id: 'video-7092', type: 'video', title: '企业微信培训视频', duration_sec: 61.486, video_url: '/source/7092_1790088875.mp4', article_html: null },
    record: { played_sec: 30, position: 30, stay_sec: 35, finished: 0 },
    status: 'continue'
  },
  {
    content: { id: 'article-001', type: 'article', title: '图文：心跳上报机制说明', duration_sec: null, video_url: null, article_html: '<p>x</p>' },
    record: { played_sec: 0, position: 0, stay_sec: 0, finished: 0 },
    status: 'not_started'
  },
  {
    content: { id: 'article-002', type: 'article', title: '图文：企业微信 WebView 嵌入指南', duration_sec: null, video_url: null, article_html: '<p>y</p>' },
    record: { played_sec: 0, position: 100, stay_sec: 80, finished: 1 },
    status: 'finished'
  }
] as const

describe('List.vue', () => {
  beforeEach(async () => {
    getContentsMock.mockReset()
    getContentsMock.mockResolvedValue([...ITEMS])
  })

  async function mountList(path: string) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/list', component: List },
        { path: '/detail/:id', component: { template: '<div />' } }
      ]
    })
    await router.push(path)
    await router.isReady()
    const wrapper = mount(List, { global: { plugins: [router, Vant] } })
    await flushPromises()
    return { wrapper, router }
  }

  it('渲染 3 条 Cell，Tag 三态文案与颜色（default/primary/success）', async () => {
    const { wrapper } = await mountList('/list?userid=u7')
    expect(wrapper.findAll('.van-cell')).toHaveLength(3)
    const tags = wrapper.findAll('.van-tag')
    expect(tags.map((t) => t.text())).toEqual(['继续播放', '未开始', '已播完'])
    expect(tags[0].classes()).toContain('van-tag--primary')
    expect(tags[1].classes()).toContain('van-tag--default')
    expect(tags[2].classes()).toContain('van-tag--success')
  })

  it('副标题：视频已播百分比与续播位置 / 图文已读百分比 / 未开始提示', async () => {
    const { wrapper } = await mountList('/list?userid=u7')
    const labels = wrapper.findAll('.van-cell__label').map((l) => l.text())
    expect(labels[0]).toBe('已播 48% · 续播位置 30s')   // floor(30 / 61.486 × 100) = 48
    expect(labels[1]).toBe('暂无播放记录')
    expect(labels[2]).toBe('已读 100%')
  })

  it('点击跳转 /detail/:id 并透传 userid；query 缺省时 guest', async () => {
    const { wrapper, router } = await mountList('/list?userid=u7')
    await wrapper.findAll('.van-cell')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/detail/video-7092?userid=u7')

    const second = await mountList('/list')
    await second.wrapper.findAll('.van-cell')[1].trigger('click')
    await flushPromises()
    expect(second.router.currentRoute.value.fullPath).toBe('/detail/article-001?userid=guest')
  })
})
