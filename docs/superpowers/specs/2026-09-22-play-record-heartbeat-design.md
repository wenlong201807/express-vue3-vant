# 播放记录心跳上报系统设计（express-vue3-vant）

- 文档日期：2026-09-22
- 适用仓库：`/Users/zhuwenlong/Desktop/ai-study/express-vue3-vant`（greenfield 空仓起步）
- 文档性质：实现规格（spec），所有口径已与需求方逐项确认，实现须与本文件一致

---

## 1. 背景与需求

仓库 `/Users/zhuwenlong/Desktop/ai-study/express-vue3-vant` 为空仓 greenfield，当前仅包含 `require.txt`（需求描述）与 `source/7092_1790088875.mp4`（样例视频素材），需从零搭建完整系统：

- **后端技术栈**：Express + Node + SQLite
- **前端技术栈**：Vue3 + Vite + Vant + TypeScript
- **运行环境**：嵌入企业微信 WebView 的 H5 页面

需求来源 `require.txt`，归纳如下：

- **后端两个核心接口**：
  1. 心跳上报：接收客户端定时上报的时间记录；
  2. 按「视频 id」查询播放记录，供客户端反显（续播）使用。
- **前端两个页面**：
  1. 列表页：展示「已播完 / 继续播放」状态；
  2. 详情页：视频播放（含倍速播放、拖动播放）或图文阅读二态。
- **新增核心指标**：采集「播放时长、播放时间位置、页面停留时间」三个指标，采用心跳/定时器上报机制落库。
- **硬约束 1（退出语义）**：页面关闭、路由跳转、切换后台都算退出页面；退出时的上报**不能由心跳定时器触发**。
- **硬约束 2（封装要求）**：采集逻辑必须封装为独立 hook，做到可配置、可扩展。

---

## 2. 已确认的需求决策（与需求方逐项确认过的口径，不可更改）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 退出语义 | 退出时立即停止心跳定时器，改由 `visibilitychange` / `pagehide` 事件 + `navigator.sendBeacon` 一次性补报最后一段数据 |
| 2 | 上报口径 | 全量快照 + 服务端幂等覆盖；心跳请求失败静默忽略，下次快照自然覆盖自愈 |
| 3 | 列表状态数据源 | 后端新增第 3 个接口：返回内容列表并聚合每条播放状态（实际共 3 个接口） |
| 4 | 用户维度 | URL query 参数传 `userid`，前端读取后随心跳透传，缺省 `'guest'` |
| 5 | 播完判定 | 服务端判定：`position ≥ 内容时长 × 95%`（视频按秒，图文按滚动百分比 ≥ 95）；`finished` 一旦为 1 永久保持 1 |
| 6 | 图文口径 | 图文详情页记录页面停留时长 + 阅读滚动位置（百分比），与视频共用同一 hook 与同一张记录表 |
| 7 | 倍速口径 | 双指标：播放时长 = 视频内容时间（`currentTime` 差值累加），页面停留时长 = 墙钟时间；倍速下两者自然分离 |
| 8 | 暂停语义 | 页面可见但视频暂停时：不停心跳，停留时长继续累计，播放时长停止累计；仅退出页面才停心跳 |

---

## 3. 方案对比与选型

### 3.1 方案 A（选定）：单 hook 内聚 + 可插拔采集源

`usePlayRecord` 一个 hook 管全生命周期：心跳调度、历史基线合并、退出补报、监听器清理。指标采集通过 `PlaySource` 接口插拔（内置 `videoSource` / `articleSource`），上报通道 `Reporter` 可注入替换。

- 满足「可配置、可扩展」的硬约束；
- 页面接入成本低：页面只需构造一个 source 传入 hook。

### 3.2 方案 B（否决）：三层框架化拆分

`useHeartbeatEngine`（通用心跳）/ `usePlayRecord`（业务）/ `reporter`（独立包）三层拆分。复用性强，但对本项目规模属于过度设计，否决。

### 3.3 方案 C（否决）：Pinia 插件全局驱动

由 Pinia 插件全局驱动采集与上报。与「封装独立 hook」的硬约束不符；脱离组件生命周期后，监听器的挂载与清理管理更复杂，否决。

---

## 4. 工程结构（单仓库）

```
express-vue3-vant/
├── server/                      # Express 后端（JS + better-sqlite3）
│   ├── index.js                 # 入口：API + /source 静态视频目录
│   ├── db.js                    # sqlite 建表 + 种子数据（1 条视频 + 2 篇图文）
│   └── routes/records.js        # 3 个 API 路由
├── src/                         # Vue3 + TS 前端
│   ├── api/record.ts            # 接口封装
│   ├── hooks/
│   │   ├── usePlayRecord.ts     # 核心 hook
│   │   └── sources/
│   │       ├── videoSource.ts   # video.js Player 采集适配器
│   │       └── articleSource.ts # 滚动采集适配器
│   ├── views/List.vue           # 列表页
│   └── views/Detail.vue         # 详情页（视频型使用 video.js 播放器 / 图文二态）
└── source/*.mp4                 # 视频素材
```

