# 功能清单与完整测试说明

- 日期：2026-09-23
- 适用仓库：`express-vue3-vant`（分支 mai）
- 文档性质：以仓库实际代码与测试为准的功能清单 + 测试执行手册。功能条目均给出实现文件与验证方式（编号供全文互相引用）；测试章节所有命令可直接复制执行。
- 场景行为说明：docs/scenarios-heartbeat.md（七大场景的时间线/字段公式/落库/验证）

---

## 第一部分：功能清单

### A 后端接口（`server/routes/records.js` + `server/store.js`）

> 心跳上报按写库规则细节拆为 A1-A3 三条。

| 编号 | 功能 | 一句话说明 | 实现位置（文件） | 验证方式（对应测试/接口） |
|------|------|------------|------------------|---------------------------|
| A1 | 心跳上报写入口 | `POST /api/records/heartbeat`，心跳与退出补报共用的唯一写入口；5 个必传字段缺任一返回 400，未知 `content_id` 返回 404 | `server/routes/records.js` | `server/__tests__/records.test.js`（必传 400、未知内容 404）；`scripts/smoke.sh` |
| A2 | 写库规则：MAX 幂等 / 乱序不回退 | `played_sec`、`stay_sec` 取 `MAX(库中旧值, 请求新值)`，重复、乱序、弱网重放均不回退 | `server/store.js`（`upsertRecord`） | `records.test.js`（MAX 幂等重发不变、乱序不回退）；smoke `[2/5]` `[3/5]` |
| A3 | 写库规则：position 覆盖 + 95% 判完 + 永久 | `position` 以请求值直接覆盖（续播语义）；视频 `position ≥ duration_sec × 0.95`、图文 `≥ 95` 判完；`finished` 一旦为 1 永久保持 1 | `server/store.js`（`upsertRecord` / `judgeFinished`） | `records.test.js`（视频/图文 95% 判完与永久性）；`第二部分 §4` 接口层步骤 4-5 |
| A4 | 单条查询零值默认 | `GET /api/records/:contentId?user_id=`，无记录返回各字段 0 的零值默认（HTTP 200），不做 404，前端免判空 | `server/routes/records.js` + `store.js`（`getRecord`） | `records.test.js`、`store.test.js`（零值默认）；smoke `[5/5]` |
| A5 | 列表三态聚合 | `GET /api/contents?user_id=` 返回内容 + 记录 + `status` 三态：`not_started` / `continue` / `finished`，按 `created_at` 排序 | `server/routes/records.js` + `store.js`（`listContentsWithRecord`） | `records.test.js`、`store.test.js`（三态聚合）；smoke `[5/5]`；e2e 列表三态用例 |
| A6 | 存储查看 | `GET /api/records` 无参数，返回 `{ count, records[] }` 全量最新快照，按 `updated_at` 降序，供黑盒查看/排查（v1.1.0 去 SQLite 后的「开箱看数据」窗口） | `server/routes/records.js` | `records.test.js`（count + 降序）；`第二部分 §4` 接口层前后对比 |

### B 数据与存储（`server/store.js`）

| 编号 | 功能 | 一句话说明 | 实现位置（文件） | 验证方式（对应测试/接口） |
|------|------|------------|------------------|---------------------------|
| B1 | 源数据常量 | `SOURCE_CONTENTS` 模块常量：1 视频（`video-7092`，61.486s，指向 `/source/7092_1790088875.mp4`）+ 2 图文（`article-001` / `article-002`），进程内只读 | `server/store.js` | `server/__tests__/store.test.js`（结构断言） |
| B2 | 内存 Map 存储 | 记录存于 `Map<"user_id:content_id">`，纯内存不落盘，服务重启清零（源数据不受影响） | `server/store.js`（`createStore`） | `store.test.js`；FAQ「重启数据清零」；`第二部分 §4` |
| B3 | MAX 幂等保护 | 同 A2：累计型指标（`played_sec` / `stay_sec`）只增不回退，幂等可重放 | `server/store.js` | `records.test.js`；smoke 幂等重发（脚本本身可重复执行） |
| B4 | position 覆盖 | 同 A3 前半：最后位置语义，用户拖回看也如实覆盖 | `server/store.js` | `records.test.js`；smoke `[4/5]`（`position === 3` 覆盖断言） |
| B5 | 95% 判完与永久保持 | 同 A3 后半：判完阈值按内容类型区分，`finished=1` 不回退 | `server/store.js`（`judgeFinished`） | `records.test.js`（永久性用例） |
| B6 | userid 缺省 guest | `user_id` 由 URL query 传入并随心跳透传；查询类接口 query 缺省时按 `'guest'` 记录 | `server/routes/records.js`、`src/views/List.vue`、`src/views/Detail.vue` | `records.test.js`（缺省 guest）；`List.test.js`（跳转缺省 guest）；e2e |

