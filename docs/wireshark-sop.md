# Wireshark 使用 SOP（通用篇 + 心跳场景专章）

> 用途：对本项目「播放记录心跳」做**真实抓包实测**的标准作业程序。所有步骤与数值均经 2026-09-24 本机实测验证，
> 证据入档于 [docs/wireshark-captures/](wireshark-captures/README.md)（三个 .pcapng + 关键帧导出 + 完整 POST 抽取）。
> 行为口径的权威来源是 [docs/scenarios-heartbeat.md](scenarios-heartbeat.md)（本篇场景 2/3 分别对应其场景 7a/7b 与 0.6 退出矩阵 hidden 分支）。

---

## 第一部分 通用篇

### 1.1 Wireshark 是什么

Wireshark 是图形化网络封包分析器：把网卡（或回环口）上经过的数据帧原样录下来（**抓包**），再按协议栈逐层解码
（以太网 → IP → TCP → HTTP），让人能读到每一个请求的 method/URI/头部/body。配合命令行版 `tshark` 可脚本化完成同样的工作。

本项目用它验证三件事，这三件事是日志/单测/e2e 都给不了的「线上视角」：

1. 心跳是否**真的发出了**网络包（而不是只在应用层调了函数）；
2. 请求**何时**发出（15s 网格、hidden 瞬间）、**几次**发出（失败是否重试）；
3. 失败时链路上**到底发生了什么**（TCP RST 连接拒绝、超时、还是根本没发包）。

### 1.2 安装（macOS）与抓包权限（ChModBPF 机制）

1. 官网下载 macOS `.dmg`（Arm/Intel 按机器选择），把 `Wireshark.app` 拖入 `/Applications`。
2. 安装器默认附带 **ChModBPF** 配置步骤：它在系统里创建 `access_bpf` 用户组，并把安装时输入的管理员用户加入该组，
   同时由 LaunchDaemon 把 `/dev/bpf*` 设备的属组设为 `access_bpf`、权限 `crw-rw----`。BPF（Berkeley Packet Filter）
   设备是 macOS 上抓包的底层入口——**不进 `access_bpf` 组（或不在 admin 组）就无法抓包**。
3. 组变更需要**注销重登**（或重启）才生效。
4. 验证（无需 sudo）：

```bash
ls -la /dev/bpf*                     # 期望 crw-rw---- 1 root access_bpf
/Applications/Wireshark.app/Contents/MacOS/tshark -D        # 列出所有接口
/Applications/Wireshark.app/Contents/MacOS/tshark -i lo0 -c 1   # 抓 1 包实测权限
```

5. CLI 不在 PATH 里（二进制都在 app bundle 内），建议加别名：

```bash
export PATH="/Applications/Wireshark.app/Contents/MacOS:$PATH"   # 之后可直接用 tshark / dumpcap / editcap / capinfos
```

> 若 `-c 1` 报 `Permission denied`：说明当前用户不在 `access_bpf` 组——重跑安装 pkg 勾选 ChModBPF 并重登；
> 实在没有就用 `sudo tshark ...`（不推荐，且本篇所有命令均为无 sudo 实测）。

### 1.3 界面速览（GUI 三栏 + 两个过滤器框）

| 区域 | 作用 |
|----|----|
| 过滤器栏（绿/红） | **显示过滤器**，只影响「看」，不影响「录」。语法正确变绿，错误变红 |
| 帧列表（上） | 每行一帧：序号、相对时间、源/目的、协议、长度、信息列 |
| 帧详情（中）/ 字节流（下） | 点开一帧逐层看解码字段 / 原始十六进制。HTTP body 在「Frame → … → HTTP → … body」可直读 |
| 状态栏 | 右侧常驻「已捕获/已显示」帧数——两者差值 = 显示过滤器滤掉的量，用来确认没抓错 |

抓包入口：Wireshark → 菜单「捕获 → 选项」，选接口、填捕获过滤器、Start。本篇以命令行为主（可复现、可入档），GUI 适合人工复核。

### 1.4 抓 lo0 的特殊性（localhost 流量不走物理网卡）