工程要点：

- 后端选 **better-sqlite3**（同步 API），免去异步连接管理；
- 前端依赖新增 **video.js**（^8.x，自带 TS 类型），视频型详情页使用 video.js 播放器；
- 开发时 vite dev server 配置 proxy：`/api` → `http://localhost:3000`；
- 根 `package.json` 单包管理，`scripts` 提供：
  - `dev:server`：启动 Express；
  - `dev:client`：启动 vite；
  - `dev`：concurrently 并起前后端。

---

## 5. 数据模型（SQLite 两张表）

### 5.1 表 `contents`（内容表，种子数据写入）

种子数据：1 条视频 + 2 篇图文。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PRIMARY KEY | 内容唯一标识 |
| `type` | TEXT | `'video'` \| `'article'` |
| `title` | TEXT | 标题 |
| `video_url` | TEXT | 视频型素材地址，指向 `/source/7092_1790088875.mp4`；图文型为 NULL |
| `duration_sec` | REAL | 视频总时长（秒），服务端判播完依赖；图文型为 NULL |
| `article_html` | TEXT | 图文正文 HTML；视频型为 NULL |
| `created_at` | TEXT | 创建时间 |

### 5.2 表 `play_records`（播放记录表，`UNIQUE(user_id, content_id)`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 自增主键 |
| `user_id` | TEXT NOT NULL | 用户标识 |
| `content_id` | TEXT NOT NULL | 内容标识 |
| `played_sec` | REAL DEFAULT 0 | 累计播放时长，内容时间口径；图文恒 0 |
| `position` | REAL DEFAULT 0 | 最后位置：视频 = 秒；图文 = 滚动百分比 0-100 |
| `stay_sec` | REAL DEFAULT 0 | 累计停留墙钟秒数 |
| `finished` | INTEGER DEFAULT 0 | 0/1，服务端判定，一旦 1 永久 1 |
| `first_report_at` | TEXT | 首次上报时间 |
| `updated_at` | TEXT | 最近更新时间 |

---

## 6. API 设计（3 个接口）

### 6.1 `POST /api/records/heartbeat`

心跳上报与退出补报共用的唯一写入口。

**请求 body（JSON）**：

```json
{
  "user_id": "string",
  "content_id": "string",
  "played_sec": 0,
  "position": 0,
  "stay_sec": 0,
  "client_ts": 0
}
```

字段说明：`user_id` / `content_id` / `played_sec` / `position` / `stay_sec` 为必传；`client_ts`（客户端时间戳）可选。

**服务端写库规则（幂等核心）**：

1. 无记录则 INSERT；有记录则 UPDATE（按 `UNIQUE(user_id, content_id)` 定位）。
2. `played_sec`、`stay_sec` 取 `MAX(库中旧值, 请求新值)` —— 幂等、防重复、防乱序回退。
3. `position` 直接以请求值覆盖（续播语义 = 最后位置；用户拖回看也如实记录）。
4. 更新后重判 `finished`：
   - 视频型：`position ≥ duration_sec × 0.95` 则 `finished = 1`；
   - 图文型：`position ≥ 95` 则 `finished = 1`；
   - 已为 1 不回退（永久保持 1）。

**响应**：`{ "ok": true }`

**通道复用**：心跳与 `sendBeacon` 退出补报共用此端点（`sendBeacon` 以 `Blob` 且 `type: 'application/json'` 发送）。

### 6.2 `GET /api/records/:contentId?user_id=xxx`

按内容 id 查询播放记录，供详情页反显续播。

**响应**：

```json
{
  "content_id": "string",
  "played_sec": 0,
  "position": 0,
  "stay_sec": 0,
  "finished": 0,
  "updated_at": "string"
}
```

**空记录口径（定死）**：无记录时返回各字段为 0 / `finished` 0 的默认零值记录（HTTP 200），**不做 404**，避免前端判空分支。

### 6.3 `GET /api/contents?user_id=xxx`

内容列表 + 播放状态聚合（列表页数据源）。

**响应**：内容数组，每项结构：

```json
{
  "content": {
    "id": "string",
    "type": "video | article",
    "title": "string",
    "duration_sec": 0
  },
  "record": {
    "played_sec": 0,
    "position": 0,
    "stay_sec": 0,
    "finished": 0
  },
  "status": "not_started | continue | finished"
}
```

**status 三态映射**：