### C 核心 hook（`src/hooks/usePlayRecord.js`）

| 编号 | 功能 | 一句话说明 | 实现位置（文件） | 验证方式（对应测试/接口） |
|------|------|------------|------------------|---------------------------|
| C1 | 心跳调度 | `setInterval` 按 `interval`（可配，默认 15000ms）每跳组装「基线 + 会话增量」全量快照经 `reporter.heartbeat` 上报 | `src/hooks/usePlayRecord.js`（`startTimer` / `makeSnapshot`） | `usePlayRecord.test.js`（节奏与快照断言）；e2e「播放 17s 三指标增长」 |
| C2 | 历史基线合并 | 挂载时拉 `GET /api/records/:contentId` 作基线，快照 = 历史基线 + 会话增量；基线竞态由全量快照口径自纠 | `src/hooks/usePlayRecord.js`（`loadBaseline`） | `usePlayRecord.test.js`（基线合并与竞态自纠）；e2e 续播反显 |
| C3 | 停留时钟（visible 墙钟） | 仅 `document.visibilityState === 'visible'` 期间累计墙钟，`hidden` 冻结，回前台续计 | `src/hooks/usePlayRecord.js`（`currentStaySessionMs` / `onVisibilityChange`） | `usePlayRecord.test.js`（hidden 冻结）；e2e hidden 用例（stay 不涨） |
| C4 | 退出矩阵（4 事件） | 全部事件驱动、绝不由定时器触发：hidden 停跳 + beacon 补报 / visible 重启心跳与停留时钟 / `pagehide` + `beforeunload` beacon 补报 / unmount 先拆定时器与监听再 keepalive 补报 | `src/hooks/usePlayRecord.js`（`onVisibilityChange` / `onPageExit` / `onBeforeUnmount`） | `usePlayRecord.test.js`（四事件逐一断言）；e2e hidden 补报、路由跳转补报两条用例 |
| C5 | 默认 Reporter 双通道 | `heartbeat` 走 `fetch keepalive`（hidden 中 `ended` 补报不被页面回收取消）；`beacon` 走 `sendBeacon`（Blob + `application/json`），失败/不可用 fallback `fetch keepalive` | `src/hooks/usePlayRecord.js`（`createDefaultReporter`） | `usePlayRecord.test.js`（sendBeacon 与 keepalive 断言）；`第二部分 §4` 页面层切后台/关页 |
| C6 | 返回值句柄 | `{ pause, resume, reportNow, latest }`：手动暂停/恢复心跳、立即上报（供视频 `ended` 调用）、当前快照（调试/反显） | `src/hooks/usePlayRecord.js`（返回值） | `usePlayRecord.test.js`（pause/resume/reportNow）；`Detail.test.js`（ended 即时报） |
| C7 | 双扩展点 | `source: PlaySource`（采集适配器）与 `reporter: Reporter`（上报通道）均可注入替换，`interval` / `ready` / `onReport` 可配置（`ready` 为 v1.3.0 就绪守卫：未就绪期间心跳与四条退出路径补报全跳过，零上报零污染）；接口不变则 hook 与服务端零改动 | `src/hooks/usePlayRecord.js`（接口定义 + options） | `usePlayRecord.test.js`（mock reporter 注入全程 + ready 守卫 3 用例）；D 组两适配器即接口实现实证 |