- `http://localhost:3000` 的流量**不经过 en0/Wi-Fi**，在 en0 上抓什么都没有——必须选 **Loopback: lo0**（tshark `-i lo0`）。这是新手第一坑：接口选错 = 永远抓不到，且不报错。
- 同机两端（vite 5173 ↔ express 3000）的包一进一出都出现在 lo0 上，所以一次抓包同时看到双向数据。
- **双栈并存**：Node ≥17 把 `localhost` 优先解析为 IPv6 `::1`，因此同一会话里常见 `::1:5173 → ::1:3000` 与 `127.0.0.1` 两套连接并存（本实测每一跳都伴随双栈连接尝试）。过滤器按端口写（`tcp port 3000`）即可同时命中两个栈，不要按 IP 写。
- lo0 上没有以太网头，帧结构与物理网卡不同（对 HTTP 层判读无影响）。
- **明文前提**：HTTP 明文时 POST 的 JSON body 可直接读（本项目 dev 环境即如此）；一旦走 HTTPS 见 1.8 与「常见误读」#4。

### 1.5 过滤器速查：抓包过滤器（-f/BPF） vs 显示过滤器（-Y）

两者语法完全不同，混用是最常见的报错来源：

| 用途 | 命令/写法 | 说明 |
|----|----|----|
| 抓包过滤（-f，BPF 语法，内核层丢弃，省资源） | `tshark -i lo0 -f "tcp port 3000" -w a.pcapng` | 只录 3000 端口的 TCP；**不能写 http 字段**（BPF 不解应用层） |
| 显示过滤：只看 HTTP 请求 | `-Y "http.request"` | |
| 显示过滤：只看心跳 | `-Y 'http.request.uri contains "heartbeat"'` | |
| 显示过滤：按会话归属（本项目按 userid） | `-Y 'http.file_data contains "cap-1-"'` | body 含 userid，多标签页/多会话共抓时是唯一可靠归属法 |
| 显示过滤：只看 RST | `-Y "tcp.flags.reset==1"` | 断网/拒绝证据 |
| 显示过滤：SYN（连接发起） | `-Y "tcp.flags.syn==1 && tcp.flags.ack==0"` | 与 RST 配对看「发了连不上」 |
| GUI 输入等价 | 同 -Y 语法，直接填过滤器栏 | |

常用组合（本项目实测可直接抄）：

```bash
# 1) 抓包（后台，写文件）
tshark -i lo0 -f "tcp port 3000" -B 4096 -w out.pcapng &
# 2) 请求清单：第几帧 / 相对时间 / 方法 / URI
tshark -r out.pcapng -Y "http.request" -T fields \
  -e frame.number -e frame.time_relative -e http.request.method -e http.request.uri
# 3) 心跳 body 全量（含 JSON 数值）
tshark -r out.pcapng -Y 'http.request.method=="POST" && http.request.uri contains "heartbeat"' \
  -T fields -e frame.number -e frame.time_relative -e http.file_data
# 4) 抽一条完整 POST（请求头+body+响应）：先查流号，再流跟随
tshark -r out.pcapng -Y 'frame.number==962' -T fields -e tcp.stream      # → 8
tshark -r out.pcapng -z follow,tcp,ascii,8 -q                            # 人读全文
```

### 1.6 导出与分享

| 产物 | 命令 | 适用 |
|----|----|----|
| 原始抓包 | `-w out.pcapng`（`-i lo0 -f "..."`） | 唯一可复查的原始证据；pcapng 格式保留接口/注释等元数据 |
| 关键帧清单 | `-Y "<显示过滤>" -T fields -e frame.number -e frame.time_relative -e ...` | 入档文本、代码评审可读 |
| 流跟随全文 | `-z follow,tcp,ascii,<流号> -q` | 一条请求的完整上下文（头/body/响应） |
| 文件体检 | `capinfos out.pcapng`（包数/时长/首末时间） | 确认抓包没断、时间范围对 |
| GUI 导出 | File → Export Specified Packets（按显示过滤裁剪 pcapng）；File → Export Packet Dissections → As Plain Text | 给只装 Wireshark 的同事 |

分享规范：**pcapng + 关键帧 .txt（写明帧号）+ 判读结论**三件套一起给。文本里必须给出复现过滤器与帧号，
让 receiving 方不打开 pcapng 也能核对；体积过大时可用 `editcap -Y "<显示过滤>" in.pcapng out.pcapng` 裁剪，
但**必须在档案里注明裁剪命令与前后包数**（本项目三份 pcapng 均为原始全量，未裁剪）。

---

## 第二部分 项目专章：心跳三场景逐步 SOP

### 0 环境与准备（两个实测换来的硬性前置）

1. **server 与 vite 必须分进程起**（场景 2 的生死线）：

```bash
npm run dev:server   # node --watch server/index.js → :3000
npm run dev:client   # vite → :5173，/api 与 /source 代理到 3000
```

   不要用 `npm run dev`（concurrently）：实测杀掉 server 腿时整个进程组会把 vite 一起带走，浏览器 fetch 全部死在
   5173，**3000 上看不到任何 RST 也看不到恢复**——场景 2 直接失效。
