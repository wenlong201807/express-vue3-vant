# 详情页心跳机制·七大场景行为说明

- 基准版本：`v1.2.5`（分支 `mai`）
- 日期：2026-09-24
- 文档性质：**现状行为说明书**——每条行为均逐条对照代码核实并标注 `文件:行号`，非设计承诺；与任何旧口径冲突时以代码为准
- 配套文档：功能编号（A1…F3）引用 [docs/features-and-testing.md](features-and-testing.md)；测试资产索引见 [docs/testing/README.md](testing/README.md)；行为口径权威来源为设计规格 `docs/superpowers/specs/2026-09-22-play-record-heartbeat-design.md`
- 样例视频：`video-7092`「企业微信培训视频」，`duration_sec = 61.486`（`server/store.js:19`），判完阈值 = 61.486 × 0.95 = **58.4117**（`server/store.js:75`）。全文数值示例均基于该视频、1x 倍速、页面持续 visible 编排

---

## 第 0 章 通用机制（各场景引用，不再重复）

### 0.1 心跳启动

- `Detail.vue` 在 setup 内同步调用 `usePlayRecord`（`src/views/Detail.vue:47`），hook 末尾同步 `startTimer()`（`src/hooks/usePlayRecord.js:229`）。
- 间隔 `interval = options.interval ?? 15000`（`usePlayRecord.js:111`）；`setInterval` 的特性决定**首跳在挂载后 T+15s**，此后每 15s 一跳。
- 启动守卫（`usePlayRecord.js:161-162`）：`disposed` / `manualPaused` / 已有定时器时不重复启动；**挂载瞬间页面处于 hidden 则不启动**，由 visible 事件重启（`usePlayRecord.js:162、197-199`）——后台开页时首跳顺延到回前台后再 +15s。

### 0.2 快照公式（makeSnapshot，`usePlayRecord.js:132-142`）

心跳与退出补报共用同一组装口径——**全量快照**（历史基线 + 会话增量）：

```
played_sec = round3(基线.played_sec + 采集增量 playedDelta)      # L137，round3 = 保留三位小数（L102-104）
position   = 采集源当前值                                         # L138：视频 = currentTime（秒）；图文 = 滚动百分比（0-100）
stay_sec   = round3(基线.stay_sec + 会话可见墙钟秒)               # L139：仅 visible 期间累计，hidden 冻结（L124-126）
client_ts  = Date.now()                                           # L140
```

图文源（`articleSource`）的 `playedDelta` 恒为 0（功能编号 D2），图文场景 `played_sec` 永远等于基线值。

### 0.3 历史基线

- 挂载即异步 `GET /api/records/:contentId?user_id=`（`usePlayRecord.js:177-193`）；无记录时服务端返回各字段 0 的零值默认（HTTP 200，不做 404，`server/routes/records.js:48-54`、`server/store.js:139-146`，功能编号 A4）。
- 基线落定后刷新 `latest`（`usePlayRecord.js:189`）。
- 拉取失败（网络异常或非 2xx，`usePlayRecord.js:181、190-192`）按**全 0 基线继续**，靠服务端 MAX 幂等兜底不回退。

### 0.4 服务端写库（store.upsertRecord，`server/store.js:98-133`）

写入口唯一：`POST /api/records/heartbeat`，心跳与补报共用（`server/routes/records.js:7-28`，功能编号 A1；5 个必传字段缺一返回 400，未知 `content_id` 返回 404）。

- 无记录 → **INSERT**，`first_report_at = updated_at = 写入时刻`（`store.js:112-125`，时间戳赋值在 L120-121）。
- 有记录 → UPDATE：`played_sec` / `stay_sec` = **MAX(库中旧值, 请求新值)**（`store.js:127、129`，幂等、防重复、防乱序回退，A2/B3）；`position` **直接覆盖**（`store.js:128`，B4）。
- 播完判定 `judgeFinished`（`store.js:73-78`）：视频 `position ≥ duration_sec × 0.95`（61.486 → 58.4117，**含等号**）；图文 `position ≥ 95`。
- `finished` 永久：已为 1 先短路保持，不回退（`store.js:108-110`，B5）。

### 0.5 seek 防护（videoSource，`src/hooks/sources/videoSource.js:24-35`）

