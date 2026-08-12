#!/usr/bin/env bash
# Round 2 자동 배포 스크립트
# 1) 런닝맨(e_28f745ac) 재분석 완료 대기
# 2) 현재 shorts.json 스냅샷 (AFTER1)
# 3) 워커 + 서버 kill
# 4) 서버 재부팅
# 5) 워커 재시작
# 6) purge → 8건 재큐잉 (Round 2 코드로 진행)
# 7) 재분석 시작 확인

set -u
LOG_PREFIX="[round2-deploy]"
log() { echo "$LOG_PREFIX $*"; }

# ── 1) 런닝맨 완료 대기 ─────────────────────────────────
log "런닝맨 (e_28f745ac) 완료 대기 중..."
WAIT_START=$(date +%s)
while true; do
  data=$(curl -s http://localhost:4100/api/state 2>/dev/null)
  info=$(echo "$data" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for e in d.get('episodes', []):
        if e.get('id') == 'e_28f745ac':
            p = e.get('pipeline') or {}
            print(f\"{p.get('stage','-')}|{p.get('progress','')}|{p.get('note','')[:60]}\")
            sys.exit(0)
    print('NOT_FOUND|0|')
except Exception as ex:
    print(f'ERR|0|{ex}')
" 2>/dev/null)
  IFS='|' read -r stage pct note <<< "$info"
  elapsed=$(($(date +%s) - WAIT_START))
  log "런닝맨 상태: $stage ${pct}% · $note · 대기 ${elapsed}s"
  if [ "$stage" = "recommend" ] && [ "$pct" = "100" ]; then
    log "✅ 런닝맨 완료 감지"
    break
  fi
  if [ "$stage" = "done" ]; then
    log "✅ 런닝맨 완료 (done)"
    break
  fi
  # 60분 이상이면 포기
  if [ "$elapsed" -gt 3600 ]; then
    log "⚠️ 런닝맨 60분 초과 대기 — 진행"
    break
  fi
  sleep 30
done

# ── 2) 스냅샷 (AFTER1) ─────────────────────────────────
SNAP="C:/Users/STEPAI05/STEPD-repo/eval/snapshots/after-round1-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP"
log "스냅샷 생성: $SNAP"
for mid in m_f68e68c5 m_153d4e79 m_84c95ff0 m_40c6e6cd m_44922642 m_5ec98a5a m_789b0e6b m_99c7702b; do
  src=C:/Users/STEPAI05/STEPD-repo/apps/server/storage/analysis/$mid
  if [ -d "$src" ]; then
    mkdir -p "$SNAP/$mid"
    cp -p "$src/shorts.json" "$SNAP/$mid/" 2>/dev/null && log "  snap $mid shorts.json"
    cp -p "$src/analysis.json" "$SNAP/$mid/" 2>/dev/null
  fi
done

# ── 3) 워커 + 서버 kill ─────────────────────────────────
log "워커 + 서버 종료 중..."
powershell -Command "
\$targets = wmic process where \"name='node.exe'\" get ProcessId,CommandLine /format:list 2>&1 | Out-String
\$pids = @()
\$currentPid = \$null
foreach (\$line in \$targets -split \"\`n\") {
  if (\$line -match 'ProcessId=(\d+)') { \$currentPid = \$matches[1] }
  elseif (\$line -match 'src[/\\\\](worker|index)\.ts') { \$pids += \$currentPid }
}
foreach (\$id in \$pids) {
  try { Stop-Process -Id \$id -Force -ErrorAction Stop; Write-Output \"killed \$id\" } catch { Write-Output \"skip \$id\" }
}
" 2>&1 | while read line; do log "  $line"; done

sleep 3
# python whisper 폴백 자식이 있으면 그것도
powershell -Command "Get-Process python -ErrorAction SilentlyContinue | Where-Object { \$_.StartTime -gt (Get-Date).AddHours(-2) } | Stop-Process -Force -ErrorAction SilentlyContinue" 2>/dev/null

sleep 2
log "  프로세스 정리 완료"

# ── 4) 서버 재부팅 ─────────────────────────────────────
SERVER_LOG=C:/Users/STEPAI05/STEPD-repo/logs/server-$(date +%Y%m%d-%H%M%S).log
log "서버 재시작 → $SERVER_LOG"
powershell -Command "
Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'dev' `
  -WorkingDirectory 'C:\Users\STEPAI05\STEPD-repo\apps\server' `
  -RedirectStandardOutput '$SERVER_LOG' `
  -RedirectStandardError '${SERVER_LOG}.err' `
  -WindowStyle Hidden
" 2>&1 | while read line; do log "  $line"; done

# health 대기 (최대 60초)
log "서버 health 대기..."
for i in $(seq 1 30); do
  if curl -s http://localhost:4100/health 2>/dev/null | grep -q '"ok":true'; then
    log "  ✅ 서버 살아있음 ($((i*2))s)"
    break
  fi
  sleep 2
done

# ── 5) 워커 재시작 ─────────────────────────────────────
WORKER_LOG=C:/Users/STEPAI05/STEPD-repo/logs/worker-manual-$(date +%Y%m%d-%H%M%S).log
log "워커 재시작 → $WORKER_LOG"
powershell -Command "
Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'run','worker' `
  -WorkingDirectory 'C:\Users\STEPAI05\STEPD-repo\apps\server' `
  -RedirectStandardOutput '$WORKER_LOG' `
  -RedirectStandardError '${WORKER_LOG}.err' `
  -WindowStyle Hidden
" 2>&1 | while read line; do log "  $line"; done
sleep 5

# ── 6) purge → 재큐잉 ─────────────────────────────────
log "queue purge 실행..."
purge_result=$(curl -s -X POST http://localhost:4100/api/admin/queue/purge \
  -H "Content-Type: application/json" \
  -d '{"confirm":"PURGE"}' 2>&1)
log "  $purge_result"

# ── 7) 상태 확인 ──────────────────────────────────────
sleep 10
log "최종 상태:"
log "  큐: $(curl -s http://localhost:4100/api/queue/stats)"
log "✅ Round 2 배포 완료 · 8건 새 코드로 재분석 시작"
log "   스냅샷 위치: $SNAP"
