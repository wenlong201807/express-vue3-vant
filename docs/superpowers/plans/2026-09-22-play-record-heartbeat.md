# 播放记录心跳上报系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零搭建 express+sqlite 后端与 vue3+vant+video.js 前端，实现播放记录心跳上报、退出补报与三态反显

**Architecture:** 单仓库；后端 3 接口（心跳写库 MAX 幂等/单条查询/列表聚合）；前端核心 hook usePlayRecord 通过 PlaySource/Reporter 双扩展点插拔采集与上报；退出场景由事件驱动补报而非定时器

**Tech Stack:** Express、better-sqlite3、node:test、Vue3、Vite、Vant、TypeScript、video.js ^8.x、vitest、@vue/test-utils、playwright

---

## 全局约定（所有 Task 生效）

- **工作目录**：所有命令均在仓库根目录 `/Users/zhuwenlong/Desktop/ai-study/express-vue3-vant` 执行。
- **环境事实（已核实）**：node v24.13.1 / npm 11.8.0；素材 `source/7092_1790088875.mp4` 经 ffprobe 实测时长 **61.485958s**；本机已装 Google Chrome（Task 7 e2e 依赖）；项目当前不是 git 仓库（Task 1 执行 git init）。
- **依赖版本矩阵（已对 npm registry 核实，均为可安装版本）**：

| 包 | 版本 | 说明 |
|---|---|---|
| express | ^5.2.0 | 后端框架 |
| better-sqlite3 | ^13.0.0 | 同步 SQLite，支持 node 24 |
| vue / vue-router / vant | ^3.5.0 / ^4.5.0 / ^4.10.0 | 前端框架与 UI |
| video.js | ^8.24.0 | spec 钦定 ^8.x |
| vite / @vitejs/plugin-vue | ^5.4.0 / ^5.2.0 | 构建工具（与 vitest 2.x 兼容矩阵） |
| vitest / @vue/test-utils / jsdom | ^2.1.0 / ^2.4.6 / ^25.0.0 | hook 与组件单测 |
| typescript / vue-tsc | ^5.8.0 / ^2.2.0 | 不用 TS7（Go 重写版），稳态组合 |
| @playwright/test | ^1.63.0 | e2e，走 channel:'chrome' |
| concurrently | ^9.1.0 | 双进程 dev |

- **TDD 节奏**：每个功能步 = 写失败测试 → 跑测试确认失败（记录失败输出）→ 最小实现 → 跑测试确认通过 → git commit。提交信息一律 Conventional Commits（feat/test/chore/docs）。
- **测试文件头注释块（spec §10.5 硬性要求）**：每个测试文件头部必须有注释块，含三要素：`功能说明` / `运行命令` / `前置条件`。模板：

```ts
/**
 * 功能说明：<验证什么行为>
 * 运行命令：<完整可复制命令>
 * 前置条件：<依赖的服务/数据/环境>
 */
```

- **关键实现决策（spec 缺口/歧义的落地口径，实现时不得偏离）**：
  1. **`GET /api/contents` 的 content 对象为 §6.3 示例的超集**：额外返回 `video_url`、`article_html`（§5.1 内容表字段自然透出）。原因：spec 仅 3 接口（决策 #3），Detail 二态渲染需要这两个字段，若新增第 4 接口违背已定稿口径。不改变 §6.3 已定义字段与三态映射。
  2. **unmount 补报通道走 `reporter.beacon`**：`Reporter` 接口（§7.1）仅有 heartbeat/beacon 两方法；默认 beacon 实现 = `sendBeacon` → 失败/不可用 fallback `fetch keepalive`（§9），与 §7.2.4 unmount 行「fetch keepalive 补报」及 §6.1「心跳与补报共用端点」一致。
  3. **videoSource 差值计数区间为 [0, 1)**：`0 ≤ diff < 1` 计入播放时长。负差值（用户回拖）同属 seek，不计入；2x 倍速下 timeupdate 正常差值约 0.5s，不受影响（§7.3「防拖动/倍速虚增」语义）。
  4. **articleSource 不可滚动容器（`scrollHeight ≤ clientHeight`，公式分母为 0）**：`position = 100`（一屏全文可见 = 已读到文末，与 95% 判完语义一致）。
  5. **e2e 用 `channel: 'chrome'`**：Playwright 内置 Chromium 不含 H.264 专有编解码器，无法播放 mp4 素材；本机已装 Chrome（已核实）。
  6. **hook 基线拉取（§7.2 第 1 项职责）内置于 hook 自身的 fetch**，不依赖 `src/api/record.ts`（hook 自包含、Task 4 先于 Task 6 创建）；`src/api/record.ts` 的 `postHeartbeat` 为三接口封装完整性保留，供自定义 Reporter 复用。
  7. **`GET /api/records/:contentId` 缺 `user_id` query 时服务端缺省 `'guest'`**（决策 #4 全链路口径）。
  8. **种子视频 `duration_sec = 61.486`**（ffprobe 实测 61.485958 取三位小数，注释注明可调，服务端按 `position ≥ duration_sec × 0.95 = 58.4117` 判播完）。

---

## Task 1：工程脚手架（单仓库、双进程 dev、git init）

**依赖**：无（首个任务）
**Files:**
- Create: `package.json`、`.gitignore`、`index.html`、`vite.config.ts`、`tsconfig.json`、`src/env.d.ts`、`src/main.ts`、`src/App.vue`、`src/router/index.ts`、`src/views/List.vue`（占位，Task 6 重写）、`src/views/Detail.vue`（占位，Task 6 重写）、`server/index.js`
- Test: 无（本任务为脚手架，验收靠命令输出）

### 步骤

- [ ] 1.1 初始化 git 仓库并创建 `.gitignore`

```bash
git init
```

预期输出：`Initialized empty Git repository in /Users/zhuwenlong/Desktop/ai-study/express-vue3-vant/.git/`

创建 `.gitignore`，内容：

```gitignore
node_modules/
dist/
data/
*.db
*.db-journal
*.db-wal
*.db-shm
test-results/
playwright-report/
```

- [ ] 1.2 创建根 `package.json`（单包管理前后端，依赖一次装齐，后续任务不再改版本）

```json
{
  "name": "express-vue3-vant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev:server": "node --watch server/index.js",
    "dev:client": "vite",
    "dev": "concurrently -n server,client -c yellow,cyan \"npm:dev:server\" \"npm:dev:client\"",
    "build": "vue-tsc --noEmit && vite build",
    "test:server": "node --test \"server/__tests__/*.test.js\"",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "smoke": "bash scripts/smoke.sh"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.0",
    "express": "^5.2.0",
    "vant": "^4.10.0",
    "video.js": "^8.24.0",
    "vue": "^3.5.0",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0",
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.0.0",
    "@vitejs/plugin-vue": "^5.2.0",
    "@vue/test-utils": "^2.4.6",
    "concurrently": "^9.1.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.8.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0",
    "vue-tsc": "^2.2.0"
  }
}
```

> 注意：`test:server` 必须用引号包裹的 glob 写法——node 24 的 `--test` 位置参数按 glob 解释，裸目录 `server/__tests__/` 会报 `Cannot find module`（实测 node v24.13.1）。

- [ ] 1.3 安装依赖

```bash
npm install
```

预期输出末行形如：`added 4xx packages in 3xs`（better-sqlite3 若无预编译产物会本机编译，macOS 需 Xcode CLT，正常静默通过）。确认命令：`node -e "require('better-sqlite3'); console.log('sqlite ok')"` → 输出 `sqlite ok`

- [ ] 1.4 创建 `tsconfig.json` 与 `src/env.d.ts`

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue", "vite.config.ts"]
}
```

`src/env.d.ts`：

```ts
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
```

- [ ] 1.5 创建 `index.html`（vite 入口，移动端 viewport）

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>播放记录心跳上报</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] 1.6 创建 `vite.config.ts`（dev proxy：`/api` 与 `/source` 均转发 3000——`/source` 是视频素材静态目录，不代理则 dev 下视频不可达；Task 4 会在此基础上加 vitest 配置）

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/source': 'http://localhost:3000'
    }
  }
})
```

- [ ] 1.7 创建 `src/main.ts` 与 `src/App.vue`

`src/main.ts`（Vant 全量注册，组件测试同样以插件方式挂载）：

```ts
import { createApp } from 'vue'
import Vant from 'vant'
import 'vant/lib/index.css'
import App from './App.vue'
import router from './router'

createApp(App).use(Vant).use(router).mount('#app')
```

`src/App.vue`：

```vue
<template>
  <router-view />
</template>
```

- [ ] 1.8 创建 `src/router/index.ts`（两路由，列表为默认页）

```ts
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
```

- [ ] 1.9 创建占位页面 `src/views/List.vue` 与 `src/views/Detail.vue`（Task 6 重写为完整实现）

`src/views/List.vue`：

```vue
<script setup lang="ts"></script>

<template>
  <van-nav-bar title="学习内容" />
  <van-cell-group>
    <van-cell title="列表加载中" />
  </van-cell-group>
</template>
```

`src/views/Detail.vue`：

```vue
<script setup lang="ts"></script>

<template>
  <van-nav-bar title="详情" left-arrow />
  <div class="detail-body">详情加载中</div>
</template>

<style scoped>
.detail-body {
  padding: 16px;
}
</style>
```

- [ ] 1.10 创建 `server/index.js` 骨架（express + json + `/source` 静态目录 + 3000 端口；路由与数据库在 Task 2/3 接入）

```js
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()

app.use(express.json())
app.use('/source', express.static(path.join(__dirname, '..', 'source')))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})

export default app
```

- [ ] 1.11 验收：双进程起服 + 页面与静态资源可达

```bash
npm run dev > /tmp/dev.log 2>&1 &
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/
curl -s http://localhost:3000/api/health
echo
curl -s -I http://localhost:3000/source/7092_1790088875.mp4 | head -1
lsof -ti:3000 -ti:5173 | xargs kill
```

预期输出（按行）：

```
200
{"ok":true}
HTTP/1.1 200 OK
```

- [ ] 1.12 提交

```bash
git add -A
git commit -m "chore: 初始化工程脚手架（vue3+vite+vant+ts 前端、express 后端骨架、vite 代理与双进程 dev）"
```

预期输出：`[root (root-commit) xxxxxxx] chore: 初始化工程脚手架（vue3+vite+vant+ts 前端、express 后端骨架、vite 代理与双进程 dev）`（`git log --oneline` 可见 1 条）

---

## Task 2：数据层（better-sqlite3 建表 + 种子数据）

**依赖**：Task 1
**Files:**
- Create: `server/db.js`、`server/__tests__/db.test.js`
- Test: `server/__tests__/db.test.js`

### 步骤

- [ ] 2.1 写失败测试 `server/__tests__/db.test.js`（先于实现，TDD 红灯）