- `timeupdate` 中相邻两次 `currentTime` 差值 `diff ∈ [0, 1)` 才累加进 `playedDelta`（`videoSource.js:29-31`）。
- `diff ≥ 1`（前跳/拖动）或 `diff < 0`（回拖）**均不计入播放时长**；但 `lastTime` 与 `position` 均跟随更新（`videoSource.js:33-34`）→ 下一跳快照的 `position` 立即反映拖动后位置。
- 2x 倍速下 `timeupdate` 正常差值约 0.5s，仍正常计入（防拖动虚增不误伤倍速，D1）。

### 0.6 退出矩阵（`usePlayRecord.js:196-226`，全部事件驱动、绝不由定时器触发）

| 事件 | 动作（行号） |
|------|--------------|
| `visibilitychange` → hidden | 冻结停留时钟（L201-202）+ 停 interval（L203）+ beacon 补报最后快照（L204） |
| `visibilitychange` → visible | 停留时钟续计（L198）+ 重启 interval（L199） |
| `pagehide` / `beforeunload` | beacon 补报（L208-210；iOS 企业微信 WebView 关键路径） |
| `onBeforeUnmount`（路由跳转） | **先**置 disposed + 停 timer + 拆三个监听（L216-220），**后** beacon 补报（L221-225）；清理必达，补报失败静默 |

beacon 通道实现：`navigator.sendBeacon`（Blob + `application/json`）→ 失败/不可用 fallback `fetch keepalive` → 仍失败 catch 静默（`usePlayRecord.js:69-86`，C5）。

### 0.7 ended 即时加发

`player.on('ended') → handle.reportNow()`（`Detail.vue:84`），按心跳通道（fetch keepalive）**立即加发一跳**（`usePlayRecord.js:243-245`），不改变 interval 节奏（E3）。播完瞬间通常还会走 unmount beacon 再补一次，重复值由服务端 MAX 幂等吸收。

---

## 场景 1 首次进入（无任何记录）

### 时间线

```
T0      进入详情页（基线拉取返回零值默认；播放器未就绪，switchable 空源兜底 → 快照 playedDelta=0 / position=0）
T+15s   首跳：played=0 / position=0 / stay=15 → 服务端 INSERT（first_report_at = updated_at）
T+30s   次跳：仍不播 → played=0 / position=0 / stay=30 → UPDATE（仅 stay 涨、updated_at 刷新）
（变体）T+3s 点播放 → T+15s 首跳即携带真实值：played≈12 / position≈12 / stay=15
```

### 心跳与字段变化（公式代入，变体：T+3 开播）

| 跳 | played_sec = round3(0 + Δ) | position | stay_sec = round3(0 + 可见墙钟) |
|----|----|----|----|
| T+15 | round3(0+12) = **12** | **12** | round3(0+15) = **15** |
| T+30（续播） | round3(12+15) = **27** | **27** | round3(15+15) = **30** |

不播变体下每跳 `played=0 / position=0`，仅 `stay` 递增。

### 服务端落库结果

首跳即 INSERT（`store.js:112-125`）：`{ played_sec, position, stay_sec, finished: 0（未达 58.4117）, first_report_at == updated_at }`。即使 `played=0 / position=0`，只要快照成功送达就产生记录——写入口对零值不做拦截（`records.js:25`）。

### 列表页 / 续播反显表现

- 列表状态从「未开始」灰 Tag 变「继续播放」蓝 Tag；副标题 `已播 0% · 续播位置 0s`（`List.vue:24-32`：有记录即走百分比分支，哪怕全 0）。
- **两个关键现状（如实）**：
  1. **进入即记录**：只要进入满 15s（或任一次退出补报送达），哪怕从未播放也产生记录，列表从「未开始」变「继续播放」——这是现状语义，不是 bug 标注为未实现（附录 B 边界 2）。
  2. **15s 内秒退也会落记录**：unmount beacon 携带 switchable 空源的零值兜底快照（`Detail.vue:37` 返回 `{ playedDelta: 0, position: 0 }`）→ 服务端 INSERT 一条 `position=0` 记录。

### 验证方法

```bash
npm run dev   # 或终端1 npm run dev:server + 终端2 npm run dev:client
# 重启 dev:server 即清数据；或直接用全新 userid（如 s1-0924）
```

