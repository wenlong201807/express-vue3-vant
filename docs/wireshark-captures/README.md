# Wireshark 心跳抓包证据档案（2026-09-24 实测）

本目录是「用 Wireshark 对心跳机制做真实抓包实测」三场景的原始证据入档。操作步骤、过滤器速查与判读方法见 **[docs/wireshark-sop.md](../wireshark-sop.md)**；行为口径见 [docs/scenarios-heartbeat.md](../scenarios-heartbeat.md)。

- 抓包接口：`lo0`（macOS loopback；实测 localhost 流量在包里显示为 IPv6 `::1` 与 IPv4 `127.0.0.1` 双栈并存，仍都走 lo0）
- 抓包命令（三场景统一）：`/Applications/Wireshark.app/Contents/MacOS/tshark -i lo0 -f "tcp port 3000" -B 4096 -w <文件>.pcapng`
- 抓包对象是 **vite(5173) → express(3000) 的上游代理腿**：浏览器 fetch/beacon 先到 5173，由 vite proxy 转发到 3000；JSON body 在 3000 腿上明文可读
- 驱动方式：Playwright 内联脚本（`channel: 'chrome'`、375×667 视口、每场景唯一 userid `cap-N-时间戳`），非 e2e 套件
- **环境噪声声明**：实测期间本机有一个滞留的旧详情页标签页（`user_id=guest`，暂停态每 15s 照常心跳，stay 已累计 3.8 小时+）持续产生噪声帧。所有 `.txt` 中均已标注 guest 帧；判读本会话时用显示过滤 `http.file_data contains "cap-N-"`。这本身也是一条 useful 教训：**共享 dev 环境抓包，必须按 user_id 归属帧**

## 文件清单

| 文件 | 内容 |
|----|----|
| `01-baseline.pcapng` / `.txt` / `-post.txt` | 场景 1 基线心跳 |
| `02-offline-recovery.pcapng` / `.txt` / `-post.txt` | 场景 2 断网与恢复（服务不可达语义） |
| `03-hidden.pcapng` / `.txt` / `-post.txt` | 场景 3 hidden 心跳（beacon + 停跳 + 恢复） |

每个场景三件套：
- `.pcapng`：原始抓包（用 Wireshark 打开可逐帧复查）
- `.txt`：关键帧导出 + 逐帧解读 + 与预期的符合性判定（自足可读，不依赖打开 pcapng）
- `-post.txt`：一条完整 POST 的 `tshark -z follow,tcp,ascii,<流号>` 流跟随（含请求头、JSON body、响应）

## 场景 1 基线心跳（01-baseline.*）

- **做法**：详情页（`video-7092`）点击大按钮播放 35s，无任何网络扰动
- **命令**：`tshark -r 01-baseline.pcapng -Y 'http.request.method=="POST" && http.file_data contains "cap-1-"' -T fields -e frame.number -e frame.time_relative -e http.file_data`
- **关键帧**：frame 934（t=15.936）与 frame 962（t=30.931）两条心跳 POST
- **结论**：两跳间隔 **14.995s ≈ 15s**；body 三指标递增（played 14.344 → 29.486、position 14.379 → 29.521、stay 15.002 → 30.004，stay 增量恰为 15.002 的可见墙钟）；停抓后 `GET /api/records` 佐证与末跳 body 完全一致。**判定：符合预期**
- 另记录：hook 的 `loadBaseline()`（frame 7）与 Detail.vue 的 `getRecord()`（frame 31）是同 URL 的两次基线 GET，调用方不同，非异常

## 场景 2 断网与恢复（02-offline-recovery.*）

- **做法**：播放跨过首跳（t=15.004 成功，played=14.338）→ `pkill` 掉 dev:server 并 `kill -9` 3000 监听进程 → 断网窗口继续播 20s → 重启 dev:server → 次跳送达
- **关键帧**：
  - frame 955-958（t=21.792）：杀服瞬间的 SYN→RST\|ACK（双栈）
  - frame 967-970（t=30.233）：断网中本会话一跳落空——SYN→RST\|ACK，零 HTTP 字节
  - frame 983（t=42.374）：新进程 `GET /api/health` 200
  - frame 1009（t=45.005）：恢复首跳 played=**44.354**（对比断网前 14.338，Δ+30.016s 一次补齐，含断网窗口 15s 增量）
- **结论**：断网窗口内零成功 POST、失败静默无重试；恢复首跳 payload 全量累计；stay=45.002 与墙钟一致（断网不冻停留）。**判定：符合预期**（对应 scenarios-heartbeat.md 场景 7a/7b）
- **实测踩坑（已写进 SOP）**：① server 与 vite 必须分进程起（否则杀 server 腿时 `npm run dev` 的 concurrently/进程组会带走 vite，浏览器 fetch 死在 5173，3000 上永远看不到 RST 与恢复）；② 杀 3000 必须 `lsof -ti:3000 -sTCP:LISTEN`——不加 `-sTCP:LISTEN` 会把「**远端**端口=3000」的 vite 代理进程一并杀掉（实测踩了 2 次）；③ dev:server 重启即清空内存 store，「补齐」只能以 payload 数值差为证，不能用服务端前后对比

## 场景 3 hidden 心跳（03-hidden.*）

- **做法**：播放 3s → `Object.defineProperty(document,'visibilityState',{value:'hidden'})` + `dispatchEvent(new Event('visibilitychange'))`（参考 e2e 用例 2 写法）→ hidden 保持 22s → 恢复 visible → 再等 17s
- **关键帧**：
  - frame 775（t=5.064）：hidden 瞬间**恰好一条** beacon POST（`played=3.985 / position=4.015844 / stay=4.437`，stay 为冻结时刻的可见墙钟）
  - t=5.1 → 27.2（22s）：本会话**零 POST**（跨过原 15s 心跳点；同窗 guest 噪声在 6.739/21.745 照跳，反证链路通畅）
  - frame 977（t=42.587）：恢复后首跳 `played=41.439 / stay=19.438`
- **结论**：**stay=19.438 = 4.437（隐藏前）+ 15.001（恢复后）**——22s hidden 被完整冻结剔除，C3「hidden 停留冻结」的数值铁证；played=41.439 连续覆盖隐藏期（视频未暂停时播放量照常累计，停的只是心跳与停留钟）；恢复点到首跳 15.4s ≈ 15s。**判定：符合预期**
- **判读提示**：beacon 与心跳 POST 同端点且经代理后请求头逐字节一致（实测 diff 仅 content-length 差 2 字节），区分只能靠**时机**（是否在 15s 网格上）与 **body 的 stay 值**（冻结墙钟 vs 15s 整数倍附近）