### D 采集适配器（`src/hooks/sources/`）

| 编号 | 功能 | 一句话说明 | 实现位置（文件） | 验证方式（对应测试/接口） |
|------|------|------------|------------------|---------------------------|
| D1 | videoSource | 监听 `timeupdate`，相邻 `currentTime` 差值累加为 `playedDelta`；差值 ≥1s 或负差（seek 拖动/回拖）不计入，2x 倍速 0.5s 差值正常计入；`position = currentTime()`；`destroy` 移除监听 | `src/hooks/sources/videoSource.js` | `src/hooks/__tests__/videoSource.test.js`（5 用例） |
| D2 | articleSource | 滚动事件约 200ms 节流（首沿立即 + 尾沿补发）；`position = 已滚动高度/(总高-视口) × 100` 向下取整收敛 0-100；容器不可滚动时 `position = 100`；`playedDelta` 恒 0 | `src/hooks/sources/articleSource.js` | `src/hooks/__tests__/articleSource.test.js`（5 用例） |

### E 前端页面（`src/views/` + `src/App.vue`）

| 编号 | 功能 | 一句话说明 | 实现位置（文件） | 验证方式（对应测试/接口） |
|------|------|------------|------------------|---------------------------|
| E1 | 列表页三态 + 进度 + 跳转透传 | Vant Cell + Tag 三态（未开始灰/继续播放蓝/已播完绿）；副标题「已播 x% · 续播位置 xs」或「已读 x%」；点击跳 `/detail/:id?userid=`（缺省 guest） | `src/views/List.vue` | `src/views/__tests__/List.test.js`；e2e 列表三态用例 |
| E2 | 详情视频：倍速/拖动/续播反显 | video.js 初始化（`playbackRates: [0.5, 1, 1.25, 1.5, 2]` 原生倍速菜单、控制条原生 seek）；player `ready` 后 `currentTime(服务端 position)` 续播反显 | `src/views/Detail.vue` | `src/views/__tests__/Detail.test.js`（初始化参数与反显）；e2e 续播反显与 `.vjs-playback-rate` 用例 |
| E3 | 详情视频：ended 即时报 + dispose 联动 | `player.on('ended')` 调 `reportNow()` 即时上报播完快照；组件卸载 `player.dispose()` 释放资源，并与 hook 清理联动 | `src/views/Detail.vue` | `src/views/__tests__/Detail.test.js`（ended、dispose） |
| E4 | 详情图文：渲染 + 滚动定位 | 滚动容器 `v-html` 渲染正文，接入 `articleSource` 采集；进入页面按服务端 `position` 百分比滚动定位 | `src/views/Detail.vue` | `src/views/__tests__/Detail.test.js`（v-html 与定位）；`第二部分 §4` 页面层图文判完 |
| E5 | 路由 key 重挂载 | `router-view` 绑 `:key="route.fullPath"`，路由变化强制重挂载，防止旧页面基线与新 `content_id` 组合误报 | `src/App.vue` | 无专项自动化断言；`第二部分 §4` 页面层手动回归 + 代码审阅 |

### F 工程与测试资产

| 编号 | 功能 | 一句话说明 | 实现位置（文件） | 验证方式（对应测试/接口） |
|------|------|------------|------------------|---------------------------|
| F1 | 单仓双进程 dev | `npm run dev` 以 concurrently 并起 Express(:3000) 与 Vite(:5173)；Vite 将 `/api`、`/source` 代理到 3000；`/source` 同时为静态视频目录 | `package.json`、`vite.config.mjs`、`server/index.js` | 手动：`npm run dev` 后访问 5173；`第二部分 §4` |
| F2 | 三层测试 + 冒烟 | 后端 node:test 接口测试（15）/ vitest hook 与组件单测（39）/ Playwright e2e（7）/ curl 冒烟，四类共九项资产 | `package.json` scripts + 各测试文件 | `第二部分 §2`、`§3` 全量回归 |
| F3 | 测试资产归档索引 | 九项资产在索引中逐项登记路径、覆盖点、执行命令、前置条件、预期结果，任何人可二次执行 | `docs/testing/README.md` | 按索引逐项复制命令执行（即 `第二部分 §2`） |