```js
/**
 * 功能说明：数据层测试——contents / play_records 两表按 spec §5 建表成功；
 *   种子数据存在（1 条视频 + 2 篇图文，视频指向 /source/7092_1790088875.mp4）；
 *   同一文件库重复初始化幂等（INSERT OR IGNORE 不重复插入）
 * 运行命令：npm run test:server   （或 node --test server/__tests__/db.test.js）
 * 前置条件：npm install 已完成；用例使用内存库与临时文件库，不触碰 data/app.db
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDb } from '../db.js'

test('建表成功：contents 与 play_records 两表存在', () => {
  const db = createDb(':memory:')
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('contents', 'play_records') ORDER BY name")
    .all()
  assert.deepEqual(tables.map((t) => t.name), ['contents', 'play_records'])
  db.close()
})

test('种子数据：1 条视频 + 2 篇图文，视频指向 /source 素材', () => {
  const db = createDb(':memory:')
  const rows = db.prepare('SELECT * FROM contents ORDER BY id').all()
  assert.equal(rows.length, 3)

  const videos = rows.filter((r) => r.type === 'video')
  const articles = rows.filter((r) => r.type === 'article')
  assert.equal(videos.length, 1)
  assert.equal(articles.length, 2)

  assert.equal(videos[0].video_url, '/source/7092_1790088875.mp4')
  assert.ok(videos[0].duration_sec > 0)
  assert.equal(videos[0].article_html, null)

  assert.ok(articles.every((a) => a.video_url === null && a.duration_sec === null))
  assert.ok(articles.every((a) => typeof a.article_html === 'string' && a.article_html.length > 100))
  db.close()
})

test('文件库重复初始化幂等：种子不重复插入', () => {
  const dbPath = path.join(os.tmpdir(), `app-db-test-${process.pid}-${Date.now()}.db`)
  const first = createDb(dbPath)
  first.close()
  const second = createDb(dbPath)
  const n = second.prepare('SELECT COUNT(*) AS n FROM contents').get().n
  assert.equal(n, 3)
  second.close()
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true })
  }
})
```

- [ ] 2.2 运行测试，确认失败

```bash
npm run test:server
```

预期输出（红灯特征）：`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/db.js'`；整文件加载失败只记 1 fail（非 3 用例各记 1），末尾统计 `# tests 1` / `# fail 1`（node 24 实测）

- [ ] 2.3 最小实现 `server/db.js`

```js
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
```

- [ ] 2.4 运行测试，确认通过

```bash
npm run test:server
```

预期输出末尾统计：

```
# tests 3
# suites 0
# pass 3
# fail 0
```

- [ ] 2.5 提交

```bash
git add -A
git commit -m "feat(server): 数据层建表与种子数据（contents/play_records + 1 视频 2 图文，含 node:test 用例）"
```

---

## Task 3：后端三接口（heartbeat 幂等写库 / 记录查询零值默认 / 列表三态聚合）

**依赖**：Task 2
**Files:**
- Create: `server/routes/records.js`、`server/__tests__/records.test.js`
- Modify: `server/index.js`（挂载 db 与路由）
- Test: `server/__tests__/records.test.js`

### 步骤

- [ ] 3.1 写失败测试 `server/__tests__/records.test.js`（全量接口用例先于实现，TDD 红灯）

```js
/**
 * 功能说明：后端 3 接口（heartbeat / records 查询 / contents 聚合）全量接口测试
 *   - heartbeat：INSERT/UPDATE 分支、MAX 幂等（同快照重发不变）、乱序不回退、position 覆盖、
 *     视频/图文各自 95% 播完判定、finished 永久性、必传字段 400、未知内容 404
 *   - GET /api/records/:contentId：空记录返回零值默认记录（HTTP 200，不做 404）
 *   - GET /api/contents：三态 status 聚合（not_started / continue / finished）
 * 运行命令：npm run test:server   （或 node --test server/__tests__/records.test.js）
 * 前置条件：npm install 已完成；每个用例独立内存库 + 随机端口，无需起服务、不影响 data/app.db
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createDb } from '../db.js'
import recordsRouter from '../routes/records.js'

async function startApi() {
  const db = createDb(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/api', recordsRouter(db))
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, db, base: `http://localhost:${server.address().port}` })
    })
  })
}

async function postHeartbeat(api, body) {
  const res = await fetch(`${api.base}/api/records/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

async function getRecord(api, contentId, userId) {
  const res = await fetch(`${api.base}/api/records/${contentId}?user_id=${userId}`)
  return { status: res.status, json: await res.json() }
}

function videoDuration(api) {
  return api.db.prepare('SELECT duration_sec AS d FROM contents WHERE id = ?').get('video-7092').d
}

test('heartbeat 首次上报走 INSERT 分支，GET 返回落库值', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  const r1 = await postHeartbeat(api, { user_id: 'u1', content_id: 'video-7092', played_sec: 5, position: 5, stay_sec: 6, client_ts: 1 })
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.json, { ok: true })

  const r2 = await getRecord(api, 'video-7092', 'u1')
  assert.equal(r2.status, 200)
  assert.equal(r2.json.played_sec, 5)
  assert.equal(r2.json.position, 5)
  assert.equal(r2.json.stay_sec, 6)
  assert.equal(r2.json.finished, 0)
})

test('MAX 幂等：同一快照重发，played_sec / stay_sec 不变', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  const body = { user_id: 'u2', content_id: 'video-7092', played_sec: 12, position: 10, stay_sec: 8, client_ts: 2 }
  await postHeartbeat(api, body)
  await postHeartbeat(api, body)

  const r = await getRecord(api, 'video-7092', 'u2')
  assert.equal(r.json.played_sec, 12)
  assert.equal(r.json.stay_sec, 8)
})

test('乱序不回退：旧快照后到取 MAX；position 以最后请求覆盖', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  await postHeartbeat(api, { user_id: 'u3', content_id: 'video-7092', played_sec: 50, position: 40, stay_sec: 60, client_ts: 3 })
  await postHeartbeat(api, { user_id: 'u3', content_id: 'video-7092', played_sec: 20, position: 3, stay_sec: 30, client_ts: 4 })

  const r = await getRecord(api, 'video-7092', 'u3')
  assert.equal(r.json.played_sec, 50)   // MAX(旧值, 新值) 防乱序回退
  assert.equal(r.json.stay_sec, 60)
  assert.equal(r.json.position, 3)      // position 覆盖口径：续播取最后位置
})

test('视频 95% 判完：达到阈值 finished=1，position 回落不回退（永久性）', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })
  const threshold = videoDuration(api) * 0.95

  await postHeartbeat(api, { user_id: 'u4', content_id: 'video-7092', played_sec: 1, position: threshold + 0.01, stay_sec: 1, client_ts: 5 })
  let r = await getRecord(api, 'video-7092', 'u4')
  assert.equal(r.json.finished, 1)

  await postHeartbeat(api, { user_id: 'u4', content_id: 'video-7092', played_sec: 2, position: 1, stay_sec: 2, client_ts: 6 })
  r = await getRecord(api, 'video-7092', 'u4')
  assert.equal(r.json.finished, 1)      // 一旦为 1 永久保持
  assert.equal(r.json.position, 1)      // position 仍如实覆盖
})

test('视频未达 95% 不判完', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })
  const threshold = videoDuration(api) * 0.95

  await postHeartbeat(api, { user_id: 'u5', content_id: 'video-7092', played_sec: 30, position: threshold - 1, stay_sec: 31, client_ts: 7 })
  const r = await getRecord(api, 'video-7092', 'u5')
  assert.equal(r.json.finished, 0)
})

test('图文 95% 判完：position ≥ 95 判完，94 不判完', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  await postHeartbeat(api, { user_id: 'u6', content_id: 'article-001', played_sec: 0, position: 95, stay_sec: 40, client_ts: 8 })
  let r = await getRecord(api, 'article-001', 'u6')
  assert.equal(r.json.finished, 1)

  await postHeartbeat(api, { user_id: 'u7', content_id: 'article-001', played_sec: 0, position: 94, stay_sec: 10, client_ts: 9 })
  r = await getRecord(api, 'article-001', 'u7')
  assert.equal(r.json.finished, 0)
})

test('GET records 空记录：返回零值默认记录，HTTP 200 不做 404', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  const r = await getRecord(api, 'video-7092', 'nobody')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, {
    content_id: 'video-7092',
    played_sec: 0,
    position: 0,
    stay_sec: 0,
    finished: 0,
    updated_at: ''
  })
})

test('heartbeat 必传字段缺失返回 400', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  const r = await postHeartbeat(api, { content_id: 'video-7092', played_sec: 1, position: 1, stay_sec: 1 })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
})

test('heartbeat 未知 content_id 返回 404', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  const r = await postHeartbeat(api, { user_id: 'u8', content_id: 'no-such', played_sec: 1, position: 1, stay_sec: 1 })
  assert.equal(r.status, 404)
  assert.equal(r.json.ok, false)
})

test('GET contents 三态聚合：not_started / continue / finished', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })
  const threshold = videoDuration(api) * 0.95

  // 无记录 → not_started
  let res = await fetch(`${api.base}/api/contents?user_id=fresh`)
  let items = await res.json()
  assert.equal(items.length, 3)
  assert.ok(items.every((i) => i.status === 'not_started'))

  const videoItem = items.find((i) => i.content.id === 'video-7092')
  assert.equal(videoItem.content.type, 'video')
  assert.equal(videoItem.content.duration_sec, videoDuration(api))
  assert.equal(videoItem.record.finished, 0)
  // 超集字段（全局约定 #1）：详情页二态渲染的数据源
  assert.equal(videoItem.content.video_url, '/source/7092_1790088875.mp4')
  const articleItem = items.find((i) => i.content.id === 'article-001')
  assert.ok(articleItem.content.article_html.length > 100)

  // 有记录未完 → continue
  await postHeartbeat(api, { user_id: 'half', content_id: 'video-7092', played_sec: 20, position: 20, stay_sec: 25, client_ts: 10 })
  res = await fetch(`${api.base}/api/contents?user_id=half`)
  items = await res.json()
  assert.equal(items.find((i) => i.content.id === 'video-7092').status, 'continue')

  // 已完 → finished
  await postHeartbeat(api, { user_id: 'done', content_id: 'video-7092', played_sec: 61, position: videoDuration(api), stay_sec: 70, client_ts: 11 })
  res = await fetch(`${api.base}/api/contents?user_id=done`)
  items = await res.json()
  const done = items.find((i) => i.content.id === 'video-7092')
  assert.equal(done.status, 'finished')
  assert.equal(done.record.finished, 1)
})

test('GET records 缺 user_id 时服务端缺省 guest', async (t) => {
  const api = await startApi()
  t.after(() => { api.server.closeAllConnections(); api.server.close(); api.db.close() })

  await postHeartbeat(api, { user_id: 'guest', content_id: 'article-002', played_sec: 0, position: 10, stay_sec: 5, client_ts: 12 })
  const res = await fetch(`${api.base}/api/records/article-002`)
  const json = await res.json()
  assert.equal(json.position, 10)
})
```

- [ ] 3.2 运行测试，确认失败

```bash
npm run test:server
```

预期输出（红灯特征）：`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/routes/records.js'`；统计行为 `# tests 14`（含 Task 2 的 3 条），records 的 11 条全部 fail

- [ ] 3.3 实现 `server/routes/records.js`

```js
import { Router } from 'express'

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

export default function recordsRouter(db) {
  const router = Router()

  // 心跳上报与退出补报共用的唯一写入口（spec §6.1）
  router.post('/records/heartbeat', (req, res) => {
    const body = req.body || {}
    const required = ['user_id', 'content_id', 'played_sec', 'position', 'stay_sec']
    for (const key of required) {
      if (body[key] === undefined || body[key] === null) {
        return res.status(400).json({ ok: false, error: `${key} is required` })
      }
    }
    const { user_id, content_id } = body
    const played = Number(body.played_sec) || 0
    const position = Number(body.position) || 0
    const stay = Number(body.stay_sec) || 0

    const content = db.prepare('SELECT type, duration_sec FROM contents WHERE id = ?').get(content_id)
    if (!content) {
      return res.status(404).json({ ok: false, error: `content ${content_id} not found` })
    }

    const now = new Date().toISOString()
    const existing = db
      .prepare('SELECT played_sec, stay_sec, finished FROM play_records WHERE user_id = ? AND content_id = ?')
      .get(user_id, content_id)

    // 播完永久性：已为 1 不回退（spec §5.2 / §6.1）
    const finished = existing
      ? existing.finished === 1 ? 1 : judgeFinished(content, position)
      : judgeFinished(content, position)

    if (!existing) {
      db.prepare(`
        INSERT INTO play_records (user_id, content_id, played_sec, position, stay_sec, finished, first_report_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user_id, content_id, played, position, stay, finished, now, now)
    } else {
      // played_sec / stay_sec 取 MAX(库中旧值, 请求新值)：幂等、防重复、防乱序回退；
      // position 直接以请求值覆盖：续播语义 = 最后位置（spec §6.1 写库规则 2/3）
      db.prepare(`
        UPDATE play_records
        SET played_sec = MAX(played_sec, ?),
            position = ?,
            stay_sec = MAX(stay_sec, ?),
            finished = ?,
            updated_at = ?
        WHERE user_id = ? AND content_id = ?
      `).run(played, position, stay, finished, now, user_id, content_id)
    }

    return res.json({ ok: true })
  })

  // 按内容 id 查询播放记录，供详情页反显续播（spec §6.2）
  router.get('/records/:contentId', (req, res) => {
    const { contentId } = req.params
    const userId = String(req.query.user_id || 'guest')
    const row = db
      .prepare('SELECT content_id, played_sec, position, stay_sec, finished, updated_at FROM play_records WHERE user_id = ? AND content_id = ?')
      .get(userId, contentId)

    if (!row) {
      // 空记录口径（spec §6.2）：零值默认记录，HTTP 200，不做 404
      return res.json({ content_id: contentId, played_sec: 0, position: 0, stay_sec: 0, finished: 0, updated_at: '' })
    }
    return res.json(row)
  })

  // 内容列表 + 播放状态聚合，列表页数据源（spec §6.3）
  router.get('/contents', (req, res) => {
    const userId = String(req.query.user_id || 'guest')
    const contents = db
      .prepare('SELECT id, type, title, duration_sec, video_url, article_html FROM contents ORDER BY created_at, id')
      .all()
    const getRecord = db.prepare(
      'SELECT played_sec, position, stay_sec, finished FROM play_records WHERE user_id = ? AND content_id = ?'
    )

    const items = contents.map((content) => {
      const record = getRecord.get(userId, content.id)
      if (!record) {
        return {
          content,
          record: { played_sec: 0, position: 0, stay_sec: 0, finished: 0 },
          status: 'not_started'
        }
      }
      return {
        content,
        record,
        status: record.finished === 1 ? 'finished' : 'continue'
      }
    })
    return res.json(items)
  })

  return router
}
```

- [ ] 3.4 修改 `server/index.js`：创建 db 并挂载路由（完整文件如下）

```js
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from './db.js'
import recordsRouter from './routes/records.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const db = createDb()

