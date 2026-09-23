# express-vue3-vant — 播放记录心跳上报系统

嵌入企业微信 WebView 的 H5 应用：采集用户对视频 / 图文内容的「播放时长、播放位置、页面停留时间」三项指标，
经心跳机制上报落库，支撑列表页续播状态反显与详情页续播定位。

后端 Express 5 + 内存固定源数据存储（Node ≥ 20），前端 Vue 3 + Vite 5 + Vant 4 + TypeScript + video.js 8，单仓库管理。

## 功能特性

- **列表三态反显**：`/list` 按用户维度展示每条内容的 未开始 / 继续播放 / 已播完 状态（Vant Cell + Tag）。
- **详情二态**：`/detail/:id` 按 `content.type` 渲染——视频型用 video.js（原生倍速菜单 + 进度条拖动），图文型为滚动阅读。
- **三指标采集**：播放时长（视频内容时间口径）、播放位置（视频秒数 / 图文滚动百分比）、页面停留时长（墙钟），心跳落库。
- **心跳 + 退出补报**：全量快照上报，服务端 `MAX` 幂等；关闭 / 切后台 / 路由跳转均由事件驱动 beacon 补报，尾巴数据不丢。
- **`usePlayRecord` 可插拔 hook**：`source`（采集适配器）与 `reporter`（上报通道）双扩展点，`interval` / `onReport` 可配置。

## 快速开始

```bash
npm install   # Node ≥ 20
npm run dev   # concurrently 并起 Express(:3000) 与 Vite(:5173)
```

浏览器访问 `http://localhost:5173/list?userid=u1`。`userid` 从 URL query 读取并随心跳透传，缺省 `'guest'`；
开发期 Vite 已将 `/api`、`/source` 代理到 `http://localhost:3000`。

| 命令 | 用途 |
|------|------|
| `npm run dev` | concurrently 同时启动后端与前端 |
| `npm run dev:server` | 仅启动 Express（node --watch） |
| `npm run dev:client` | 仅启动 Vite |
| `npm run build` | vue-tsc 类型检查 + vite 构建 |
| `npm run test:server` | 后端接口测试（node --test） |
| `npm run test:unit` | hook / 组件单测（vitest run） |
| `npm run test:e2e` | Playwright e2e（自动起停前后端） |
| `npm run smoke` | curl 冒烟三接口（需 dev:server 在跑） |

## 接口速览

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/records/heartbeat` | 心跳上报与退出补报共用的唯一写入口 |
| GET | `/api/records` | 存储内全部播放记录当前最新快照（`count` + 按 `updated_at` 降序 `records`），供黑盒查看 / 排查 |
| GET | `/api/records/:contentId?user_id=` | 查播放记录供续播反显；无记录返回零值默认，不做 404 |
| GET | `/api/contents?user_id=` | 内容列表 + 播放状态三态聚合（列表页数据源） |

请求 / 响应结构、`MAX` 幂等写库规则与 95% 判完口径详见 spec §6。

## 心跳与退出机制

- 每次心跳上报「历史基线 + 会话增量」组成的**全量快照**；服务端对 `played_sec` / `stay_sec` 取 `MAX`，
  重复、乱序、弱网丢包均不回退；`finished` 达 95% 判定后永久保持 1。
- 退出矩阵（全部事件驱动，绝不由定时器触发）：

| 退出场景 | 事件 | 动作 |
|----------|------|------|
| 切后台 | `visibilitychange` → hidden | 停心跳 + `sendBeacon` 补报；回到 visible 重启心跳与停留时钟 |
| 关闭页面 | `pagehide` / `beforeunload` | `sendBeacon` 补报（iOS 企业微信 WebView 关键路径） |
| 路由跳转 | `onBeforeUnmount` | 停心跳 + fetch keepalive 补报 + 移除全部事件监听 |

- `sendBeacon` 不可用时 fallback `fetch keepalive`；心跳失败静默不重试，下次快照覆盖自愈。hook 全貌见 spec §7。

## 测试

所有测试脚本与用例均为项目资产，逐项登记于 **[docs/testing/README.md](docs/testing/README.md)**
（九项资产：后端接口测试 / hook 与组件单测 / Playwright e2e / curl 冒烟，每项含覆盖点、执行命令、前置条件与预期结果，可复制粘贴二次执行）。

全量回归：

```bash
npm run dev:server          # 先起后端（smoke 依赖；e2e 自动起停并独占 3000/5173 端口，跑 e2e 前先停手工 dev 进程）
npm run test:server && npm run test:unit && npm run test:e2e && npm run smoke
```

## 项目文档

- 设计规格（接口 / 数据模型 / hook / 页面口径的权威来源）：`docs/superpowers/specs/2026-09-22-play-record-heartbeat-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-22-play-record-heartbeat.md`
- 功能清单与完整测试说明（功能-测试映射 / 手动验收 / FAQ）：`docs/features-and-testing.md`

## 企业微信嵌入注意

- 宿主需把 `userid` 拼入页面 URL（如 `.../list?userid=u1`），前端读取 query 随心跳透传，缺失按 `guest` 记。
- 播放记录为服务端内存存储（不落盘），服务重启即清零，宿主无需提供可写数据目录。
- 页面关闭 / 切后台由 `pagehide` + `navigator.sendBeacon` 兜底补报，无需宿主额外回调。
- 样例视频为 H.264，需带专有编解码的 Chrome 内核（企微内置内核可播）；Playwright 自带 Chromium 不带，故 e2e 用 `channel: 'chrome'` 跑本机 Chrome。