1. 访问 `http://localhost:5173/list?userid=s1-0924` → `video-7092` 显示灰色「未开始」。
2. 进详情页，**不点播放**，停留 16 秒以上。
3. `curl -s "http://localhost:3000/api/records/video-7092?user_id=s1-0924"` → `played_sec:0, position:0, stay_sec≈15~16`。
4. `curl -s http://localhost:3000/api/records` → 该记录 `first_report_at` 与 `updated_at` 相同（仅一跳时）。
5. 返回列表 → 蓝色「继续播放」+「已播 0% · 续播位置 0s」。
6. 秒退变体：换 `userid=s1b-0924` 进详情，3 秒内点返回 → 第 3 步 curl 仍出现一条 `position=0` 记录。

### 对应测试用例

INSERT/400/404 → A1（`records.test.js`）；零值默认 → A4；三态聚合 → A5（`store.test.js` / `records.test.js`）+ e2e「列表三态渲染」。**「进入未播满 15s 即产生记录 → 列表变继续播放」的场景链路 ⚠️ 无自动化覆盖**（现有 e2e 用例均带真实播放动作）。

---

## 场景 2 二次进入（有历史、未播完）

### 时间线

```
T0      进入，基线拉取成功：{ played_sec:12, position:30, stay_sec:40, finished:0 }
T+1s    getContents/getRecord 返回 → videojs 初始化 → player.ready → currentTime(30) 续播反显
        （Detail.vue:77-82，仅 record.position > 0 才反显，L79）
T+15s   首跳：基线 + 会话增量；采集源 position 即反显后的 currentTime（30 附近起步）
```

反显完成后，采集源（`videoSource`）的 `position` 就是历史位置——后续快照在此基础上累加，无需任何特殊合并逻辑。

### 心跳与字段变化（反显后未操作，T+15 首跳）

| 字段 | 公式代入 | 值 |
|------|----------|-----|
| played_sec | round3(12 + 0) | **12** |
| position | currentTime（反显后） | **30** |
| stay_sec | round3(40 + 15) | **55** |

### 服务端落库结果

UPDATE：`played_sec = MAX(12,12)=12`、`stay_sec = MAX(40,55)=55`、`position → 30`、`finished` 维持 0。

### 列表页 / 续播反显表现

列表「继续播放」，副标题 `已播 48% · 续播位置 30s`（30/61.486 ≈ 48.8% 向下取整，`List.vue:28`）。

**已知边界（如实，附录 B 边界 1 复述）**：若进入后**极快退出**、早于「videojs 初始化 + 反显」完成，beacon 走 switchable 空源兜底携带 `position=0`（`Detail.vue:37`）→ 服务端 `position` 被直接覆盖（`store.js:128`），历史位置 30 → 0；`played_sec` / `stay_sec` 因 MAX 不受影响。下次进入时 `record.position=0` 不满足反显条件（`Detail.vue:79`），从头播放。该边界当前**无自动化覆盖**。

### 验证方法

1. 用场景 3/1 造出历史记录（如 `s2-0924` 播放到 30s 处退出）。
2. 重进 `/detail/video-7092?userid=s2-0924` → 播放器从 ≈30s 起播（反显）。
3. `curl -s "http://localhost:3000/api/records/video-7092?user_id=s2-0924"` 确认 `position` 在 30 附近续增。
4. 边界复现：重进后**1 秒内立即返回**，再 curl → `position` 变 0；再进详情从 0 开始。
   注意：`dev:server` 为 `node --watch`，编辑 server 文件会重启清数据（FAQ 第 4 条），验证期间勿动 `server/`。

### 对应测试用例

反显 → E2（`Detail.test.js`「ready 续播反显」）+ e2e「续播反显与 video.js 控制条」；基线合并 → C2（`usePlayRecord.test.js`）。**秒退 position 归零边界 ⚠️ 无自动化覆盖**。

---

## 场景 3 播放了一些再次进入

场景 2 的完整版：反显到上次位置继续播，`played` 在基线上累加，MAX 防任何回退。

### 时间线

```
T0      进入，基线 { played_sec:12, position:30, stay_sec:40, finished:0 } → 反显 30s
T+5s    起播，30s → 50s 连续播放 20s（timeupdate 每秒差值 ∈ [0,1) 全部计入）
T+15s   心跳①；T+30s 心跳②
```

### 心跳与字段变化（完整数值示例）

| 跳 | played_sec = round3(12 + Δ) | position | stay_sec = round3(40 + 墙钟) |
|----|----|----|----|
| T+15（Δ播 10s） | round3(12+10) = **22** | **40** | round3(40+15) = **55** |
| T+30（Δ播 20s） | round3(12+20) = **32** | **50** | round3(40+20) = **60** |