app.use(express.json())
app.use('/source', express.static(path.join(__dirname, '..', 'source')))
app.use('/api', recordsRouter(db))
app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

const PORT = Number(process.env.PORT || 3000)
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})

export default app
```

- [ ] 3.5 运行全部后端测试，确认通过

```bash
npm run test:server
```

预期输出末尾统计：

```
# tests 14
# pass 14
# fail 0
```

- [ ] 3.6 手工验证三接口（起真实服务）

```bash
npm run dev > /tmp/dev.log 2>&1 &
sleep 5
curl -s -X POST http://localhost:3000/api/records/heartbeat -H 'Content-Type: application/json' \
  -d '{"user_id":"t1","content_id":"video-7092","played_sec":1,"position":1,"stay_sec":1}'
echo
curl -s "http://localhost:3000/api/records/video-7092?user_id=t1"
echo
curl -s "http://localhost:3000/api/contents?user_id=t1" | head -c 200
echo
lsof -ti:3000 -ti:5173 | xargs kill
```

预期输出（按行）：`{"ok":true}` / `{"content_id":"video-7092","played_sec":1,"position":1,"stay_sec":1,"finished":0,...}` / contents JSON 前 200 字符（含 `"status":"continue"` 的 video-7092 项）。同时确认生成 `data/app.db`（已被 .gitignore 忽略，`git status` 不显示）。

- [ ] 3.7 提交

```bash
git add -A
git commit -m "feat(server): 心跳/查询/列表三接口（MAX 幂等、position 覆盖、95% 判完永久、三态聚合，含全量接口测试）"
```

---

## Task 4：核心 hook `usePlayRecord`（心跳调度、基线合并、退出矩阵、默认 Reporter）

**依赖**：Task 1（vite/vitest 环境）
**Files:**
- Create: `src/hooks/usePlayRecord.ts`、`src/hooks/__tests__/usePlayRecord.test.ts`
- Modify: `vite.config.ts`（切换 `vitest/config` 并加 test 配置）
- Test: `src/hooks/__tests__/usePlayRecord.test.ts`

### 步骤

- [ ] 4.1 修改 `vite.config.ts` 为最终形态（加 jsdom 测试环境；后续任务不再改动）

```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/source': 'http://localhost:3000'
    }
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts']
  }
})
```

- [ ] 4.2 写失败测试 `src/hooks/__tests__/usePlayRecord.test.ts`

```ts
/**
 * 功能说明：usePlayRecord 核心 hook 单元测试（mock Reporter 注入 + vi.useFakeTimers + jsdom）
 *   - 心跳按 interval 节奏触发，payload = 历史基线 + 会话增量（全量快照口径）
 *   - 退出矩阵四事件：hidden 停跳+beacon 补报 / visible 重启 / pagehide、beforeunload beacon /
 *     unmount 补报+移除全部监听
 *   - hidden 期间停留时钟冻结、无任何定时器上报
 *   - 心跳失败静默不重试；pause/resume/reportNow；onReport 回调
 *   - createDefaultReporter：sendBeacon 可用走 beacon、不可用 fallback fetch keepalive
 * 运行命令：npx vitest run src/hooks/__tests__/usePlayRecord.test.ts
 * 前置条件：无需起后端（fetch 以 stub 返回历史基线零值/固定基线）；jsdom 环境由 vite.config.ts test.environment 提供
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  createDefaultReporter,
  usePlayRecord,
  type HeartbeatPayload,
  type PlayRecordHandle,
  type PlaySource,
  type Reporter
} from '../usePlayRecord'

const BASELINE = {
  content_id: 'c1',
  played_sec: 10,
  position: 5,
  stay_sec: 100,
  finished: 0,
  updated_at: ''
}

interface ReporterMocks {
  heartbeat: ReturnType<typeof vi.fn>
  beacon: ReturnType<typeof vi.fn>
}

function makeMockReporter(): { reporter: Reporter; mocks: ReporterMocks } {
  const heartbeat = vi.fn(async (_payload: HeartbeatPayload) => {})
  const beacon = vi.fn((_payload: HeartbeatPayload) => {})
  return { reporter: { heartbeat, beacon }, mocks: { heartbeat, beacon } }
}

function makeSource(playedDelta = 3, position = 7): PlaySource {
  return { getSnapshot: () => ({ playedDelta, position }) }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

let fetchMock: ReturnType<typeof vi.fn>

function mountHook(
  source: PlaySource,
  reporter: Reporter,
  onReport?: (payload: HeartbeatPayload) => void
): { wrapper: VueWrapper; handle: PlayRecordHandle } {
  let handle!: PlayRecordHandle
  const Comp = defineComponent({
    setup() {
      handle = usePlayRecord({ contentId: 'c1', userId: 'u1', interval: 15000, source, reporter, onReport })
      return () => h('div')
    }
  })
  const wrapper = mount(Comp)
  return { wrapper, handle }
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ...BASELINE }) }))
  vi.stubGlobal('fetch', fetchMock)
  setVisibility('visible')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('心跳调度与全量快照', () => {
  it('按 interval 节奏触发；payload = 历史基线 + 会话增量', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(3, 7), reporter)

    await vi.advanceTimersByTimeAsync(0)            // 等 hook 内基线 GET 落定（played 10 / stay 100）
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)
    expect(mocks.heartbeat.mock.calls[0][0]).toMatchObject({
      user_id: 'u1',
      content_id: 'c1',
      played_sec: 13,                                // 基线 10 + 会话增量 3
      position: 7,
      stay_sec: 115                                  // 基线 100 + 可见墙钟 15s
    })

    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2)
    expect(mocks.heartbeat.mock.calls[1][0].stay_sec).toBe(130)
    expect(mocks.heartbeat.mock.calls[1][0].played_sec).toBe(13)
    wrapper.unmount()
  })

  it('onReport 在每次快照组装后回调，拿到同一 payload', async () => {
    const { reporter } = makeMockReporter()
    const onReport = vi.fn()
    const { wrapper } = mountHook(makeSource(3, 7), reporter, onReport)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(onReport).toHaveBeenCalledTimes(1)
    expect(onReport.mock.calls[0][0]).toMatchObject({ content_id: 'c1', played_sec: 13 })
    wrapper.unmount()
    expect(onReport).toHaveBeenCalledTimes(2)        // unmount 补报同样触发
  })

  it('心跳失败静默：不抛未处理异常、不重试、节奏不乱', async () => {
    const heartbeat = vi.fn(async () => {
      throw new Error('network down')
    })
    const beacon = vi.fn((_p: HeartbeatPayload) => {})
    const { wrapper } = mountHook(makeSource(1, 1), { heartbeat, beacon })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(heartbeat).toHaveBeenCalledTimes(2)       // 失败后照常进入下一跳（全量快照自愈口径）
    wrapper.unmount()
  })
})

describe('退出矩阵（全部不由定时器触发）', () => {
  it('visibilitychange → hidden：停 interval + beacon 补报最后快照；停留时钟冻结', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper, handle } = mountHook(makeSource(2, 4), reporter)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10000)         // 可见停留 10s（未到首跳 15s）
    setVisibility('hidden')

    expect(mocks.beacon).toHaveBeenCalledTimes(1)
    expect(mocks.beacon.mock.calls[0][0].stay_sec).toBe(110)   // 基线 100 + 10
    expect(mocks.heartbeat).not.toHaveBeenCalled()  // 心跳从未触发过

    await vi.advanceTimersByTimeAsync(30000)         // hidden 期间：无定时器上报、停留冻结
    expect(mocks.heartbeat).not.toHaveBeenCalled()
    expect(handle.latest.value.stay_sec).toBe(110)

    setVisibility('visible')                          // visible：重启 interval、时钟继续
    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)
    expect(mocks.heartbeat.mock.calls[0][0].stay_sec).toBe(125) // 110 + 15
    wrapper.unmount()
  })

  it('pagehide 与 beforeunload：各触发一次 beacon 补报', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(1, 1), reporter)

    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('pagehide'))
    expect(mocks.beacon).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.beacon).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    expect(mocks.beacon).toHaveBeenCalledTimes(3)   // unmount 再补报一次
  })

  it('unmount（路由跳转）：补报一次 + 停 interval + 移除全部事件监听', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper } = mountHook(makeSource(5, 9), reporter)

    await vi.advanceTimersByTimeAsync(0)
    wrapper.unmount()

    expect(mocks.beacon).toHaveBeenCalledTimes(1)   // 退出补报
    expect(mocks.beacon.mock.calls[0][0]).toMatchObject({ user_id: 'u1', content_id: 'c1' })

    await vi.advanceTimersByTimeAsync(60000)        // interval 已停
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('pagehide'))     // 监听已移除，不再补报
    setVisibility('hidden')
    expect(mocks.beacon).toHaveBeenCalledTimes(1)
  })
})

describe('手动控制与返回值', () => {
  it('pause 停跳、resume 恢复、reportNow 立即上报一次', async () => {
    const { reporter, mocks } = makeMockReporter()
    const { wrapper, handle } = mountHook(makeSource(1, 2), reporter)

    await vi.advanceTimersByTimeAsync(0)
    handle.pause()
    await vi.advanceTimersByTimeAsync(20000)
    expect(mocks.heartbeat).not.toHaveBeenCalled()

    handle.resume()
    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1)

    handle.reportNow()
    expect(mocks.heartbeat).toHaveBeenCalledTimes(2)  // reportNow 走心跳通道，供 ended 调用
    wrapper.unmount()
  })

  it('latest 暴露当前快照（基线 + 增量）', async () => {
    const { reporter } = makeMockReporter()
    const { wrapper, handle } = mountHook(makeSource(3, 7), reporter)
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.latest.value).toMatchObject({ played_sec: 13, position: 7, stay_sec: 100 })
    wrapper.unmount()
  })
})

describe('createDefaultReporter（默认上报通道）', () => {
  it('heartbeat：POST /api/records/heartbeat，JSON body', async () => {
    const reporter = createDefaultReporter()
    await reporter.heartbeat({ user_id: 'u', content_id: 'c', played_sec: 1, position: 2, stay_sec: 3, client_ts: 4 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/records/heartbeat')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toMatchObject({ user_id: 'u', content_id: 'c' })
  })

  it('beacon：sendBeacon 可用且成功时走 sendBeacon，不走 fetch', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(navigator.sendBeacon).toHaveBeenCalledWith('/api/records/heartbeat', expect.any(Blob))
    expect((navigator.sendBeacon as ReturnType<typeof vi.fn>).mock.calls[0][1]['type']).toBe('application/json')
  })

  it('beacon：sendBeacon 不可用时 fallback fetch keepalive', async () => {
    vi.stubGlobal('navigator', { sendBeacon: undefined })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit & { keepalive?: boolean }
    expect(init.keepalive).toBe(true)
    expect(init.method).toBe('POST')
  })

  it('beacon：sendBeacon 返回 false（队列拒绝）时同样 fallback fetch keepalive', async () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })
    const reporter = createDefaultReporter()
    reporter.beacon({ user_id: 'u', content_id: 'c', played_sec: 1, position: 1, stay_sec: 1, client_ts: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][1] as RequestInit & { keepalive?: boolean }).keepalive).toBe(true)
  })
})
```

- [ ] 4.3 运行测试，确认失败

```bash
npx vitest run src/hooks/__tests__/usePlayRecord.test.ts
```

预期输出（红灯特征）：`Error: Failed to resolve import "../usePlayRecord" from "src/hooks/__tests__/usePlayRecord.test.ts"`，`Test Files  1 failed`

- [ ] 4.4 实现 `src/hooks/usePlayRecord.ts`（接口签名与 spec §7.1 逐字一致）

```ts
import { onBeforeUnmount, ref, unref, type MaybeRef, type Ref } from 'vue'

/** 心跳/补报共用 payload（字段与 spec §6.1 请求 body 一致） */
export interface HeartbeatPayload {
  user_id: string
  content_id: string
  played_sec: number
  position: number
  stay_sec: number
  client_ts: number
}