2. 浏览器需能播 H.264 mp4：用本机 Chrome（`channel: 'chrome'`），内置 Chromium 不行。
3. 抓包前自查权限（1.2 第 4 步）。接口用 `lo0`，捕获过滤器 `tcp port 3000`，缓冲 `-B 4096`（lo0 上全机回环流量共享，加大缓冲防丢包）。
4. **共享 dev 环境噪声**：任何开着的详情页标签页都在以 15s 节奏发心跳（实测有一 `user_id=guest` 的滞留标签页全程噪声）。
   每场景用唯一 userid（`cap-N-时间戳`），判读一律加 `http.file_data contains "cap-N-"` 归属过滤。
5. 驱动方式二选一：Playwright 内联脚本（本实测用法：375×667 视口、`page.click('.vjs-big-play-button')` 起播、
   hidden 用 `Object.defineProperty(document,'visibilityState',{value:'hidden'})` + `dispatchEvent` 伪造，
   写法同 [e2e/play-record.e2e.spec.js](../e2e/play-record.e2e.spec.js) 用例 2）；或人工在 Chrome 里操作，抓包命令不变。

通用节奏：**起服 → 起抓 → 驱动 → 停抓 → 解读**。停抓用 `kill -TERM <pid>`（SIGTERM 让 dumpcap 正常收尾落盘，
`kill -9` 会截断文件）。

---

### 场景 1 基线心跳（预期：15s 一跳，三指标递增）

对应 scenarios-heartbeat.md 场景 1/3 的时间线与 §0.2 快照公式。

```bash
# 1) 起抓
tshark -i lo0 -f "tcp port 3000" -B 4096 -w docs/wireshark-captures/01-baseline.pcapng &
# 2) 驱动：详情页播放 35s（覆盖 T+15、T+30 两个心跳点）
node driver1.js        # goto /detail/video-7092?userid=cap-1-<ts> → 点击大按钮 → 等 35s
# 3) 停抓
kill -TERM %1
```

**预期帧与实测证据**（详见 [01-baseline.txt](wireshark-captures/01-baseline.txt)）：

| 帧 | t(s) | 内容 | 实测值 |
|----|----|----|----|
| 934 | 15.936 | POST /api/records/heartbeat | played=14.344 position=14.379453 stay=15.002 |
| 962 | 30.931 | POST /api/records/heartbeat | played=29.486 position=29.521222 stay=30.004 |

- 两跳间隔 **14.995s ≈ 15s**；stay 增量恰 15.002（可见墙钟）；played/position 递增且相互贴近（快照口径）。
- 服务端佐证：停抓后 `curl "http://localhost:3000/api/records/video-7092?user_id=cap-1-<ts>"` 返回与末跳 body 逐字段一致。
- 顺带可读到 frame 7/31 两条**同 URL** 的 `GET /api/records/:id`：一条来自 hook `loadBaseline()`（setup 即发），
  一条来自 Detail.vue `getRecord()`（`/api/contents` 返回后 16ms）——调用方不同，非重复请求缺陷。
- 抽完整 POST：frame 962 → `tcp.stream 8` → `-z follow,tcp,ascii,8`（证据：01-baseline-post.txt，含 200 OK 响应）。

**解读要点**：心跳在 15s 网格上允许 ±0.5s 提前（Chrome 定时器量化，项目既有口径）；首跳值 ≈ 开播时刻到首跳点的真实播放量。

---

### 场景 2 断网与恢复（预期：RST 拒绝 + 静默 + 次跳一次补齐）

对应 scenarios-heartbeat.md **场景 7a/7b**。**localhost 的「断网」= 服务不可达**：本机没有真网线可拔，
语义等价物是把 3000 的监听进程杀掉，让 SYN 得到 RST（连接拒绝）。

```bash
# 1) 起抓
tshark -i lo0 -f "tcp port 3000" -B 4096 -w docs/wireshark-captures/02-offline-recovery.pcapng &
# 2) 驱动（分三段）：播 18s（首跳成功）→ 杀后端 → 断网播 20s → 重启后端 → 播 18s
#    杀（注意两处实测坑）：
pkill -f "node --watch server/index.js"
lsof -ti:3000 -sTCP:LISTEN | xargs kill -9      # ★必须 -sTCP:LISTEN，见「常见误读」#5
#    重启：
npm run dev:server &                             # 等待 curl /api/health 通
# 3) 停抓：kill -TERM %1
```

