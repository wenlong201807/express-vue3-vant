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