| 记录情况 | status | 含义 |
|----------|--------|------|
| 无记录 | `'not_started'` | 未开始 |
| 有记录且 `finished = 0` | `'continue'` | 继续播放 |
| `finished = 1` | `'finished'` | 已播完 |

---

## 7. 核心 hook：`usePlayRecord` 设计

### 7.1 TypeScript 接口

```ts
interface PlayRecordOptions {
  contentId: MaybeRef<string>
  userId: MaybeRef<string>
  interval?: number                 // 心跳间隔 ms，默认 15000
  source: PlaySource                // 扩展点1：采集适配器
  reporter?: Reporter               // 扩展点2：上报通道，默认实现 fetch 心跳 + sendBeacon 退出补报；测试可注入 mock
  onReport?: (payload: HeartbeatPayload) => void
}

interface PlaySource {
  getSnapshot(): { playedDelta: number; position: number }  // 本次会话内累计
}

interface Reporter {
  heartbeat(payload: HeartbeatPayload): Promise<void>   // 心跳通道
  beacon(payload: HeartbeatPayload): void               // 退出补报通道（sendBeacon，失败 fallback fetch keepalive）
}
```

- **扩展点 1 `source`**：`PlaySource` 采集适配器，内置 `videoSource` / `articleSource`（见 7.3）。
- **扩展点 2 `reporter`**：上报通道，默认实现为「fetch 心跳 + sendBeacon 退出补报」；测试可注入 mock。

### 7.2 hook 内部职责（按序）

1. **历史基线**：挂载时调 `GET /api/records/:contentId` 拉历史基线（`played_sec` / `stay_sec` / `position` / `finished`）。
2. **心跳调度**：`setInterval(interval)`，每跳把「历史基线 + 会话增量」组装为**全量快照**，经 `reporter.heartbeat` 上报。
3. **停留时钟**：由 hook 统一累计——仅页面可见（`document.visibilityState === 'visible'`）期间的墙钟时间计入 stay 增量，`hidden` 期间冻结。
4. **生命周期监听与退出矩阵**（全部不由定时器触发）：

   | 事件 | 动作 |
   |------|------|
   | `visibilitychange` → hidden | 停 interval + `reporter.beacon` 补报最后快照 |
   | `visibilitychange` → visible | 重启 interval，停留时钟继续 |
   | `pagehide` / `beforeunload` | `reporter.beacon` 补报（iOS 企业微信 WebView 关键路径） |
   | `onBeforeUnmount`（路由跳转） | 停 interval + fetch keepalive 补报 + 移除全部事件监听 |

5. **心跳失败处理**：fetch 失败 `catch` 静默，**不做重试**（快照口径下次覆盖自愈）。
6. **返回值**：`{ pause(), resume(), reportNow(), latest }`
   - `pause()` / `resume()`：手动暂停/恢复心跳；
   - `reportNow()`：立即上报一次，供视频 `ended` 事件时调用；
   - `latest`：当前快照（调试/反显用）。

### 7.3 采集适配器

**`videoSource(player: videojs.Player)`**：

- 对接 video.js Player 实例：`player.on('timeupdate')` 监听、`player.currentTime()` 取值，将相邻两次 currentTime 差值累加为 `playedDelta`；
- 差值 ≥ 1 秒判定为 seek 拖动，该差不计入播放时长（防拖动/倍速场景虚增）；
- `position = player.currentTime()`；
- `PlaySource` 接口签名不变——播放器实现可替换，hook 与服务端零改动。

**`articleSource(scrollContainer)`**：

- 滚动事件节流（约 200ms）；
- `position = 已滚动高度 / (总高度 - 视口高度) × 100`，向下取整收敛到 0-100；
- `playedDelta` 恒 0。

---

## 8. 页面设计

### 8.1 列表页 `List.vue`

- Vant `Cell` 列表 + Vant `Tag` 显示三态状态（未开始灰 / 继续播放蓝 / 已播完绿）；
- 副标题展示已播百分比或续播位置；
- 点击跳转 `/detail/:id?userid=xxx`。

### 8.2 详情页 `Detail.vue`（按 `content.type` 二态渲染）

**video 形态**：

- 使用 **video.js 播放器**（弃用原生 video + 自定义控制条方案）；
- 初始化：`videojs(el, { controls: true, playbackRates: [0.5, 1, 1.25, 1.5, 2], sources: [{ src: video_url, type: 'video/mp4' }] })`；
- 倍速播放：由 video.js 官方 `playbackRates` 配置原生提供速率菜单，不自行实现；
- 拖动播放：video.js 自带控制条进度条 seek，不自行实现；
- 续播反显：player `ready`/`loadedmetadata` 后调用 `player.currentTime(服务端 position)`；
- 组件卸载时 `player.dispose()` 释放资源，并与 `usePlayRecord` 的清理联动。