/** 扩展点 1：采集适配器（本次会话内累计） */
export interface PlaySource {
  getSnapshot(): { playedDelta: number; position: number }
}

/** 扩展点 2：上报通道 */
export interface Reporter {
  heartbeat(payload: HeartbeatPayload): Promise<void>   // 心跳通道
  beacon(payload: HeartbeatPayload): void               // 退出补报通道（sendBeacon，失败 fallback fetch keepalive）
}

export interface PlayRecordOptions {
  contentId: MaybeRef<string>
  userId: MaybeRef<string>
  interval?: number                 // 心跳间隔 ms，默认 15000
  source: PlaySource                // 扩展点1：采集适配器
  reporter?: Reporter               // 扩展点2：上报通道，默认实现 fetch 心跳 + sendBeacon 退出补报；测试可注入 mock
  onReport?: (payload: HeartbeatPayload) => void
}

/** 带释放语义的采集源（videoSource / articleSource 实际返回类型） */
export interface DisposablePlaySource extends PlaySource {
  destroy(): void
}

/** hook 返回值（spec §7.2 第 6 项） */
export interface PlayRecordHandle {
  pause(): void
  resume(): void
  reportNow(): void
  latest: Ref<HeartbeatPayload>
}

const HEARTBEAT_URL = '/api/records/heartbeat'

/**
 * 默认 Reporter（spec §7.1 扩展点2 默认实现）：
 * - heartbeat：fetch POST JSON
 * - beacon：navigator.sendBeacon(Blob type: application/json) → 失败/不可用 fallback fetch keepalive（spec §9）
 */
export function createDefaultReporter(): Reporter {
  return {
    async heartbeat(payload: HeartbeatPayload): Promise<void> {
      await fetch(HEARTBEAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    },
    beacon(payload: HeartbeatPayload): void {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(HEARTBEAT_URL, blob)
      ) {
        return
      }
      void fetch(HEARTBEAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {
        // 补报失败静默：服务端 MAX 幂等 + 下次全量快照覆盖自愈（spec §7.2 第 5 项）
      })
    }
  }
}

interface Baseline {
  played_sec: number
  position: number
  stay_sec: number
  finished: number
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function usePlayRecord(options: PlayRecordOptions): PlayRecordHandle {
  const interval = options.interval ?? 15000
  const reporter = options.reporter ?? createDefaultReporter()
  const source = options.source

  let baseline: Baseline = { played_sec: 0, position: 0, stay_sec: 0, finished: 0 }
  let staySessionMs = 0                    // 本次会话内可见期间累计墙钟 ms（hidden 冻结）
  let visibleSince: number | null = document.visibilityState === 'visible' ? Date.now() : null
  let timerId: ReturnType<typeof setInterval> | null = null
  let manualPaused = false
  let disposed = false

  const latest = ref<HeartbeatPayload>(makeSnapshot())

  function currentStaySessionMs(): number {
    return visibleSince === null ? staySessionMs : staySessionMs + (Date.now() - visibleSince)
  }

  /** 全量快照 = 历史基线（played/stay）+ 会话增量 + 采集源当前位置（spec §7.2 第 2 项） */
  function makeSnapshot(): HeartbeatPayload {
    const snap = source.getSnapshot()
    return {
      user_id: unref(options.userId),
      content_id: unref(options.contentId),
      played_sec: round3(baseline.played_sec + snap.playedDelta),
      position: snap.position,
      stay_sec: round3(baseline.stay_sec + currentStaySessionMs() / 1000),
      client_ts: Date.now()
    }
  }

  function emitAndReport(channel: 'heartbeat' | 'beacon'): void {
    const payload = makeSnapshot()
    latest.value = payload
    if (channel === 'heartbeat') {
      reporter.heartbeat(payload).catch(() => {
        // 心跳失败静默、不重试（spec §7.2 第 5 项）
      })
    } else {
      reporter.beacon(payload)
    }
    options.onReport?.(payload)
  }

  function startTimer(): void {
    if (disposed || manualPaused || timerId !== null) return
    if (document.visibilityState !== 'visible') return  // hidden 期间不启动（由 visible 事件重启）
    timerId = setInterval(() => emitAndReport('heartbeat'), interval)
  }

  function stopTimer(): void {
    if (timerId !== null) {
      clearInterval(timerId)
      timerId = null
    }
  }

  /** 历史基线（spec §7.2 第 1 项）：挂载时 GET /api/records/:contentId */
  async function loadBaseline(): Promise<void> {
    const url = `/api/records/${encodeURIComponent(unref(options.contentId))}?user_id=${encodeURIComponent(unref(options.userId))}`
    try {
      const res = await fetch(url)
      if (!res.ok) return
      const data = (await res.json()) as Partial<Baseline>
      baseline = {
        played_sec: data.played_sec ?? 0,
        position: data.position ?? 0,
        stay_sec: data.stay_sec ?? 0,
        finished: data.finished ?? 0
      }
      latest.value = makeSnapshot()   // 基线落定后刷新 latest（spec §7.2 第 6 项：latest 为当前快照，供反显）
    } catch {
      // 基线拉取失败按 0 基线继续：全量快照口径下服务端 MAX 保护兜底
    }
  }

  /** 退出矩阵（spec §7.2 第 4 项，全部事件驱动、不由定时器触发） */
  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      visibleSince = Date.now()            // 停留时钟继续
      startTimer()                         // 重启 interval
    } else {
      staySessionMs = currentStaySessionMs() // 冻结停留时钟
      visibleSince = null
      stopTimer()                          // 停 interval
      emitAndReport('beacon')              // beacon 补报最后快照
    }
  }

  function onPageExit(): void {
    emitAndReport('beacon')                // pagehide / beforeunload（iOS 企业微信 WebView 关键路径）
  }

  onBeforeUnmount(() => {
    if (disposed) return
    emitAndReport('beacon')                // 路由跳转补报（默认实现 sendBeacon→fetch keepalive fallback）
    disposed = true
    stopTimer()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageExit)
    window.removeEventListener('beforeunload', onPageExit)
  })

  void loadBaseline()
  startTimer()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageExit)
  window.addEventListener('beforeunload', onPageExit)

  return {
    pause() {
      manualPaused = true
      stopTimer()
    },
    resume() {
      manualPaused = false
      startTimer()
    },
    reportNow() {
      if (!disposed) emitAndReport('heartbeat')   // 供视频 ended 事件调用（spec §7.2 第 6 项）
    },
    latest
  }
}
```

> **Task 4 修正记录（2026-09-23 评审回写）**：计划原文实现 + 原文测试实测 11/12——`latest 暴露当前快照` 用例在基线 GET 落定后拿到的仍是构造时零基线旧快照（原 `latest` 仅在 `emitAndReport` 时更新）；已在 `loadBaseline` 基线赋值后补 `latest.value = makeSnapshot()` 一行，对齐 spec §7.2 第 6 项「latest=当前快照」，与 commit `6d2c0fe` 一致，该行不触发上报、不调 onReport、不影响其余 11 用例。

- [ ] 4.5 运行测试，确认通过

```bash
npx vitest run src/hooks/__tests__/usePlayRecord.test.ts
```

预期输出末行：`Test Files  1 passed (1)` / `Tests  12 passed (12)`

- [ ] 4.6 提交

```bash
git add -A
git commit -m "feat(hooks): usePlayRecord 核心 hook（心跳调度/基线合并/停留时钟/退出矩阵四事件/默认 Reporter，含 vitest 单测）"
```

---

## Task 5：采集适配器（videoSource / articleSource）

**依赖**：Task 4（`DisposablePlaySource` 类型定义于 `usePlayRecord.ts`，本任务逐字复用）
**Files:**
- Create: `src/hooks/sources/videoSource.ts`、`src/hooks/sources/articleSource.ts`、`src/hooks/__tests__/videoSource.test.ts`、`src/hooks/__tests__/articleSource.test.ts`
- Test: `src/hooks/__tests__/videoSource.test.ts`、`src/hooks/__tests__/articleSource.test.ts`

### 步骤

- [ ] 5.1 写失败测试 `src/hooks/__tests__/videoSource.test.ts`

```ts
/**
 * 功能说明：videoSource 采集适配器单测
 *   - timeupdate 差值累加为 playedDelta；position 取 currentTime
 *   - 差值 ≥ 1s 的 seek 跳变不计入播放时长；负差值（回拖）不计入
 *   - 2x 倍速下正常差值（约 0.5s）正常计入
 *   - destroy 移除 timeupdate 监听，之后不再累计
 * 运行命令：npx vitest run src/hooks/__tests__/videoSource.test.ts
 * 前置条件：无需真实播放器与后端；video.js Player 以测试替身注入
 */