### 服务端落库结果

| 跳 | played_sec（MAX） | stay_sec（MAX） | position（覆盖） | finished |
|----|----|----|----|----|
| 心跳① | MAX(12,22) = 22 | MAX(40,55) = 55 | 40 | 0（40 < 58.4117） |
| 心跳② | MAX(22,32) = 32 | MAX(55,60) = 60 | 50 | 0（50 < 58.4117） |

若此时乱序/重放心跳①，MAX 保证 32/60 不回退；position 会被旧值 40 覆盖，但下一跳即自纠（A2/B4 语义）。

### 列表页 / 续播反显表现

列表「继续播放」，副标题 `已播 81% · 续播位置 50s`（50/61.486 ≈ 81.3% 向下取整）；再次进入反显 50s 续播。

### 验证方法

1. 首次进入播放约 30s 后返回（造基线），记下 curl 的 `position`。
2. 重进、再播 20s，`curl -s "http://localhost:3000/api/records/video-7092?user_id=s3-0924"`。
3. 断言：`played_sec ≈ 基线 played + 20`、`position ≈ 基线 position + 20`、`stay_sec ≥ 基线 stay + 35`（进页到查询的墙钟）、列表百分比同步增长。

### 对应测试用例

心跳节奏与快照 → C1 + e2e「心跳定时上报：播放数秒后三指标增长」；基线合并 → C2；MAX 幂等/乱序 → A2/B3（`records.test.js`）；反显 → E2。**覆盖完整，无缺口**。

---

## 场景 4 播完后再进入

### 时间线

```
前置    播放至片尾：ended → reportNow 加发一跳（Detail.vue:84），position ≈ 61.486 ≥ 58.4117 → finished=1
        （注意：不必真播完——任意一跳 position ≥ 58.4117 即判完，如拖到 59s 处）
T0      再次进入：基线 { played_sec:61.5, position:61.486, stay_sec:70, finished:1 }
T+1s    反显 currentTime(61.486) → 播放器停在片尾
T+15s   心跳（未操作）
T+20s   拖回 5s，续播 10s（5s → 15s）
T+30s   心跳
```

### 心跳与字段变化

| 跳 | played_sec = round3(基线 + Δ) | position | stay_sec | finished |
|----|----|----|----|----|
| T+15（未操作） | round3(61.5+0) = **61.5** | **61.486** | round3(70+15) = **85** | 1 |
| T+30（拖回 5s 再播 10s） | round3(61.5+10) = **71.5** | **15**（覆盖回小值） | round3(70+30) = **100** | 1 |

### 服务端落库结果

`played_sec` 继续 MAX 上涨（61.5 → 71.5）；`position` 如实覆盖回 15（B4，不因已播完而锁值）；`finished` 短路保持 1（`store.js:108-110`）——**重温不计二次播完，finished 永不回退**。

### 列表页 / 续播反显表现

列表恒「已播完」绿 Tag（三态优先 finished，`store.js:166`），即使 position 已被拖回覆盖成小值（副标题会如实显示 `已播 24% · 续播位置 15s`）。再次进入反显在片尾（≈61.486，`Detail.vue:79` 反显的是库中最后 position）。

### 验证方法

接口层（对应 `features-and-testing.md` §4.1 步骤 4-5）：

```bash
curl -s -X POST http://localhost:3000/api/records/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"s4-0924","content_id":"video-7092","played_sec":60,"position":60,"stay_sec":65,"client_ts":1}'
curl -s "http://localhost:3000/api/records/video-7092?user_id=s4-0924"     # finished:1（60 ≥ 58.4117）
curl -s -X POST http://localhost:3000/api/records/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"s4-0924","content_id":"video-7092","played_sec":62,"position":5,"stay_sec":70,"client_ts":2}'
curl -s "http://localhost:3000/api/records/video-7092?user_id=s4-0924"     # finished 仍 1，position:5
```

页面层：播完 → 返回列表见绿「已播完」→ 重进反显片尾 → 拖回开头重看 → 列表仍绿「已播完」。

### 对应测试用例

95% 判完与永久性 → A3/B5（`records.test.js`）；position 覆盖 → B4 + smoke `[4/5]`；图文版手动验收 → §4.2 步骤 9-10。**「播完后再进入反显片尾 + 拖回重温」的端到端链路 ⚠️ 无自动化覆盖**（自动化只到接口层）。