**预期帧与实测证据**（详见 [02-offline-recovery.txt](wireshark-captures/02-offline-recovery.txt)，时间轴以抓包起点为 0）：

| 帧 | t(s) | 内容 | 判读 |
|----|----|----|----|
| 945 | 15.004 | 心跳成功：played=14.338 stay=15.002 | 断网前最后落库值 |
| 955-958 | 21.792 | SYN→RST\|ACK ×2（::1 与 127.0.0.1） | 杀服瞬间在途连接被拒 |
| 967-970 | 30.233 | SYN→RST\|ACK ×2，**零 HTTP 字节** | 断网中本会话一跳落空：node 先试 `::1` 被拒、再试 `127.0.0.1` 被拒 → ECONNREFUSED |
| 983 | 42.374 | `GET /api/health` 200 | 新进程就绪 |
| 1009 | 45.005 | 恢复首跳：played=**44.354** stay=45.002 | **一次补齐**：44.354 − 14.338 = +30.016s（断网窗口 15s 增量 + 恢复后 15s） |

- **断网窗口（21.8 → 42.4）内零成功 POST**；无重试、无失败队列（15.004 → 45.005 整 30.001s，即断网只吞掉中间那一跳，定时器节奏不受影响）。
- **stay=45.002 与墙钟连续**——断网不冻停留（采集与快照是纯内存操作，只有上报通道被堵），这正是 7b「本地累计不停、恢复一次补齐」的包层证据。
- 抽完整对比：断网前 frame 945（stream 6）与恢复首跳 frame 1009（stream 17）的 body 并排读（02-offline-recovery-post.txt）。
- 佐证边界（如实记录）：dev:server 重启会**清空内存 store**，所以「补齐」以 payload 数值差为证，不能用服务端前后对比。
  真要服务端佐证，可在不重启的条件下用 DevTools Offline 或 `context.route` 拦截（e2e 场景 7b 的做法）。

**真断网与 localhost 断网的观测差异**（写报告时必须区分）：

| | localhost 杀服（本场景） | 真断网（远端域名拔网/切飞行模式） |
|----|----|----|
| 链路特征 | SYN→RST\|ACK，毫秒级 | SYN 发出后**无应答**，TCP 数次重传后超时，秒级，**无 RST** |
| Wireshark 判据 | `tcp.flags.reset==1` | 同一流的多次 SYN 重传 + 无任何回应 |
| 应用层结果 | 相同：fetch reject → catch 静默 → 次跳全量补齐 | 相同 |

---

### 场景 3 hidden 心跳（预期：hidden 瞬间一条 beacon，期间零 POST，恢复续跳）

对应 scenarios-heartbeat.md §0.6 退出矩阵 hidden 分支与 §C3。

```bash
tshark -i lo0 -f "tcp port 3000" -B 4096 -w docs/wireshark-captures/03-hidden.pcapng &
# 驱动：播放 3s → 伪造 hidden → 保 22s（必须跨过原 15s 心跳点）→ 恢复 visible → 再等 17s
kill -TERM %1
```

伪造 hidden（真实切后台/切屏也触发同一事件路径，但 headless/自动化下用代码伪造更可控）：

```js
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
})
```

**预期帧与实测证据**（详见 [03-hidden.txt](wireshark-captures/03-hidden.txt)）：

| 帧 | t(s) | 内容 | 判读 |
|----|----|----|----|
| 775 | 5.064 | **一条** beacon POST：played=3.985 stay=**4.437** | hidden 瞬间补报；stay 冻结在可见墙钟 |
| — | 5.1 → 27.2 | **零 POST**（22s，跨过原 15s 心跳点） | `stopTimer` 生效；同窗 guest 噪声照跳反证链路通畅 |
| 977 | 42.587 | 恢复后首跳：played=41.439 stay=**19.438** | 恢复点到首跳 15.4s ≈ 15s，心跳续跳 |

- **数值铁证（可手工复算）**：stay = 19.438 = 4.437（隐藏前）+ 15.001（恢复后）→ **22s hidden 被完整冻结剔除**；
  played = 41.439 连续覆盖隐藏期 → 视频未暂停时播放量照常累计，停的只是心跳与停留钟。
- beacon 判定：hidden 派发到 POST 上报间隔 <0.1s（心跳做不到——它只在 15s 网格上）。
- 抽完整 POST：frame 775 → `tcp.stream 5`（03-hidden-post.txt）。

---

### 常见误读（每条都来自本次实测或实测排查过程）