import { describe, expect, it, vi } from 'vitest'
import { videoSource } from '../sources/videoSource'

type Handler = () => void

interface FakePlayer {
  currentTime: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  __setTime: (seconds: number) => void
}

function makeFakePlayer(): FakePlayer {
  let t = 0
  const handlers: Record<string, Handler[]> = {}
  return {
    currentTime: vi.fn(() => t),
    on: vi.fn((event: string, handler: Handler) => {
      handlers[event] = handlers[event] || []
      handlers[event].push(handler)
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers[event] = (handlers[event] || []).filter((h) => h !== handler)
    }),
    __setTime(seconds: number) {
      t = seconds
      ;(handlers.timeupdate || []).slice().forEach((h) => h())
    }
  }
}

describe('videoSource', () => {
  it('正常播放序列：差值累加为 playedDelta，position 为当前 currentTime', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.25)
    player.__setTime(0.5)
    player.__setTime(1.0)
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.75, position: 1.0 })
  })

  it('seek 跳变：差值 ≥ 1s 不计入播放时长，position 跟随最新位置', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.25)
    player.__setTime(30)      // 前跳 29.75s：seek，不计
    player.__setTime(30.25)
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.5, position: 30.25 })
  })

  it('回拖：负差值不计入（同属 seek 语义）', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(10)
    player.__setTime(5)       // 回拖 -5s：不计
    player.__setTime(5.25)
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.25, position: 5.25 })
  })

  it('2x 倍速：正常差值约 0.5s，计入不受 seek 过滤影响', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.5)
    player.__setTime(1.0)
    player.__setTime(1.5)
    expect(source.getSnapshot()).toEqual({ playedDelta: 1.5, position: 1.5 })
  })

  it('destroy：移除 timeupdate 监听，之后不再累计', () => {
    const player = makeFakePlayer()
    const source = videoSource(player as never)
    player.__setTime(0)
    player.__setTime(0.5)
    source.destroy()
    expect(player.off).toHaveBeenCalledWith('timeupdate', expect.any(Function))
    player.__setTime(1.5)     // 监听已移除
    expect(source.getSnapshot()).toEqual({ playedDelta: 0.5, position: 0.5 })
  })
})
```

- [ ] 5.2 运行测试，确认失败

```bash
npx vitest run src/hooks/__tests__/videoSource.test.ts
```

预期输出（红灯特征）：`Error: Failed to resolve import "../sources/videoSource"`，`Tests  5 failed`

- [ ] 5.3 实现 `src/hooks/sources/videoSource.ts`

```ts
import videojs from 'video.js'
import type { DisposablePlaySource } from '../usePlayRecord'

/** video.js Player 类型（经默认导出推导，规避 dist/types 子路径导出差异） */
export type VideoJsPlayer = ReturnType<typeof videojs>

/**
 * video.js 采集适配器（spec §7.3）：
 * - player.on('timeupdate') 监听、player.currentTime() 取值
 * - 相邻两次 currentTime 差值累加为 playedDelta
 * - 差值 ≥ 1 秒判定为 seek 拖动不计入；负差值（回拖）同属 seek 不计入；
 *   2x 倍速下 timeupdate 正常差值约 0.5s 不受影响（防拖动/倍速虚增）
 * - position = player.currentTime()
 * - PlaySource 接口签名不变：播放器实现可替换，hook 与服务端零改动
 */