**功能条目合计：29 条**（A6 + B6 + C7 + D2 + E5 + F3）。

---

## 第二部分：完整测试说明

### 1. 环境准备

| 项 | 要求 | 说明 |
|----|------|------|
| Node | ≥ 20 | `package.json` `engines` 约定；后端测试用 node:test 内置 runner |
| 依赖 | `npm install` | 一次即可；含 express / vant / video.js / @playwright/test / vitest 等 |
| 浏览器 | 本机已装 Google Chrome | e2e 配置 `channel: 'chrome'`——Playwright 自带 Chromium 不带 H.264 解码器，播不了样例 mp4 |
| 端口 | 3000（后端，`PORT` 环境变量可覆盖）、5173（Vite） | e2e 会自动起停前后端并**独占**两端口（`reuseExistingServer: false`），跑 e2e 前先停掉手工 dev 进程 |
| 数据 | 无需准备 | 存储为内存实现，起服务即有 1 视频 + 2 图文源数据；记录重启清零 |

### 2. 自动化测试逐项说明（对应 `docs/testing/README.md` 九项资产）

#### 1）`server/__tests__/store.test.js` — 后端 store 单元

- 命令：`node --test server/__tests__/store.test.js`
- 覆盖功能点：B1（源数据结构：1 视频 + 2 图文、素材路径与 61.486s 时长）、B2（内存 Map / 零值默认）、A5（三态聚合）
- 前置条件：`npm install` 已执行；纯内存对象，无端口占用
- 预期输出：`# tests 3` / `# pass 3` / `# fail 0`

#### 2）`server/__tests__/records.test.js` — 后端接口测试

- 命令：`node --test server/__tests__/records.test.js`
- 覆盖功能点：A1（INSERT/UPDATE、必传 400、未知内容 404）、A2/B3（MAX 幂等、乱序不回退）、A3/B4/B5（position 覆盖、视频/图文 95% 判完与永久性）、A4（零值默认）、A5（三态聚合）、A6（`GET /api/records` count + 降序）、B6（缺省 guest）
- 前置条件：同上；每用例独立内存 store + 随机端口
- 预期输出：`# tests 12` / `# pass 12` / `# fail 0`
- 合并跑：`npm run test:server`（两个文件一起）预期 `# pass 15` / `# fail 0`

#### 3）`src/hooks/__tests__/usePlayRecord.test.js` — 核心 hook 单测

- 命令：`npx vitest run src/hooks/__tests__/usePlayRecord.test.js`
- 覆盖功能点：C1（心跳节奏 + 基线+增量快照）、C2（基线合并与竞态自纠）、C3（hidden 停留冻结）、C4（退出矩阵四事件）、C5（默认 Reporter 的 sendBeacon / fetch keepalive）、C6（pause/resume/reportNow）、C7（mock reporter 注入 + ready 守卫：未就绪双通道零上报与 latest 不动、转就绪恢复基线+增量、未就绪四退出路径全零）、心跳失败静默、场景7b 断网恢复（连续 3 跳 reject 静默、恢复首跳一次补齐全部累计）、onReport 抛错清理仍完成
- 前置条件：`npm install`；无需起后端（fetch 已 stub）
- 预期输出：`Tests  19 passed (19)`

#### 4）`src/hooks/__tests__/videoSource.test.js` — 视频采集适配器单测

- 命令：`npx vitest run src/hooks/__tests__/videoSource.test.js`
- 覆盖功能点：D1 全部（差值累加、seek ≥1s 不计、负差回拖不计、2x 倍速 0.5s 正常计入、destroy 移除监听）
- 前置条件：`npm install`；Player 为测试替身
- 预期输出：`Tests  5 passed (5)`

#### 5）`src/hooks/__tests__/articleSource.test.js` — 图文采集适配器单测

