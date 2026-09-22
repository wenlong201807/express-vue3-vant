# 测试资产索引

所有测试脚本与用例均为项目资产，随代码入库归档（spec §10.5）。任何人拿到仓库后，
按下表「执行命令」逐项复制粘贴即可二次执行；执行前先核对「前置条件」。

| # | 文件路径 | 测试类型 | 功能备注 | 执行命令 | 前置条件 | 预期结果 |
|---|---|---|---|---|---|---|
| 1 | `server/__tests__/db.test.js` | node:test 接口 | 建表成功（contents/play_records 按 spec §5）；种子 1 视频 + 2 图文；文件库重复初始化幂等 | `node --test server/__tests__/db.test.js` | `npm install` 已执行；用例自建内存/临时库，不触碰 `data/app.db` | `# tests 3` / `# pass 3` / `# fail 0` |
| 2 | `server/__tests__/records.test.js` | node:test 接口 | heartbeat INSERT/UPDATE、MAX 幂等重发不变、乱序不回退、position 覆盖、视频/图文 95% 判完与永久性、空记录零值默认、必传 400、未知内容 404、contents 三态聚合、缺省 guest | `node --test server/__tests__/records.test.js` | 同上；每个用例独立内存库 + 随机端口 | `# tests 11` / `# pass 11` / `# fail 0`（两文件合并跑用 `npm run test:server`，预期 14/14/0） |
| 3 | `src/hooks/__tests__/usePlayRecord.test.ts` | vitest 单测 | 心跳节奏与「基线+增量」全量快照；退出矩阵四事件（hidden 停跳+beacon、visible 重启、pagehide/beforeunload beacon、unmount 补报+移除监听）；hidden 停留时钟冻结；心跳失败静默；pause/resume/reportNow；基线竞态自纠；onReport 抛错清理仍完成；默认 Reporter 的 sendBeacon 与 fetch keepalive（含 heartbeat keepalive） | `npx vitest run src/hooks/__tests__/usePlayRecord.test.ts` | `npm install`；无需起后端（fetch stub） | `Tests  15 passed (15)` |
| 4 | `src/hooks/__tests__/videoSource.test.ts` | vitest 单测 | timeupdate 差值累加；差值 ≥1s seek 不计；负差值回拖不计；2x 倍速 0.5s 差值正常计入；destroy 移除监听 | `npx vitest run src/hooks/__tests__/videoSource.test.ts` | `npm install`；Player 为测试替身 | `Tests  5 passed (5)` |
| 5 | `src/hooks/__tests__/articleSource.test.ts` | vitest 单测 | 滚动百分比换算（向下取整、0-100 收敛）；200ms 节流首沿+尾沿；playedDelta 恒 0；不可滚动容器 position=100；destroy 清理 | `npx vitest run src/hooks/__tests__/articleSource.test.ts` | `npm install`；容器为测试替身；fake timers | `Tests  5 passed (5)` |
| 6 | `src/views/__tests__/List.test.ts` | vitest 组件 | Vant Cell+Tag 三态（default 灰/primary 蓝/success 绿）；副标题百分比文案；点击跳 `/detail/:id?userid=`（缺省 guest） | `npx vitest run src/views/__tests__/List.test.ts` | `npm install`；api/record 为 mock | `Tests  3 passed (3)` |
| 7 | `src/views/__tests__/Detail.test.ts` | vitest 组件 | video：videojs 初始化参数（playbackRates [0.5,1,1.25,1.5,2]）、ready 续播反显、ended 即时上报、unmount dispose；article：v-html 渲染与 position 百分比定位 | `npx vitest run src/views/__tests__/Detail.test.ts` | `npm install`；video.js 与 api/record 为 mock | `Tests  5 passed (5)` |
| 8 | `e2e/play-record.e2e.spec.ts` | playwright e2e | 真实前后端：播放 17s 三指标落库；hidden 补报且无定时器上报；路由跳转补报；列表三态；续播反显（currentTime=服务端 position）；.vjs-play-control/button.vjs-playback-rate 存在 | `npm run test:e2e` | 本机已装 Google Chrome（config channel:'chrome'）；3000/5173 端口空闲（webServer 自动起停，独立库 e2e/e2e.db） | `5 passed` |
| 9 | `scripts/smoke.sh` | curl 冒烟 | 三接口串联：上报/幂等重发/乱序不回退/MAX+position 覆盖/零值默认/三态聚合；可重复执行 | `npm run smoke` | 后端已启动：`npm run dev:server` | 末行输出 `SMOKE OK`（重复执行同样通过） |

## 全量回归（一条龙）

```bash
npm run test:server && npm run test:unit && npm run test:e2e && npm run smoke
```

前置：`npm run dev:server` 保持运行（smoke 依赖；e2e 会自动管理自己的端口与独立库，
执行 e2e 前先停掉手工 dev 进程，结束后再重启 dev:server 跑 smoke）。

预期：server `# pass 14` → unit `Tests  33 passed (33)` → e2e `5 passed` → smoke `SMOKE OK`。