---

## 场景 5 拖动进度条

### 时间线

```
T0      首次进入即播（基线 0）
T+10s   播至 10s，拖动进度条 10 → 50
T+15s   心跳①（50 → 55 已续播 5s）
T+20s   回拖 55 → 20，续播 3s
T+30s   心跳②
```

### 心跳与字段变化（数值示例表）

| 时点/操作 | 相邻 currentTime 差 | 计入 playedDelta？ | 快照 played_sec | 快照 position |
|----|----|----|----|----|
| 播放 0→10s | 每秒 ≈1，∈ [0,1) | 计入 10 | — | — |
| **前跳 10→50**（diff=40） | 40 ∉ [0,1) | **不计** | — | 50（position 立即跟随） |
| 续播 50→55（5s） | 每秒 ∈ [0,1) | 计入 5 | round3(0+15) = **15** | **55**（心跳①） |
| **回拖 55→20**（diff=−35） | <0 | **不计** | — | 20（立即跟随） |
| 续播 20→23（3s） | 每秒 ∈ [0,1) | 计入 3 | round3(0+18) = **18** | **23**（心跳②） |

### 服务端落库结果

心跳①：INSERT/UPDATE `played=15`（**40s 的拖动距离未虚增播放时长**）、`position=55`；心跳②：`played=MAX(15,18)=18`、`position=23`。拖动只影响 position 即时覆盖，不污染 played。

### 列表页 / 续播反显表现

列表副标题按最终 position 显示（如 `已播 37% · 续播位置 23s`）；下次进入反显在拖动后的位置。

### 验证方法

对应 `features-and-testing.md` §4.2 步骤 3-4：拖动到中部 → 连续播放 ≥15s → `curl -s http://localhost:3000/api/records` 对比：`position` 跳到拖动点附近，`played_sec` 增量 ≈ 实际播放秒数（不含拖动距离）；配合 2x 倍速可见 `played` 增速 < `stay` 增速。

### 对应测试用例

D1 全部 5 用例（`videoSource.test.js`：差值累加 / seek ≥1s 不计 / 负差回拖不计 / 2x 0.5s 正常计入 / destroy）。**机制层覆盖完整，无缺口**（e2e 无拖动用例，手动路径见上）。

---

## 场景 6 暂停

### 机制要点

视频暂停 ≠ hook 的 `pause()`：`Detail.vue` 全程未调用 `handle.pause()/resume()`（仅 `reportNow` 一处引用，`Detail.vue:84`），**心跳定时器照跑**。暂停期间 video.js 不再触发 `timeupdate` → `videoSource` 无新样本，`playedDelta` 与 `position` 自然冻结；`stay` 是 visible 墙钟，只要页面在前台就继续涨（`usePlayRecord.js:124-126`）。

### 心跳与字段变化（数值示例）

| 时刻 | 事件 | played_sec | position | stay_sec |
|----|----|----|----|----|
| T+15 | 播放 15s 后心跳 | 15 | 15 | 15 |
| T+20 | 暂停（timeupdate 停发） | — | — | — |
| T+30 | 心跳 | **20（平）** | **20（平）** | **30（涨）** |
| T+45 | 心跳 | 20 | 20 | 45 |
| T+50 | 恢复播放 | — | — | — |
| T+60 | 心跳 | **30（续涨）** | **30** | 60 |

### 服务端落库结果

暂停期间每次心跳仍 UPDATE：`played`/`position` 原值 MAX 无变化，`stay` 逐跳累加；恢复后三字段继续增长。

### 设计对照（spec 决策 #8）

设计规格「关键决策」表第 8 条（`docs/superpowers/specs/2026-09-22-play-record-heartbeat-design.md:57`）：**暂停语义——页面可见但视频暂停时：不停心跳，停留时长继续累计，播放时长停止累计；仅退出页面才停心跳**。理由：心跳兼作「用户在场」信号，`stay` 是墙钟在场指标，视频暂停不改变在场事实；真正离开页面走 0.6 退出矩阵才停跳。注意前提是「页面可见」——切后台连 stay 也冻结（场景 7 与 0.6 hidden 分支）。

### 验证方法

播放 ≥15s 后暂停 30s，期间两次执行 `curl -s http://localhost:3000/api/records`：`played_sec`/`position` 不变、`stay_sec` 每次 +15 左右；恢复播放一跳后三者继续增长。