- 命令：`npx vitest run src/hooks/__tests__/articleSource.test.js`
- 覆盖功能点：D2 全部（百分比换算向下取整收敛 0-100、200ms 节流首沿+尾沿、playedDelta 恒 0、不可滚动 = 100、destroy 清理）
- 前置条件：`npm install`；容器为测试替身；fake timers
- 预期输出：`Tests  5 passed (5)`

#### 6）`src/views/__tests__/List.test.js` — 列表页组件测试

- 命令：`npx vitest run src/views/__tests__/List.test.js`
- 覆盖功能点：E1（Cell+Tag 三态及颜色、副标题百分比文案、跳转透传 userid / 缺省 guest）、B6
- 前置条件：`npm install`；`api/record` 为 mock
- 预期输出：`Tests  3 passed (3)`

#### 7）`src/views/__tests__/Detail.test.js` — 详情页组件测试

- 命令：`npx vitest run src/views/__tests__/Detail.test.js`
- 覆盖功能点：E2（videojs 初始化参数含常驻控制条与当前/总时长显示、ready 续播反显）、E3（ended 即时上报、unmount dispose、destroy 抛错时 dispose 仍被调用——防全局注册表泄漏）、E4（v-html 渲染与 position 百分比定位）、加载失败空态（getContents reject 不初始化播放器）
- 前置条件：`npm install`；video.js 与 `api/record` 为 mock
- 预期输出：`Tests  7 passed (7)`

#### 8）`e2e/play-record.e2e.spec.js` — Playwright 端到端

- 命令：`npm run test:e2e`
- 覆盖功能点：C1/C2（真实播放 17s 后三指标经 HTTP 增长）、C3/C4（hidden beacon 补报且 hidden 期间无定时器上报；路由跳转补报）、场景6 暂停（视频暂停后心跳不停：played 相对暂停时刻 ±0.5 冻结、stay 每跳 ≈+15、updated_at 持续变新——spec 决策 #8 黑盒实证）、场景7b 断网恢复（`context.route` 拦截 `POST /api/records/heartbeat` 模拟断网跨一跳失败且服务端零写入，unroute 后次跳一次补齐断网期间累计）、A4/A5/B6（列表三态黑盒校验）、E1（三态渲染）、E2（续播反显 currentTime = 服务端 position、`.vjs-play-control` / `button.vjs-playback-rate` 存在）
- 前置条件：本机已装 Google Chrome（`channel: 'chrome'`）；3000/5173 端口空闲——**先停掉手工 dev 进程**（webServer 自动起停前后端）；无需手动准备数据（各用例用带时间戳的独立 userid）
- 预期输出：`7 passed`

#### 9）`scripts/smoke.sh` — curl 冒烟

- 命令：`npm run smoke`（或 `bash scripts/smoke.sh`，可用 `BASE` 环境变量覆盖目标地址）
- 覆盖功能点：A1（首次 INSERT）、A2/B3（幂等重发、乱序不回退）、A4（零值默认）、A5（三态聚合）、B4（MAX + position 覆盖）
- 前置条件：后端已启动（`npm run dev:server`）
- 预期输出：逐步打印 `[1/5]`-`[5/5]`，末行 `SMOKE OK`；脚本幂等，可重复执行

### 3. 全量回归一条龙

```bash
# 终端 1：先起后端（smoke 依赖）
npm run dev:server

# 终端 2：单测两层
npm run test:server && npm run test:unit

# 跑 e2e 前先到终端 1 Ctrl+C 停掉 dev:server（e2e 独占 3000/5173 并自动起停）
npm run test:e2e

# e2e 结束后到终端 1 重启后端，跑冒烟
npm run dev:server
npm run smoke
```

预期输出序列：

```
npm run test:server   →  # tests 15  # pass 15  # fail 0
npm run test:unit     →  Tests  39 passed (39)
npm run test:e2e      →  7 passed
npm run smoke         →  SMOKE OK
```

### 4. 手动功能验收清单

#### 4.1 接口层（先 `npm run dev:server`，默认 `http://localhost:3000`）