1. **「看不到任何包」**：九成是接口选错（在 en0 上抓 localhost）或权限不足（`access_bpf` 组，见 1.2）；
   其次是捕获过滤器写错（`-f` 里写了 `http.request`——BPF 不解应用层，直接一个包都抓不上）。
   自查顺序：`tshark -i lo0 -c 1` 有输出 → 权限 OK；去掉 `-f` 抓 10s 看有没有回环流量 → 接口 OK。
2. **「RST = 数据丢了」**：RST 只是**拒绝信号**（这里=3000 没人监听）。本项目全量快照 + 服务端 MAX 幂等设计下，
   RST 之后的增量由次跳一次补齐（场景 2 实测 +30.016s 一跳补齐）——在 pcap 里看到 RST 不能推断「丢数据」，
   反之场景 7c（断网中退出页面、beacon 双失败）才会真丢，且丢在「根本没有包发出去」，pcap 表现为**静默无包**而非 RST。
3. **「这条 POST 是心跳还是 beacon？」**：两者同端点同方法，且经 vite 代理后**请求头逐字节一致**
   （实测 diff 仅 content-length 差 2 字节），只能靠：① 时机——beacon 在 hidden/退出瞬间，心跳在 15s 网格；
   ② body 的 stay——beacon 是冻结时刻的可见墙钟（如 4.437），心跳 ≈15s 的整数倍附近。
4. **「HTTPS 远端部署后怎么抓」**：真机/远端走 HTTPS 时，Wireshark 只能读到 TLS 记录（SNI、证书、密文长度），
   **URI 与 body 全部不可见**，`http.*` 显示过滤一条都出不来。两条路：① 配合解密——浏览器设 `SSLKEYLOGFILE`
   环境变量后在 Wireshark 里 Preferences → Protocols → TLS → (Pre)-Master-Secret log filename 导入；
   ② 退回 DevTools Network 面板（所见即应用层真值），Wireshark 只留作时序/失败形态（RST、重传、超时）的辅助证据。
   本项目 dev 环境是 HTTP 明文，才有 body 直读的便利。
5. **「一杀 3000，前端页面也挂了」**：`lsof -ti:3000 | xargs kill -9` 会把「**远端**端口=3000」的进程一起杀——
   vite 代理恰好持有大量这样的上游 socket，于是代理被误杀，浏览器 fetch 死在 5173，**pcap 里既没有 RST 也没有恢复**，
   场景 2 静默失效且不易察觉（本次实测连踩两次）。必须 `lsof -ti:3000 -sTCP:LISTEN`，且杀完立即
   `curl -o /dev/null -w '%{http_code}' http://localhost:5173` 验证 vite 仍 200。同理别用 `npm run dev` 起服。
6. **「pcap 里多出来的心跳不是我发的」**：共享 dev 环境里任何开着的详情页都会发心跳（本实测的 `guest` 噪声标签页）。
   一切判读先按 `http.file_data contains "<你的userid>"` 归属，再谈间隔与数值。
7. **「间隔不是整 15s」**：15.0 ±0.5s 内都正常（Chrome 定时器量化，项目既有 ±0.5 容差口径）；恢复后的首跳还要加上
   visible 事件到 `startTimer` 的调度时延（实测 15.4s）。
8. **「重启 dev:server 后服务端数值对不上」**：store 是内存存储，重启即清零。跨重启的验证只能用 payload 数值差，
   或改用不重启的断网手段（DevTools Offline / e2e `context.route`）。

### 交叉引用

- 场景 2（本篇）↔ [docs/scenarios-heartbeat.md](scenarios-heartbeat.md) 场景 7a（失败静默）/ 7b（本地累计不停、一次补齐）；
  差异：SOP 版用「杀 3000 监听进程」制造断网（有 RST 可抓），scenarios 版用 DevTools Offline / `context.route`
  （不动服务端，store 不清零）——两种手段互补，判读口径一致。
- 场景 3（本篇）↔ scenarios-heartbeat.md §0.6 退出矩阵 hidden 分支 + 场景 7c 的对照面：hidden 期间**有** beacon 补报
  （hidden 瞬间链路还通），断网中退出则 beacon 双失败（7c，真丢）。三者的包层差异：成功 POST / RST / 完全静默。
- 自动化覆盖：e2e「场景7b 断网恢复」与 hook 单测（`usePlayRecord.test.js`）验证同一语义的应用层行为；
  本篇 Wireshark 实测补上了它们给不了的**网络层形态**（RST、双栈连接尝试、15s 网格、beacon 时机）。