export function videoSource(player: VideoJsPlayer): DisposablePlaySource {
  let playedDelta = 0
  let position = 0
  let lastTime: number | null = null

  const onTimeUpdate = (): void => {
    const t = player.currentTime()
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
```

- [ ] 5.4 运行测试，确认通过

```bash
npx vitest run src/hooks/__tests__/videoSource.test.ts
```

预期输出末行：`Tests  5 passed (5)`

- [ ] 5.5 提交

```bash
git add -A
git commit -m "feat(hooks): videoSource 采集适配器（timeupdate 差值累加、seek ≥1s/回拖不计入，含单测）"
```

- [ ] 5.6 写失败测试 `src/hooks/__tests__/articleSource.test.ts`

```ts
/**
 * 功能说明：articleSource 滚动采集适配器单测
 *   - 百分比换算：已滚动高度 / (总高度 - 视口高度) × 100，向下取整、收敛 0-100
 *   - 节流约 200ms：窗口内首次立即计算，尾沿定时器补最新位置（最后一段滚动不丢）
 *   - playedDelta 恒 0；不可滚动容器（分母 ≤ 0）position = 100
 *   - destroy 移除 scroll 监听并清理尾沿定时器
 * 运行命令：npx vitest run src/hooks/__tests__/articleSource.test.ts
 * 前置条件：无需 DOM 与后端；滚动容器以测试替身注入；vi.useFakeTimers 同时控制 Date.now 与 setTimeout
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { articleSource, type ArticleScrollTarget } from '../sources/articleSource'

interface FakeContainer {
  container: ArticleScrollTarget
  fire: () => void
}

function makeFakeContainer(
  init: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}
): FakeContainer {
  const state = {
    scrollTop: init.scrollTop ?? 0,
    scrollHeight: init.scrollHeight ?? 1000,
    clientHeight: init.clientHeight ?? 500
  }
  const listeners: Array<() => void> = []
  const container: ArticleScrollTarget = {
    get scrollTop() {
      return state.scrollTop
    },
    set scrollTop(v: number) {
      state.scrollTop = v
    },
    get scrollHeight() {
      return state.scrollHeight
    },
    get clientHeight() {
      return state.clientHeight
    },
    addEventListener(_type: 'scroll', listener: () => void) {
      listeners.push(listener)
    },
    removeEventListener(_type: 'scroll', listener: () => void) {
      const i = listeners.indexOf(listener)
      if (i >= 0) listeners.splice(i, 1)
    }
  }
  return { container, fire: () => listeners.slice().forEach((l) => l()) }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('articleSource', () => {
  it('百分比换算：向下取整；playedDelta 恒 0', () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)
    container.scrollTop = 100     // 100 / (1000-500) = 20%
    fire()
    expect(source.getSnapshot()).toEqual({ playedDelta: 0, position: 20 })
    container.scrollTop = 249.99  // 49.998% → 49
    fire()
    expect(source.getSnapshot().position).toBe(49)
  })

  it('收敛到 0-100：到底为 100，负偏移钳到 0', () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)
    container.scrollTop = 500
    fire()
    expect(source.getSnapshot().position).toBe(100)
    container.scrollTop = -20
    fire()
    expect(source.getSnapshot().position).toBe(0)
  })

  it('节流 200ms：窗口内首次立即生效，尾沿定时器补最新位置', async () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)

    container.scrollTop = 100     // t0：立即计算 → 20%
    fire()
    expect(source.getSnapshot().position).toBe(20)

    container.scrollTop = 250     // t0+100ms：窗口内，暂不生效
    await vi.advanceTimersByTimeAsync(100)
    fire()
    expect(source.getSnapshot().position).toBe(20)

    await vi.advanceTimersByTimeAsync(100)   // 尾沿触发：补最新位置 50%
    expect(source.getSnapshot().position).toBe(50)
  })

  it('不可滚动容器（scrollHeight ≤ clientHeight）：position = 100', () => {
    const { container, fire } = makeFakeContainer({ scrollHeight: 500, clientHeight: 500 })
    const source = articleSource(container)
    fire()
    expect(source.getSnapshot().position).toBe(100)
  })

  it('destroy：移除监听并清理未触发的尾沿定时器', async () => {
    const { container, fire } = makeFakeContainer()
    const source = articleSource(container)

    container.scrollTop = 100
    fire()
    container.scrollTop = 250
    await vi.advanceTimersByTimeAsync(100)
    fire()                        // 进入 pending（尾沿定时器挂起）

    source.destroy()
    await vi.advanceTimersByTimeAsync(200)
    expect(source.getSnapshot().position).toBe(20)   // 尾沿已清理

    container.scrollTop = 400
    fire()                        // 监听已移除
    expect(source.getSnapshot().position).toBe(20)
  })
})
```

- [ ] 5.7 运行测试，确认失败

```bash
npx vitest run src/hooks/__tests__/articleSource.test.ts
```

预期输出（红灯特征）：`Error: Failed to resolve import "../sources/articleSource"`，`Tests  5 failed`

- [ ] 5.8 实现 `src/hooks/sources/articleSource.ts`

```ts
import type { DisposablePlaySource } from '../usePlayRecord'

/** 滚动容器最小接口（任意可滚动元素，便于测试替身注入） */
export interface ArticleScrollTarget {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  addEventListener(type: 'scroll', listener: () => void, options?: { passive?: boolean }): void
  removeEventListener(type: 'scroll', listener: () => void): void
}

/**
 * 图文滚动采集适配器（spec §7.3）：
 * - 滚动事件节流约 200ms（首沿立即 + 尾沿补发，最后一段滚动位置不丢）
 * - position = 已滚动高度 / (总高度 - 视口高度) × 100，向下取整并收敛到 0-100
 * - playedDelta 恒 0
 * - 容器不可滚动（分母 ≤ 0）时 position = 100（一屏全文可见 = 已读到文末）
 */
export function articleSource(scrollContainer: ArticleScrollTarget, throttleMs = 200): DisposablePlaySource {
  let position = 0
  let lastEmit = 0
  let pending = false
  let timerId: ReturnType<typeof setTimeout> | null = null

  function compute(): void {
    const scrollable = scrollContainer.scrollHeight - scrollContainer.clientHeight
    if (scrollable <= 0) {
      position = 100
      return
    }
    const ratio = scrollContainer.scrollTop / scrollable
    position = Math.max(0, Math.min(100, Math.floor(ratio * 100)))
  }

  const onScroll = (): void => {
    const now = Date.now()
    if (now - lastEmit >= throttleMs) {
      lastEmit = now
      compute()
      return
    }
    if (!pending) {
      pending = true
      const delay = throttleMs - (now - lastEmit)
      timerId = setTimeout(() => {
        pending = false
        lastEmit = Date.now()
        compute()
      }, delay)
    }
  }

  scrollContainer.addEventListener('scroll', onScroll, { passive: true })

  return {
    getSnapshot: () => ({ playedDelta: 0, position }),
    destroy: () => {
      if (timerId !== null) clearTimeout(timerId)
      scrollContainer.removeEventListener('scroll', onScroll)
    }
  }
}
```

- [ ] 5.9 运行两个适配器测试，确认通过

```bash
npx vitest run src/hooks/__tests__/videoSource.test.ts src/hooks/__tests__/articleSource.test.ts
```

预期输出末行：`Test Files  2 passed (2)` / `Tests  10 passed (10)`

- [ ] 5.10 提交

```bash
git add -A
git commit -m "feat(hooks): articleSource 滚动采集适配器（200ms 节流、百分比 0-100 向下取整，含单测）"
```

---

## Task 6：前端页面（api 封装 / 列表三态 / 详情二态）

**依赖**：Task 4、Task 5（`usePlayRecord` / `videoSource` / `articleSource` / `DisposablePlaySource` / `VideoJsPlayer` 签名逐字复用）
**Files:**
- Create: `src/api/record.ts`、`src/views/__tests__/List.test.ts`、`src/views/__tests__/Detail.test.ts`
- Modify: `src/views/List.vue`（Task 1 占位重写）、`src/views/Detail.vue`（Task 1 占位重写）
- Test: `src/views/__tests__/List.test.ts`、`src/views/__tests__/Detail.test.ts`

### 步骤

- [ ] 6.1 创建 `src/api/record.ts`（后端三接口的 TS 封装；类型与 Task 3 响应结构一致）

```ts
import type { HeartbeatPayload } from '../hooks/usePlayRecord'

/** GET /api/records/:contentId 响应（spec §6.2；空记录为零值默认） */
export interface PlayRecordResponse {
  content_id: string
  played_sec: number
  position: number
  stay_sec: number
  finished: 0 | 1
  updated_at: string
}

/** GET /api/contents 响应 content 项（spec §6.3 + 超集字段 video_url/article_html，见全局约定 #1） */
export interface ContentSummary {
  id: string
  type: 'video' | 'article'
  title: string
  duration_sec: number | null
  video_url: string | null
  article_html: string | null
}

export interface RecordSummary {
  played_sec: number
  position: number
  stay_sec: number
  finished: 0 | 1
}

export interface ContentListItem {
  content: ContentSummary
  record: RecordSummary
  status: 'not_started' | 'continue' | 'finished'
}

export async function getRecord(contentId: string, userId: string): Promise<PlayRecordResponse> {
  const res = await fetch(`/api/records/${encodeURIComponent(contentId)}?user_id=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`getRecord failed: ${res.status}`)
  return (await res.json()) as PlayRecordResponse
}

export async function getContents(userId: string): Promise<ContentListItem[]> {
  const res = await fetch(`/api/contents?user_id=${encodeURIComponent(userId)}`)
  if (!res.ok) throw new Error(`getContents failed: ${res.status}`)
  return (await res.json()) as ContentListItem[]
}

/** 三接口封装完整性保留：供自定义 Reporter 或脚本复用（默认 Reporter 内联 fetch，见全局约定 #6） */
export async function postHeartbeat(payload: HeartbeatPayload): Promise<void> {
  const res = await fetch('/api/records/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`postHeartbeat failed: ${res.status}`)
}
```

- [ ] 6.2 写失败测试 `src/views/__tests__/List.test.ts`

```ts
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
import { nextTick } from 'vue'
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
    await nextTick()
    await nextTick()
    expect(router.currentRoute.value.fullPath).toBe('/detail/video-7092?userid=u7')

    const second = await mountList('/list')
    await second.wrapper.findAll('.van-cell')[1].trigger('click')
    await nextTick()
    await nextTick()
    expect(second.router.currentRoute.value.fullPath).toBe('/detail/article-001?userid=guest')
  })
})
```

- [ ] 6.3 运行测试，确认失败

```bash
npx vitest run src/views/__tests__/List.test.ts
```

预期输出（红灯特征）：副标题断言失败（占位组件只有「列表加载中」），如 `expected '列表加载中' to be '已播 48% · 续播位置 30s'`；`Tests  3 failed`

- [ ] 6.4 实现 `src/views/List.vue`（完整重写 Task 1 占位）

```vue
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
```

- [ ] 6.5 运行测试，确认通过

```bash
npx vitest run src/views/__tests__/List.test.ts
```

预期输出末行：`Tests  3 passed (3)`

- [ ] 6.6 提交

```bash
git add -A
git commit -m "feat(views): 列表页三态渲染（Vant Cell+Tag 灰/蓝/绿）与 userid 透传跳转，含组件测试"
```

- [ ] 6.7 写失败测试 `src/views/__tests__/Detail.test.ts`

```ts
/**
 * 功能说明：Detail.vue 详情页组件测试（video / article 二态）
 *   - video：videojs 以 controls + playbackRates [0.5,1,1.25,1.5,2] + mp4 source 初始化；
 *     ready 后 currentTime(服务端 position) 续播反显；ended 触发 reportNow（POST heartbeat）；
 *     unmount 时 player.dispose 被调用
 *   - article：v-html 渲染正文；进入页面按服务端 position 百分比定位滚动容器
 * 运行命令：npx vitest run src/views/__tests__/Detail.test.ts
 * 前置条件：无需起后端；api/record 与 video.js 均为 mock；fetch 以 stub 提供 hook 基线；
 *   article 用例通过覆写 HTMLElement.prototype 的 scrollHeight/clientHeight 提供布局尺寸
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import Vant from 'vant'
import Detail from '../Detail.vue'

const { fakePlayer, videojsFactory } = vi.hoisted(() => {
  const fakePlayer = {
    currentTime: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    ready: vi.fn(),
    dispose: vi.fn()
  }
  return { fakePlayer, videojsFactory: vi.fn(() => fakePlayer) }
})

const { getContentsMock, getRecordMock } = vi.hoisted(() => ({
  getContentsMock: vi.fn(),
  getRecordMock: vi.fn()
}))

vi.mock('video.js', () => ({ default: videojsFactory }))
vi.mock('../../api/record', () => ({
  getContents: getContentsMock,
  getRecord: getRecordMock,
  postHeartbeat: vi.fn()
}))

const VIDEO_CONTENT = {
  id: 'video-7092',
  type: 'video',
  title: '企业微信培训视频',
  duration_sec: 61.486,
  video_url: '/source/7092_1790088875.mp4',
  article_html: null
} as const

const ARTICLE_CONTENT = {
  id: 'article-001',
  type: 'article',
  title: '图文：心跳上报机制说明',
  duration_sec: null,
  video_url: null,
  article_html: '<h2>标题</h2><p>正文段落</p>'
} as const

let router: Router
let wrapper: VueWrapper | null = null
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ content_id: 'c', played_sec: 0, position: 0, stay_sec: 0, finished: 0, updated_at: '' })
  }))
  vi.stubGlobal('fetch', fetchMock)
  fakePlayer.currentTime.mockReset()
  fakePlayer.on.mockReset()
  fakePlayer.off.mockReset()
  fakePlayer.ready.mockReset()
  fakePlayer.dispose.mockReset()
  videojsFactory.mockClear()
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/list', component: { template: '<div />' } },
      { path: '/detail/:id', component: { template: '<div />' } }
    ]
  })
})

afterEach(() => {
  if (wrapper) {
    wrapper.unmount()
    wrapper = null
  }
  vi.unstubAllGlobals()
})

async function mountDetail(path: string): Promise<VueWrapper> {
  await router.push(path)
  await router.isReady()
  wrapper = mount(Detail, { global: { plugins: [router, Vant] } })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('Detail - video 形态', () => {
  beforeEach(() => {
    getContentsMock.mockResolvedValue([
      { content: VIDEO_CONTENT, record: { played_sec: 5, position: 30, stay_sec: 12, finished: 0 }, status: 'continue' }
    ])
    getRecordMock.mockResolvedValue({
      content_id: 'video-7092',
      played_sec: 5,
      position: 30,
      stay_sec: 12,
      finished: 0,
      updated_at: ''
    })
  })

  it('videojs 初始化：controls + playbackRates [0.5,1,1.25,1.5,2] + mp4 source', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    expect(videojsFactory).toHaveBeenCalledTimes(1)
    const options = videojsFactory.mock.calls[0][1] as {
      controls: boolean
      playbackRates: number[]
      sources: Array<{ src: string; type: string }>
    }
    expect(options.controls).toBe(true)
    expect(options.playbackRates).toEqual([0.5, 1, 1.25, 1.5, 2])
    expect(options.sources).toEqual([{ src: '/source/7092_1790088875.mp4', type: 'video/mp4' }])
  })

  it('续播反显：player ready 后 currentTime(服务端 position)', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    const readyCallback = fakePlayer.ready.mock.calls[0][0] as () => void
    readyCallback()
    expect(fakePlayer.currentTime).toHaveBeenCalledWith(30)
  })

  it('ended 事件：reportNow 立即上报（POST /api/records/heartbeat，user_id/content_id 正确）', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    const endedCallback = fakePlayer.on.mock.calls.find((c) => c[0] === 'ended')![1] as () => void
    endedCallback()
    await flushPromises()
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/records/heartbeat')
    expect(call).toBeDefined()
    const init = call![1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ user_id: 'u9', content_id: 'video-7092' })
  })

  it('unmount：player.dispose 被调用（与 usePlayRecord 清理联动）', async () => {
    await mountDetail('/detail/video-7092?userid=u9')
    wrapper!.unmount()
    wrapper = null
    expect(fakePlayer.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('Detail - article 形态', () => {
  beforeEach(() => {
    getContentsMock.mockResolvedValue([
      { content: ARTICLE_CONTENT, record: { played_sec: 0, position: 60, stay_sec: 50, finished: 0 }, status: 'continue' }
    ])
    getRecordMock.mockResolvedValue({
      content_id: 'article-001',
      played_sec: 0,
      position: 60,
      stay_sec: 50,
      finished: 0,
      updated_at: ''
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 500 })
  })

  it('渲染 article_html 并按服务端 position 百分比定位滚动容器', async () => {
    await mountDetail('/detail/article-001?userid=u9')
    const box = wrapper!.find('.article-box').element as HTMLDivElement
    expect(box.innerHTML).toContain('正文段落')
    expect(box.scrollTop).toBe(300)    // 60% × (1000 - 500)
  })
})
```

- [ ] 6.8 运行测试，确认失败

```bash
npx vitest run src/views/__tests__/Detail.test.ts
```

预期输出（红灯特征）：占位组件无 `.article-box`，`wrapper.find('.article-box')` 断言 `expected '' to contain '.article-box'` 类失败；`Tests  5 failed`

- [ ] 6.9 实现 `src/views/Detail.vue`（完整重写 Task 1 占位）

```vue
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
```

- [ ] 6.10 运行测试，确认通过

```bash
npx vitest run src/views/__tests__/Detail.test.ts
```

预期输出末行：`Tests  5 passed (5)`

- [ ] 6.11 全量单测 + 类型检查回归

```bash
npm run test:unit
npx vue-tsc --noEmit
```

预期输出：vitest `Tests  30 passed (30)`（hook 12 + videoSource 5 + articleSource 5 + List 3 + Detail 5）；vue-tsc 无输出（0 error）

- [ ] 6.12 手工验收（起服务，浏览器访问）

```bash
npm run dev > /tmp/dev.log 2>&1 &
sleep 5
curl -s "http://localhost:3000/api/contents?user_id=guest" | head -c 120
lsof -ti:3000 -ti:5173 | xargs kill
```

预期输出：contents JSON 前 120 字符含 `"id":"video-7092"`。随后可人工打开 `http://localhost:5173/list?userid=guest` 核对三态渲染、点击进入视频/图文详情（倍速菜单、续播位置）。

- [ ] 6.13 提交

```bash
git add -A
git commit -m "feat(views): 详情页 video.js 二态（playbackRates 倍速/ready 续播反显/ended 即时上报/dispose 联动）与图文滚动定位，含组件测试"
```

---

## Task 7：e2e（playwright，真实前后端 + 真实 sqlite）与冒烟脚本

**依赖**：Task 6（页面完整可用）
**Files:**
- Create: `playwright.config.ts`、`e2e/play-record.e2e.spec.ts`、`scripts/smoke.sh`
- Test: `e2e/play-record.e2e.spec.ts`、`scripts/smoke.sh`

### 步骤

- [ ] 7.1 创建 `playwright.config.ts`

说明两点口径：① `channel: 'chrome'`——Playwright 内置 Chromium 不含 H.264，无法播放 mp4 素材，e2e 走本机已装 Chrome（全局约定 #5，无 Chrome 的机器可改 `'msedge'`）；② 后端以独立库 `e2e/e2e.db` 启动（`DB_PATH` 环境变量，db.js 已支持），用例以每轮唯一 userid 隔离数据，脚本天然可重复执行。

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chrome'
  },
  webServer: [
    {
      command: 'npm run dev:server',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: false,
      env: { DB_PATH: 'e2e/e2e.db' }
    },
    {
      command: 'npm run dev:client',
      url: 'http://localhost:5173',
      reuseExistingServer: false
    }
  ]
})
```

- [ ] 7.2 创建 `e2e/play-record.e2e.spec.ts`（选择器基于 `.vjs-*`，spec §10.3）

```ts
/**
 * 功能说明：播放记录心跳系统 e2e（真实前后端 + 真实 sqlite 落库校验）
 *   - 心跳定时上报：播放 17s 后 sqlite 三指标（played_sec/position/stay_sec）均 > 0
 *   - 退出补报与心跳停止：visibilitychange hidden 触发 beacon 补报，hidden 期间无定时器上报；
 *     路由跳转（unmount）触发补报
 *   - 列表页三态渲染（not_started/continue/finished）
 *   - 详情页续播反显（ready 后 currentTime = 服务端 position）
 *   - video.js 渲染（.vjs-play-button / .vjs-playback-rate 控制条元素存在）
 * 运行命令：npm run test:e2e
 * 前置条件：无需手动起服务（webServer 自动拉起 dev:server/dev:client，独立库 e2e/e2e.db）；
 *   需本机安装 Google Chrome（内置 Chromium 无 H.264 无法播放 mp4）；运行前停掉手工 dev 进程
 */
import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'

const E2E_DB = 'e2e/e2e.db'
const VIDEO_ID = 'video-7092'
const ts = Date.now()

interface PlayRow {
  played_sec: number
  position: number
  stay_sec: number
  finished: number
  updated_at: string
}

function readRecord(userId: string, contentId: string): PlayRow | undefined {
  const db = new Database(E2E_DB)
  try {
    return db
      .prepare('SELECT played_sec, position, stay_sec, finished, updated_at FROM play_records WHERE user_id = ? AND content_id = ?')
      .get(userId, contentId) as PlayRow | undefined
  } finally {
    db.close()
  }
}

async function seedRecordViaApi(userId: string, body: Record<string, number | string>): Promise<void> {
  const res = await fetch('http://localhost:3000/api/records/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, content_id: VIDEO_ID, client_ts: Date.now(), ...body })
  })
  expect(res.ok).toBeTruthy()
}