- [ ] 步骤 1 健康与初始空库：`curl -s http://localhost:3000/api/health` 返回 `{"ok":true}`；`curl -s http://localhost:3000/api/records` 返回 `{"count":0,"records":[]}`（刚重启时）
- [ ] 步骤 2 心跳上报：

  ```bash
  curl -s -X POST http://localhost:3000/api/records/heartbeat \
    -H 'Content-Type: application/json' \
    -d '{"user_id":"manual","content_id":"video-7092","played_sec":20,"position":20,"stay_sec":25,"client_ts":1}'
  ```

  返回 `{"ok":true}`
- [ ] 步骤 3 上报后对比：`curl -s http://localhost:3000/api/records` 变为 `count:1` 且记录含 `first_report_at` / `updated_at`；`curl -s "http://localhost:3000/api/records/video-7092?user_id=manual"` 返回 `played_sec:20, position:20, stay_sec:25, finished:0`
- [ ] 步骤 4 判完场景：同上再 POST 一次（`played_sec:60, position:60, stay_sec:65`，60 ≥ 61.486 × 0.95 ≈ 58.41），再查单条与 `GET /api/records`，`finished` 均为 `1`
- [ ] 步骤 5 finished 永久性：再 POST `position:5`（拖回看），查单条：`finished` 仍为 `1`（不回退），`position` 如实覆盖为 `5`
- [ ] 步骤 6 零值默认与三态：`curl -s "http://localhost:3000/api/records/video-7092?user_id=nobody"` 返回全 0 且 `updated_at` 为空串（HTTP 200 非 404）；`curl -s "http://localhost:3000/api/contents?user_id=manual"` 返回 3 条，`video-7092` 为 `finished`、两条 article 为 `not_started`

#### 4.2 页面层（`npm run dev` 后浏览器访问 `http://localhost:5173`）

- [ ] 步骤 1 访问 `http://localhost:5173/list?userid=demo` → 列表 3 条（1 视频 + 2 图文），全部「未开始」灰 Tag
- [ ] 步骤 2 点「企业微信培训视频」进 `/detail/video-7092` → 出现 video.js 播放器，点大播放键开始播放
- [ ] 步骤 3 拖动进度条到中部；hover 控制条打开倍速菜单（`button.vjs-playback-rate`）选 2x
- [ ] 步骤 4 连续播放 ≥ 15 秒（一个默认心跳周期），期间另开终端 `curl -s http://localhost:3000/api/records`，可见 `demo` 的记录 `played_sec` / `position` / `stay_sec` 在增长，且 2x 下 `played_sec` 增速明显慢于 `stay_sec`
- [ ] 步骤 5 点导航栏返回列表 → `video-7092` 变「继续播放」蓝 Tag，副标题显示「已播 x% · 续播位置 xs」
- [ ] 步骤 6 再进视频详情 → 播放器自动从上次位置续播（续播反显）
- [ ] 步骤 7 切后台补报：播放中把浏览器切走（或最小化）≥ 3 秒再回来 → `curl -s http://localhost:3000/api/records` 确认切走时刻的快照已被 beacon 补报（`updated_at` 更新、`stay_sec` 含后台前时长，后台期间不增长）
- [ ] 步骤 8 关页补报：详情页播放中直接关闭标签页 → `curl -s http://localhost:3000/api/records` 仍收到最后一段数据（`pagehide` beacon 补报）
- [ ] 步骤 9 图文判完：进「图文：心跳上报机制说明」滚动到底 → 返回列表该条变「已播完」绿 Tag
- [ ] 步骤 10 判完永久性：再进该图文只滚一点点就返回 → 列表仍「已播完」（`finished` 不回退）；不携带 userid 访问 `/list` 再播放任意内容，`GET /api/records` 中记录落在 `guest` 名下

### 5. 企微嵌入验收清单（源自 README「企业微信嵌入注意」）