### 对应测试用例

**⚠️ 无自动化直接覆盖。** C6 的 `pause()/resume()` 是「手动暂停心跳」路径（`usePlayRecord.test.js`），与「视频暂停不停跳」不同机制；「暂停期间 played 平/stay 涨」仅能由 D1（无 timeupdate 即无样本）+ C3（visible 墙钟）组合推导，无显式用例，现状靠手动验证。

---

## 场景 7 断网（三个子场景）

### 7a 心跳请求失败（断网中在线时长内的心跳全部 reject）

**行为**：`reporter.heartbeat(payload)` reject → catch **静默、不重试、无失败队列**（`usePlayRecord.js:151-153`）。恢复网络后**下一跳全量快照一次补齐**（快照永远 = 基线 + 全部会话增量），服务端 MAX 保证中间失败期无回退。

| 时刻 | 事件 | 服务端记录 |
|----|----|----|
| T+15 | 心跳成功（INSERT） | played 12 / position 12 / stay 15 |
| T+20 | DevTools 切 Offline | — |
| T+30 / T+45 | 心跳 fetch reject → 静默（L151-153） | 不变（12/12/15） |
| T+50 | 恢复 Online | — |
| T+60 | 心跳成功：played = round3(0+57) = **57**、position **57**、stay **60** | MAX(12,57)=57 / 57 / 60（57 < 58.4117，finished 仍 0） |

**验证方法**：进详情播放 → Network 面板切 Offline → 等 ≥30s（两次失败心跳，Console 无报错）→ curl 确认停在最后成功值 → 切回 Online 等 15s → curl 可见三字段一次跳到全量累计值。

**对应测试用例**：「心跳失败静默」（`usePlayRecord.test.js`，C 组）覆盖失败路径本身；「恢复后一次补齐」无专项断言，由 C1 全量快照 + A2 MAX 组合保证。

### 7b 断网中持续播放（本地累计不停，恢复后一次上报总量）

**行为**：断网只影响上报通道，采集与快照组装是纯内存操作（`playedDelta` 累加 `videoSource.js:30`、`staySessionMs` 墙钟 `usePlayRecord.js:116、124-126`），**本地累计不停**；期间每跳请求全部失败静默。恢复后首跳把**断网期间的全部增量一次性上报**。

| 时刻 | 事件 | 结果 |
|----|----|----|
| T+15 | 心跳成功 | played 12 / position 12 / stay 15 |
| T+20 → T+69.5 | 断网中持续播放至片尾（ended 的 reportNow 也失败静默） | 本地 playedDelta ≈ 61.486、position ≈ 61.486、stay 持续累加 |
| T+30/45/60/75 | 四跳全失败 | 服务端不变 |
| T+80 → T+90 | 恢复后首跳 | played = round3(0+61.486) = **61.486**、position **61.486**、stay **90** → MAX 吸收，61.486 ≥ 58.4117 → **finished=1** |

**验证方法**：Offline 后继续播放至片尾（页面正常播完，无任何报错）→ 恢复网络 → 等一跳 → `curl -s "http://localhost:3000/api/records/video-7092?user_id=s7b-0924"` 可见 played/stay 一次跳到全量、`finished:1`。

**对应测试用例**：**⚠️ 无自动化覆盖**（测试体系无离线模拟用例；机制由 C1 全量快照与 A2 MAX 保证）。

### 7c 断网中退出页面（beacon 双失败 → 自最后成功心跳之后的数据丢失）

**行为**：退出走 0.6 矩阵 beacon 补报；断网下 `navigator.sendBeacon` 返回 false → fallback `fetch keepalive` 也失败 → catch 静默（`usePlayRecord.js:83-85`）。**自最后一条成功心跳之后的全部会话增量丢失**（最大丢失量 = 最后成功心跳到退出的全部增量，断网多久可丢多久，理论上无上界）。下次进入以服务端最后成功值为基线续播——数据不回退（MAX），只是「变少/变旧」。

数值示例：最后成功心跳 T+15（12/12/15）→ T+20 断网续播至 T+40 关页 → 丢失 played ≈20s、stay ≈25s → 下次进入基线仍 {12, 12, 15}，反显 12s 处继续。

**验证方法**：Offline → 播 20s → 直接关闭标签页 → 恢复网络 → `curl -s "http://localhost:3000/api/records/video-7092?user_id=s7c-0924"` 仍为断网前最后成功值 → 重进详情反显在该旧位置。