test('心跳定时上报：播放数秒后 sqlite 三指标增长', async ({ page }) => {
  const user = `e2e-hb-${ts}`
  await page.goto(`/detail/${VIDEO_ID}?userid=${user}`)
  await page.click('.vjs-big-play-button')
  await page.waitForTimeout(17000)   // 心跳默认 15s 一跳
  const rec = readRecord(user, VIDEO_ID)
  expect(rec).toBeDefined()
  expect(rec!.played_sec).toBeGreaterThan(0)
  expect(rec!.position).toBeGreaterThan(0)
  expect(rec!.stay_sec).toBeGreaterThan(0)
})

test('退出补报（hidden）：beacon 补报发生，且 hidden 期间无任何定时器上报', async ({ page }) => {
  const user = `e2e-hidden-${ts}`
  await page.goto(`/detail/${VIDEO_ID}?userid=${user}`)
  await page.click('.vjs-big-play-button')
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(500)
  const rec = readRecord(user, VIDEO_ID)
  expect(rec).toBeDefined()                 // beacon 补报已落库
  expect(rec!.played_sec).toBeGreaterThan(0)

  const updated = rec!.updated_at
  const played = rec!.played_sec
  await page.waitForTimeout(5000)           // hidden 期间：心跳停止、停留冻结
  const rec2 = readRecord(user, VIDEO_ID)
  expect(rec2!.updated_at).toBe(updated)    // 无新上报
  expect(rec2!.played_sec).toBe(played)
})

test('退出补报（路由跳转）：详情页返回列表触发补报', async ({ page }) => {
  const user = `e2e-route-${ts}`
  await page.goto(`/list?userid=${user}`)
  await page.click('.van-cell')             // 第一条即 video-7092（created_at 排序）
  await page.waitForSelector('.video-js')
  await page.click('.vjs-big-play-button')
  await page.waitForTimeout(3000)
  await page.click('.van-nav-bar__left')    // 返回 → unmount → 补报
  await page.waitForSelector('.van-cell')
  await page.waitForTimeout(500)
  const rec = readRecord(user, VIDEO_ID)
  expect(rec).toBeDefined()
  expect(rec!.played_sec).toBeGreaterThan(0)
})

test('列表三态渲染：not_started / continue / finished', async ({ page }) => {
  const fresh = `e2e-fresh-${ts}`
  const mid = `e2e-mid-${ts}`
  const done = `e2e-done-${ts}`
  await seedRecordViaApi(mid, { played_sec: 10, position: 10, stay_sec: 12 })
  await seedRecordViaApi(done, { played_sec: 61, position: 61.486, stay_sec: 70 })

  await page.goto(`/list?userid=${fresh}`)
  await expect(page.locator('.van-tag').first()).toContainText('未开始')
  expect(await page.locator('.van-tag').first().getAttribute('class')).toContain('van-tag--default')

  await page.goto(`/list?userid=${mid}`)
  await expect(page.locator('.van-tag').first()).toContainText('继续播放')
  expect(await page.locator('.van-tag').first().getAttribute('class')).toContain('van-tag--primary')

  await page.goto(`/list?userid=${done}`)
  await expect(page.locator('.van-tag').first()).toContainText('已播完')
  expect(await page.locator('.van-tag').first().getAttribute('class')).toContain('van-tag--success')
})

test('续播反显与 video.js 控制条（.vjs-play-button / .vjs-playback-rate）', async ({ page }) => {
  const user = `e2e-resume-${ts}`
  await seedRecordViaApi(user, { played_sec: 60, position: 61.486, stay_sec: 65 })

  await page.goto(`/detail/${VIDEO_ID}?userid=${user}`)
  await page.waitForTimeout(2500)           // player ready → currentTime(服务端 position)
  const currentTime = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)
  expect(currentTime).toBeGreaterThan(55)   // 服务端 position = 61.486

  await page.hover('.video-js')
  await expect(page.locator('.vjs-play-button')).toHaveCount(1)
  await expect(page.locator('.vjs-playback-rate')).toHaveCount(1)
})
```

- [ ] 7.3 运行 e2e（先确保 3000/5173 端口空闲）

```bash
lsof -ti:3000 -ti:5173 | xargs kill 2>/dev/null || true
npm run test:e2e
```

预期输出末行：`5 passed`（webServer 自动起停；若首跑报 Chrome 未找到，改 `channel: 'msedge'` 或安装 Chrome 后重跑）

- [ ] 7.4 创建 `scripts/smoke.sh`（幂等可重复执行，spec §10.4/§10.5）

```bash
#!/usr/bin/env bash
#
# 功能说明：后端三接口冒烟测试——heartbeat 上报（INSERT/幂等重发/乱序不回退）、
#   记录查询（MAX 保护 + position 覆盖 + 零值默认）、列表三态聚合。
#   全程使用固定用户 smoke-user（服务端幂等保证重复执行结果一致）与每轮唯一的
#   smoke-zero-$$ 用户验证零值默认，故脚本可重复执行、不因残留数据报错。
# 运行命令：bash scripts/smoke.sh   （或 npm run smoke）
# 前置条件：后端已启动（npm run dev:server，默认 http://localhost:3000，可用 BASE 环境变量覆盖）
#
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
USER_FIXED="smoke-user"
USER_ZERO="smoke-zero-$$"

check() {
  local json="$1" expr="$2" msg="$3"
  printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const j = JSON.parse(s);
  if (!eval(process.argv[1])) { console.error("FAIL: " + process.argv[2]); process.exit(1); }
});' "$expr" "$msg"
}

echo "[1/5] POST /api/records/heartbeat（首次 INSERT）"
R=$(curl -s -X POST "$BASE/api/records/heartbeat" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$USER_FIXED\",\"content_id\":\"video-7092\",\"played_sec\":12.5,\"position\":12.5,\"stay_sec\":15,\"client_ts\":1}")
check "$R" 'j.ok === true' 'heartbeat 应返回 ok:true'

echo "[2/5] 幂等重发：同一快照再发一次"
R=$(curl -s -X POST "$BASE/api/records/heartbeat" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$USER_FIXED\",\"content_id\":\"video-7092\",\"played_sec\":12.5,\"position\":12.5,\"stay_sec\":15,\"client_ts\":2}")
check "$R" 'j.ok === true' '重发应返回 ok:true'

echo "[3/5] 乱序不回退：旧快照后到"
R=$(curl -s -X POST "$BASE/api/records/heartbeat" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$USER_FIXED\",\"content_id\":\"video-7092\",\"played_sec\":3,\"position\":3,\"stay_sec\":4,\"client_ts\":3}")
check "$R" 'j.ok === true' '乱序上报应返回 ok:true'

echo "[4/5] GET /api/records/:contentId —— MAX 保护不回退、position 覆盖"
R=$(curl -s "$BASE/api/records/video-7092?user_id=$USER_FIXED")
check "$R" 'j.played_sec >= 12.5 && j.position === 3 && j.stay_sec >= 15' 'played/stay 取 MAX、position 以最后请求覆盖'

echo "[5/5] 零值默认与三态列表"
R=$(curl -s "$BASE/api/records/video-7092?user_id=$USER_ZERO")
check "$R" 'j.played_sec === 0 && j.position === 0 && j.stay_sec === 0 && j.finished === 0' '无记录返回零值默认（HTTP 200 不 404）'
R=$(curl -s "$BASE/api/contents?user_id=$USER_FIXED")
check "$R" 'Array.isArray(j) && j.length === 3 && j.some((i) => i.content.id === "video-7092" && i.status === "continue")' '列表聚合返回 3 条且 smoke-user 为 continue'