- [ ] 宿主把 `userid` 拼入页面 URL（如 `.../list?userid=u1`），前端读取 query 随心跳透传，记录按该 userid 落库；缺失按 `guest` 记
- [ ] 播放记录为服务端内存存储（不落盘），宿主无需提供可写数据目录；服务重启记录清零属预期行为
- [ ] 页面关闭 / 切后台由 `pagehide` + `navigator.sendBeacon` 兜底补报，宿主无需注册任何额外回调（iOS 企微 WebView 以 `pagehide` 为关键路径）
- [ ] 样例视频为 H.264：企微内置 Chrome 内核可播；Playwright 自带 Chromium 不带该解码器，故 e2e 用 `channel: 'chrome'` 跑本机 Chrome

### 6. 常见问题（FAQ）

1. **e2e 报端口占用（3000/5173）**：Playwright 配置 `reuseExistingServer: false`，会检测端口并拒绝在已占用时启动。先停掉手工 `npm run dev` 进程再跑 `npm run test:e2e`；如需改后端端口用 `PORT=xxx npm run dev:server`，但注意 `vite.config.mjs` 的 proxy 固定指向 3000，改后端端口需同步改 proxy。
2. **e2e 播放失败 / 首个用例超时**：e2e 依赖本机安装的 Google Chrome（`channel: 'chrome'`）。Playwright 自带 Chromium 无 H.264 解码器，播不了 `source/7092_1790088875.mp4`，会导致「播放 17s 三指标增长」等用例失败。确认 Chrome 已安装且为较新版本。
3. **服务重启后数据没了**：设计如此。存储层为内存实现（spec v1.1.0 移除 SQLite），记录不落盘，重启清零；源数据（1 视频 + 2 图文）随代码常驻不受影响。想重置测试数据，重启 `dev:server` 即可。
4. **改了 server 代码数据就清零**：`dev:server` 用 `node --watch` 启动，`server/` 下任何文件被编辑都会立即重启进程、清空内存记录。联调时发现「数据丢了」先确认是不是刚保存过 server 文件。
5. **smoke 报连接失败或 FAIL**：先确认后端在跑（`curl -s http://localhost:3000/api/health` 应返回 `{"ok":true}`）。`SMOKE OK` 只在全部断言通过时打印；脚本使用固定用户 `smoke-user` + 每轮唯一零值用户，服务端 MAX 幂等保证重复执行不因残留数据报错。

---

## 第三部分：测试通过状态报告

- 报告基准：`v1.3.0`（分支 `mai`），2026-09-24 全量回归实跑
- 结论先行：**当前失败用例数为 0**（四层测试全绿）；「未通过清单」里没有失败项，只有**未覆盖项**（无自动化用例）与**环境受限项**（本地无法自动化），逐条如实列出

### 1. 通过测试的功能（全量回归实跑证据，2026-09-24）

| 层 | 命令 | 实跑结果 |
|----|------|---------|
| 后端接口/存储 | `npm run test:server` | `# tests 15 / # pass 15 / # fail 0` |
| hook 与组件单测 | `npm run test:unit` | `Test Files 5 passed (5) / Tests 39 passed (39)` |
| 端到端（真 Chrome + 真前后端） | `npm run test:e2e` | `7 passed (约 1.9m)` |
| 冒烟（curl 三/四接口串联） | `npm run smoke` | `[1/5]`…`[5/5]` → `SMOKE OK` |

**按功能编号的通过映射**（29 条功能 = 27 条有自动化直接断言 + 2 条手动）：

- A1-A6、B1-B6（后端 12 条）：全部通过 —— `records.test.js`（12 用例）+ `store.test.js`（3 用例）+ smoke 5 段
- C1-C7（核心 hook 7 条）：全部通过 —— `usePlayRecord.test.js`（19 用例，含退出矩阵四事件、基线竞态、keepalive/beacon 双通道、onReport 抛错加固、v1.3.0 ready 守卫 3 用例与场景7b 断网恢复一次补齐）
- D1-D2（适配器 2 条）：全部通过 —— `videoSource`（5）+ `articleSource`（5）
- E1-E4（页面 4 条）：全部通过 —— `List.test.js`（3）+ `Detail.test.js`（7，含 v1.2.5 加固两用例）+ e2e 真实浏览器链路
- F2-F3（测试资产 2 条）：全部通过 —— 本报告的实跑即验证
- 关键行为点抽查证据：MAX 幂等重发不变 / 乱序不回退 / 95% 判完边界（58.4117 含等号）与永久性 / 零值默认非 404 / 三态聚合 / hidden 补报且无定时器上报 / 路由跳转补报 / 续播反显 currentTime=服务端 position / seek ≥1s 不计时长 / 2x 倍速双指标分离 / 未就绪期间零上报（v1.3.0 ready 守卫）/ 视频暂停心跳不停 played 冻结 stay 涨（场景6 e2e）/ 断网恢复一次补齐（场景7b 单测+e2e）——均有对应通过用例（见第二部分 §2 逐项映射）