**对应测试用例**：beacon 双失败的 **fallback 链有单测**（C5：sendBeacon 失败/不可用 → fetch keepalive，`usePlayRecord.test.js`）；**真实断网环境的补报丢失 ⚠️ 无自动化覆盖**（与 `features-and-testing.md` 第三部分 #3/#4 的真机 WebView 环境受限项同源）。

---

## 附录 A：七场景 × 测试覆盖矩阵

| 场景 | 自动化覆盖（资产编号 → 用例） | 缺口 |
|------|-------------------------------|------|
| 1 首次进入 | A1 INSERT（`records.test.js`）、A4 零值默认、A5 三态 + e2e「列表三态渲染」 | ⚠️「进入未播满 15s / 秒退补报即产生记录 → 列表变继续播放」场景链路无覆盖 |
| 2 二次进入 | E2 反显（`Detail.test.js` + e2e「续播反显与 video.js 控制条」）、C2 基线合并 | ⚠️ 秒退 position 归零边界无覆盖（附录 B 边界 1） |
| 3 播放一些再进入 | C1 + e2e「心跳定时上报」、C2、A2/B3 MAX、E2 | 无 |
| 4 播完后再进入 | A3/B5 判完永久、B4 position 覆盖、smoke `[4/5]`、手动 §4.1 步骤 4-5 | ⚠️「播完反显片尾 + 拖回重温」端到端链路无覆盖（自动化止于接口层） |
| 5 拖动进度条 | D1 全部 5 用例（`videoSource.test.js`）+ 手动 §4.2 步骤 3-4 | 无（机制层完整；e2e 无拖动用例，不构成缺口） |
| 6 暂停 | C6 `pause()/resume()`（注意：是手动暂停心跳，非视频暂停） | ⚠️「视频暂停：心跳不停 / played 平 / stay 涨」无显式用例，仅 spec 决策 #8 口径 + 手动 |
| 7a 心跳请求失败 | 「心跳失败静默」（`usePlayRecord.test.js`） | 半缺口：「恢复后一次补齐」无专项断言（由 C1+A2 组合保证） |
| 7b 断网中持续播放 | —— | ⚠️ 无自动化覆盖（无离线模拟） |
| 7c 断网中退出 | C5 beacon fallback 链单测 | ⚠️ 真实断网退出丢数据无覆盖（真机项，同 features-and-testing 第三部分 #3/#4） |

**缺口计数**：9 行中 **2 行全覆盖**（场景 3、5）、**7 行存在缺口**——其中场景 1/2/4/7c 为「机制已覆盖、场景链路缺」的部分覆盖，场景 6/7b 整体缺，7a 为半缺口。

## 附录 B：已知边界与待扩展配置项

### 边界 1：秒退 position 归零（场景 2，无覆盖）

- 机制：switchable 空源零值兜底（`Detail.vue:37`）× 服务端 position 直接覆盖（`store.js:128`）。
- 触发：退出补报早于「videojs 初始化 + 反显」完成（hidden beacon / pagehide / unmount 均可触发）。
- 后果：历史 position 被覆盖为 0（如 30 → 0），下次反显从头；played/stay 因 MAX 不受影响。
- 根治建议：attach 前快照 position 兜底取 `基线.position`，或采用下方 `startPolicy: 'first-play'`。

### 边界 2：进入即产生记录（业务语义待确认）

任意一次成功上报即 INSERT——含 `played=0 / position=0 / 仅 stay` 的快照与秒退零值补报，列表随之从「未开始」变「继续播放」（副标题 `已播 0% · 续播位置 0s`）。需业务确认「进入满 15s 未播放也算继续播放」是否合意；不合意则同以 `first-play` 策略根治。

### 待扩展配置项（设计稿未实现，全仓 src/server/e2e 均无对应代码，当前不存在这些分支）

- **`startPolicy: 'mount' | 'first-play'`**：`first-play` 下 hook 挂载后进入 armed 态——不启计时、退出不补报，首次真正播放才激活；用于杜绝「armed 未激活退出」的零值补报，防三态污染（根治边界 1/2）。
- **`stopPolicy: 'manual' | 'on-ended'`**：`on-ended` 下 ended 触发停跳 + 冻结停留 + 最后一报；现状 ended 仅 `reportNow()` 加发一跳（`Detail.vue:84`），interval 照跑、片尾停留会继续累计 stay。