**article 形态**：

- 滚动容器渲染 `article_html`；
- 进入页面按服务端 `position` 百分比滚动定位。

**接入方式**：两种形态各自构造对应 `PlaySource` 传入 `usePlayRecord`。

### 8.3 userid 读取

读取 `route.query.userid`，缺省 `'guest'`。

---

## 9. 异常与容错

| 场景 | 策略 |
|------|------|
| 心跳请求失败/弱网 | 静默忽略，下次全量快照覆盖自愈 |
| 退出丢最后一跳 | `sendBeacon` / beacon 补报 |
| `sendBeacon` 不支持 | `fetch(..., { keepalive: true })` fallback |
| 重复/乱序上报 | 服务端 `MAX(played_sec / stay_sec)` 保护，不回退 |
| position 用户拖回 | 如实覆盖（续播取最后位置的产品语义） |
| hidden 期间 | 停留时钟冻结，心跳停止，不产生任何定时器上报 |

---

## 10. 测试策略（三层层递）

### 10.1 后端接口测试（node:test 内置 runner）

- heartbeat：INSERT / UPDATE 分支、MAX 幂等（同快照重发结果不变）、乱序（旧快照后到不回退）、finished 判定（视频 ≥ 95%、图文 ≥ 95、永久性）；
- GET records：空记录返回零值默认；
- GET contents：三态 status 聚合。

### 10.2 hook 单测（vitest + `vi.useFakeTimers` + @vue/test-utils）

- 心跳按 `interval` 节奏触发；payload = 历史基线 + 会话增量；
- 退出矩阵四事件各自动作正确：hidden 停跳 + beacon、visible 重启、pagehide beacon、unmount 清理 + 补报 + 监听移除；
- `videoSource`：`timeupdate` 差值累加、差值 ≥ 1s 的 seek 不计入；
- `articleSource`：滚动百分比换算与节流；
- hidden 期间停留时钟冻结。

### 10.3 e2e（playwright）

- 起真实前后端，模拟播放视频若干秒 → 校验 sqlite 中 `played_sec` / `position` / `stay_sec` 增长；
- 模拟 `visibilitychange` hidden / 路由跳转 → 校验补报发生与心跳停止；
- 列表页三态渲染、详情页续播反显；
- video.js 渲染自定义 DOM（`.vjs-*` 类名），e2e 选择器基于 video.js 控制条元素（如 `.vjs-play-button`、`.vjs-playback-rate`）操作播放与倍速。

### 10.4 冒烟脚本

`scripts/smoke.sh`：用 curl 串起三接口验证；须可重复执行（幂等，重复跑不因残留数据报错）。

### 10.5 测试资产归档（硬性要求）

- **归档义务**：所有测试脚本、测试用例（后端 node:test 接口测试 / vitest hook 单测 / playwright e2e / curl 冒烟脚本）均为项目资产，必须随项目代码入库归档，**禁止丢弃、禁止只跑不留**。
- **测试资产索引**：在 `docs/testing/README.md` 建立测试资产索引文档，逐项登记以下字段：
  - 脚本/文件路径；
  - 测试类型；
  - 覆盖的功能点备注（验证什么行为，如「heartbeat MAX 幂等：同一快照重发 played_sec 不变」）；
  - 执行方式（完整可复制粘贴的命令，如 `npx vitest run src/hooks/__tests__/usePlayRecord.test.ts`）；
  - 前置条件（需先起后端/建库等）；
  - 预期结果。
- **测试文件头部注释块**：每个测试文件头部写注释块，包含功能说明、运行命令、依赖前置——保证任何人拿到仓库都能二次执行。
- **冒烟脚本幂等**：`scripts/smoke.sh` 须可重复执行（幂等，重复跑不因残留数据报错）。

---

## 11. 验收标准（对照 require.txt 逐条）

1. 后端 express + node + sqlite 提供心跳上报与按视频 id 查询两个核心接口（另加列表聚合接口，已确认）；
2. 前端 vue3 + vite + vant + ts 两页面：列表状态三态、详情页视频（**video.js 实现**倍速 + 拖动）/ 图文；
3. 播放时长 / 播放位置 / 停留时间三指标经心跳机制落库；
4. 关闭 / 路由跳转 / 切后台三种退出场景均无定时器触发上报，且尾巴数据经 beacon 补报；
5. 采集封装为独立 hook `usePlayRecord`，`interval` / `reporter` / `source` / `onReport` 可配置，`PlaySource` / `Reporter` 双扩展点；
6. 三层测试（接口 / hook 单测 / e2e）+ 冒烟脚本全部通过；
7. 所有测试脚本与用例已归档至 `docs/testing/` 索引，含功能备注与可二次执行的完整命令，按索引执行全部通过。