### 2. 未通过 / 未覆盖清单（如实亮牌）

> 本节无「失败用例」；以下为**无自动化覆盖**或**本地环境无法自动化**的功能点，附验证方式与风险定性。

| # | 项 | 状态 | 说明与现有替代验证 | 风险 |
|---|----|------|--------------------|------|
| 1 | E5 路由 key 重挂载 | ⚠️ 仅手动 | `App.vue` 的 `:key="route.fullPath)` 无专项断言；靠第二部分 §4.2 手动回归 + 代码审阅。可用 List↔Detail 连续切换断言基线不串，列为待补用例 | 低 |
| 2 | F1 双进程 dev 体验 | ⚠️ 仅手动 | `npm run dev` 并起/代理/静态目录由人工访问验证；后端腿已被 smoke 覆盖 | 低 |
| 3 | 企微真机关页补报到达率 | ⛔ 环境受限 | 真实「杀进程/关 WebView」时 `pagehide + sendBeacon` 的到达率本地无法自动化；现有近似：单测模拟 pagehide（各补报一次）+ e2e 合成 visibilitychange。真机按第二部分 §5 清单验收 | 中（iOS WebView 回收激进） |
| 4 | 企微内置内核兼容性 | ⛔ 环境受限 | H.264/`playsinline`/`sendBeacon` 在企微内核的表现需真机回归；本地以 Chrome channel 近似 | 中 |
| 5 | 并发与压力 | ⛔ 未测试 | 多用户并发心跳、长时间运行内存曲线无压测。设计依据：Node 单线程 + 同步 store，handler 内不可交错（v1.0.0 评审确认），但无压测证据 | 中（上量前建议补） |
| 6 | videoSource NaN 边界 | ⚠️ 已知理论边界 | `player.currentTime()` 若返回 NaN 可穿透 `typeof` 守卫污染基线（v1.2.3 评审记录）；video.js 正常路径不返回 NaN，未触发过 | 低 |
| 7 | 重启清零行为（B2 后半） | ⚠️ 无专项用例 | 「重启记录清零、源数据常驻」为设计行为，FAQ 第 3 条说明；无自动化断言 | 低 |
| 8 | 视觉与排版系统化 | ⚠️ 抽检级 | 仅 375px 三页截图 + 视觉模型评审（列表 7.5/10、图文 8/10、视频控制条完整）；414px+ 宽度、无障碍对比度无系统化断言 | 低 |
| 9 | KeepAlive 场景 | ➖ 未适用 | 当前路由无 keep-alive；若未来引入，`onBeforeUnmount` 不触发需改 `onDeactivated` 停心跳——记录为架构前提 | 低 |

### 3. 已知观察项（非缺陷，持续记录）

- Detail chunk ≈698KB（video.js 整包），如需优化可 `manualChunks` 拆分
- Vant 全量注册（主包偏大），按需注册为后续优化项
- e2e「hidden 无定时器上报」观察窗（约 8.5s）早于首个 15s 心跳到期点，为弱信号；强断言由 hook 单测「unmount 后 60s 零上报」承担

### 4. 覆盖率总表

| 维度 | 数值 |
|------|------|
| 功能条目 | 29（A6+B6+C7+D2+E5+F3） |
| 有自动化直接断言 | 27 / 29 |
| 仅手动 | 2（E5、F1） |
| 当前失败用例 | **0** |
| 本地无法自动化（需真机/压测） | 2 类（企微真机、并发压力） |