echo "SMOKE OK"
```

```bash
chmod +x scripts/smoke.sh
```

- [ ] 7.5 运行冒烟脚本（起后端 → 冒烟 → 重复执行一次验证幂等 → 停服）

```bash
npm run dev:server > /tmp/smoke-server.log 2>&1 &
sleep 2
npm run smoke
npm run smoke
lsof -ti:3000 | xargs kill
```

预期输出：两轮均以 `SMOKE OK` 结束（第二轮不因残留数据报错，即幂等验证通过）

- [ ] 7.6 提交

```bash
git add -A
git commit -m "test(e2e): playwright e2e（三指标落库/hidden 与路由跳转补报/三态/续播反显/.vjs-* 选择器）与 curl 幂等冒烟脚本"
```

---

## Task 8：测试资产归档（docs/testing 索引 + 头注释块核对 + 全量回归）

**依赖**：Task 2 ~ Task 7 全部完成
**Files:**
- Create: `docs/testing/README.md`
- Test: 全部既有测试文件（本任务只核对头注释块与索引，不改测试逻辑）

### 步骤

- [ ] 8.1 创建 `docs/testing/README.md`（spec §10.5 测试资产索引）

````markdown
# 测试资产索引

所有测试脚本与用例均为项目资产，随代码入库归档（spec §10.5）。任何人拿到仓库后，
按下表「执行命令」逐项复制粘贴即可二次执行；执行前先核对「前置条件」。

| # | 文件路径 | 测试类型 | 功能备注 | 执行命令 | 前置条件 | 预期结果 |
|---|---|---|---|---|---|---|
| 1 | `server/__tests__/db.test.js` | node:test 接口 | 建表成功（contents/play_records 按 spec §5）；种子 1 视频 + 2 图文；文件库重复初始化幂等 | `npm run test:server` | `npm install` 已执行；用例自建内存/临时库，不触碰 `data/app.db` | `# tests 3` / `# pass 3` / `# fail 0` |
| 2 | `server/__tests__/records.test.js` | node:test 接口 | heartbeat INSERT/UPDATE、MAX 幂等重发不变、乱序不回退、position 覆盖、视频/图文 95% 判完与永久性、空记录零值默认、必传 400、未知内容 404、contents 三态聚合、缺省 guest | `npm run test:server` | 同上；每个用例独立内存库 + 随机端口 | `# tests 14`（含 #1）/ `# pass 14` / `# fail 0` |
| 3 | `src/hooks/__tests__/usePlayRecord.test.ts` | vitest 单测 | 心跳节奏与「基线+增量」全量快照；退出矩阵四事件（hidden 停跳+beacon、visible 重启、pagehide/beforeunload beacon、unmount 补报+移除监听）；hidden 停留时钟冻结；心跳失败静默；pause/resume/reportNow；默认 Reporter 的 sendBeacon 与 fetch keepalive fallback | `npx vitest run src/hooks/__tests__/usePlayRecord.test.ts` | `npm install`；无需起后端（fetch stub） | `Tests  12 passed (12)` |
| 4 | `src/hooks/__tests__/videoSource.test.ts` | vitest 单测 | timeupdate 差值累加；差值 ≥1s seek 不计；负差值回拖不计；2x 倍速 0.5s 差值正常计入；destroy 移除监听 | `npx vitest run src/hooks/__tests__/videoSource.test.ts` | `npm install`；Player 为测试替身 | `Tests  5 passed (5)` |
| 5 | `src/hooks/__tests__/articleSource.test.ts` | vitest 单测 | 滚动百分比换算（向下取整、0-100 收敛）；200ms 节流首沿+尾沿；playedDelta 恒 0；不可滚动容器 position=100；destroy 清理 | `npx vitest run src/hooks/__tests__/articleSource.test.ts` | `npm install`；容器为测试替身；fake timers | `Tests  5 passed (5)` |
| 6 | `src/views/__tests__/List.test.ts` | vitest 组件 | Vant Cell+Tag 三态（default 灰/primary 蓝/success 绿）；副标题百分比文案；点击跳 `/detail/:id?userid=`（缺省 guest） | `npx vitest run src/views/__tests__/List.test.ts` | `npm install`；api/record 为 mock | `Tests  3 passed (3)` |
| 7 | `src/views/__tests__/Detail.test.ts` | vitest 组件 | video：videojs 初始化参数（playbackRates [0.5,1,1.25,1.5,2]）、ready 续播反显、ended 即时上报、unmount dispose；article：v-html 渲染与 position 百分比定位 | `npx vitest run src/views/__tests__/Detail.test.ts` | `npm install`；video.js 与 api/record 为 mock | `Tests  5 passed (5)` |
| 8 | `e2e/play-record.e2e.spec.ts` | playwright e2e | 真实前后端：播放 17s 三指标落库；hidden 补报且无定时器上报；路由跳转补报；列表三态；续播反显（currentTime=服务端 position）；.vjs-play-button/.vjs-playback-rate 存在 | `npm run test:e2e` | 本机已装 Google Chrome（config channel:'chrome'）；3000/5173 端口空闲（webServer 自动起停，独立库 e2e/e2e.db） | `5 passed` |
| 9 | `scripts/smoke.sh` | curl 冒烟 | 三接口串联：上报/幂等重发/乱序不回退/MAX+position 覆盖/零值默认/三态聚合；可重复执行 | `npm run smoke` | 后端已启动：`npm run dev:server` | 末行输出 `SMOKE OK`（重复执行同样通过） |

## 全量回归（一条龙）

```bash
npm run test:server && npm run test:unit && npm run test:e2e && npm run smoke
```

前置：`npm run dev:server` 保持运行（smoke 依赖；e2e 会自动管理自己的端口与独立库，
执行 e2e 前先停掉手工 dev 进程，结束后再重启 dev:server 跑 smoke）。

预期：server `# pass 14` → unit `Tests  30 passed (30)` → e2e `5 passed` → smoke `SMOKE OK`。
````

- [ ] 8.2 核对全部测试文件头注释块（三要素齐全：功能说明/运行命令/前置条件）

```bash
for f in server/__tests__/db.test.js server/__tests__/records.test.js \
  src/hooks/__tests__/usePlayRecord.test.ts src/hooks/__tests__/videoSource.test.ts \
  src/hooks/__tests__/articleSource.test.ts src/views/__tests__/List.test.ts \
  src/views/__tests__/Detail.test.ts e2e/play-record.e2e.spec.ts scripts/smoke.sh; do
  if grep -q '功能说明' "$f" && grep -q '运行命令' "$f" && grep -q '前置条件' "$f"; then
    echo "$f OK"
  else
    echo "$f MISSING"
  fi
done
```

预期输出：9 行，全部以 `OK` 结尾，无 `MISSING`

- [ ] 8.3 全量回归（spec §11 第 6/7 条验收）

```bash
npm run test:server && npm run test:unit
lsof -ti:3000 -ti:5173 | xargs kill 2>/dev/null || true
npm run test:e2e
npm run dev:server > /tmp/server.log 2>&1 &
sleep 2
npm run smoke
lsof -ti:3000 | xargs kill
```

预期输出依次出现：`# pass 14` → `Tests  30 passed (30)` → `5 passed` → `SMOKE OK`

- [ ] 8.4 提交

```bash
git add -A
git commit -m "docs(testing): 测试资产索引（9 项：路径/类型/功能备注/可复制命令/前置条件/预期结果）"
```

---

## 附录 A：spec 覆盖矩阵（spec 章节 → Task/步骤 映射）

| spec 章节 | 要求 | 落点 |
|---|---|---|
| §1 背景与需求 | 后端 2+1 接口 | Task 3 |
| §1 | 前端两页面（列表状态/详情视频+图文） | Task 6 |
| §1 | 三指标心跳落库 | Task 3 + Task 4 + Task 5 |
| §1 硬约束 1 | 退出上报不由心跳定时器触发 | Task 4（退出矩阵四事件，全部事件驱动） |
| §1 硬约束 2 | 独立 hook、可配置可扩展 | Task 4（PlaySource/Reporter 双扩展点 + interval/onReport 可配置） |
| §2 决策 1 | 退出即停定时器 + visibilitychange/pagehide + sendBeacon 补报 | Task 4 |
| §2 决策 2 | 全量快照 + 服务端幂等覆盖 + 失败静默自愈 | Task 3（MAX）+ Task 4（catch 静默） |
| §2 决策 3 | 第 3 接口列表聚合 | Task 3 |
| §2 决策 4 | query userid 缺省 guest | Task 3（服务端缺省）+ Task 6（前端读取透传） |
| §2 决策 5 | 服务端判播完 95%、finished 永久 | Task 3 |
| §2 决策 6 | 图文共用 hook 与记录表 | Task 2（同表）+ Task 5（articleSource）+ Task 6 |
| §2 决策 7 | 倍速双指标（内容时间 vs 墙钟） | Task 5（currentTime 差值累加）+ Task 4（停留墙钟） |
| §2 决策 8 | 暂停不停心跳、停留继续、播放停止 | Task 4（interval 与播放状态解耦）+ Task 5（timeupdate 停则增量停） |
| §3 | 方案 A：单 hook 内聚 + 可插拔采集源 | Task 4 架构 + Task 5 内置两适配器 |
| §4 工程结构 | 单仓库结构/better-sqlite3/video.js/proxy/scripts | Task 1（结构/脚本/代理）+ Task 2 + 依赖矩阵 |
| §5.1 | contents 表字段级 + 种子 1 视频 2 图文 | Task 2 |
| §5.2 | play_records 表 + UNIQUE(user_id, content_id) | Task 2 |
| §6.1 | heartbeat 端点/body/写库四规则/响应/通道复用 | Task 3（+ Task 4 默认 Reporter Blob application/json） |
| §6.2 | GET records 零值默认不 404 | Task 3 |
| §6.3 | GET contents 三态聚合 | Task 3（+ 超集字段，全局约定 #1） |
| §7.1 | PlayRecordOptions/PlaySource/Reporter 签名 | Task 4（逐字一致） |
| §7.2 | hook 内部职责六项（基线/调度/停留时钟/退出矩阵/失败静默/返回值） | Task 4 |
| §7.3 | videoSource（差值累加、≥1s seek 不计）与 articleSource（节流/百分比） | Task 5 |
| §8.1 | 列表页 Vant Cell+Tag 三态/副标题/跳转 | Task 6 |
| §8.2 | 详情页 video.js（playbackRates/ready 续播/dispose 联动/ended）与 article（滚动定位） | Task 6 |
| §8.3 | userid 读取 | Task 6 |
| §9 | 心跳失败静默/beacon 补报/sendBeacon fallback/MAX 防回退/position 拖回如实覆盖/hidden 冻结 | Task 3 + Task 4 |
| §10.1 | 后端接口测试（node:test） | Task 2 + Task 3 |
| §10.2 | hook 单测（vitest + fake timers + test-utils） | Task 4 + Task 5 |
| §10.3 | e2e（真实前后端、sqlite 校验、.vjs-* 选择器） | Task 7 |
| §10.4 | 冒烟脚本幂等 | Task 7 |
| §10.5 | 测试资产归档 + 索引 + 头注释块 | Task 8（全部测试文件头注释块随 Task 2-7 落地） |
| §11 验收 1-7 | 全部验收项 | Task 3/6/4/4/2-7/7/8 |

## 附录 B：任务依赖图

```
Task 1 脚手架
  └─ Task 2 数据层
       └─ Task 3 后端三接口
            └─ Task 6 前端页面 ─┐
Task 4 核心 hook ──────────────┤
  └─ Task 5 采集适配器 ─────────┘
                               └─ Task 7 e2e + 冒烟
                                    └─ Task 8 测试资产归档
```
