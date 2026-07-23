"""
STEP D · Analysis Sync Daemon

Watches storage/analysis/*/shorts.json for changes and syncs to Postgres:
  1) content_analysis.data (프론트 useMediaAnalysisPoll이 봄)
  2) entities kind='recommendation' (전체 recs 보드가 봄 · pending만 replace)

Windows에서 워커(tsx)가 python subprocess 종료 시 native crash (0xC0000005)로 죽어
writeRecommendationsFromShorts가 실패하는 이슈 우회. 워커 crash 무관하게 이 데몬이 살아있음.

Run: python scripts/analysis-sync-daemon.py
"""
import json
import os
import sys
import time
import uuid
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import psycopg2

STORAGE_ROOT = Path(r"C:/Users/STEPAI05/STEPD-repo/apps/server/storage/analysis")
DB_URL = os.environ.get("DATABASE_URL") or "postgresql://postgres:postgres@localhost:5432/stepd"
POLL_INTERVAL_SEC = 5.0
MIN_SHORT_SEC = 3

# 파일 mtime 캐시 (변경 감지)
_mtime_cache: dict[str, float] = {}


def _log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _get_episode_id(conn, media_id: str) -> str | None:
    """media_id → episodeId (media 테이블 직접)."""
    cur = conn.cursor()
    cur.execute("SELECT episodeid FROM media WHERE id=%s", (media_id,))
    row = cur.fetchone()
    cur.close()
    return row[0] if row and row[0] else None


def _sync_content_analysis(conn, media_id: str, analysis_data: dict) -> bool:
    """content_analysis.data 를 최신 analysis.json 으로 upsert."""
    cur = conn.cursor()
    now_ms = int(time.time() * 1000)
    payload = json.dumps(analysis_data, ensure_ascii=False)
    cur.execute("""
        INSERT INTO content_analysis (mediaId, data, status, createdAt, updatedAt)
        VALUES (%s, %s::jsonb, 'done', %s, %s)
        ON CONFLICT (mediaId) DO UPDATE SET data=EXCLUDED.data, status='done', updatedAt=EXCLUDED.updatedAt
    """, (media_id, payload, now_ms, now_ms))
    updated = cur.rowcount
    conn.commit()
    cur.close()
    return updated > 0


def _sync_recommendations(conn, episode_id: str, shorts: list[dict]) -> int:
    """DELETE pending recommendations for episode, INSERT new from shorts."""
    valid = []
    for s in shorts:
        try:
            start = float(s.get("start", 0))
            end = float(s.get("end", 0))
        except (TypeError, ValueError):
            continue
        if end - start < MIN_SHORT_SEC:
            continue
        valid.append(s)
    if not valid:
        return 0

    cur = conn.cursor()
    # 기존 pending 삭제 (adopted/rejected 보존)
    cur.execute("""
        DELETE FROM entities
        WHERE kind='recommendation'
          AND data->>'episodeId'=%s
          AND COALESCE(data->>'status','pending')='pending'
    """, (episode_id,))

    # 새로 삽입 (worst rank first for prepend semantics)
    now_ms = int(time.time() * 1000)
    inserted = 0
    for s in sorted(valid, key=lambda x: -(x.get("rank") or 99)):
        rec_id = "r_" + uuid.uuid4().hex[:8]
        rank = s.get("rank", 99)
        appeal = s.get("appeal", 3)
        title = s.get("title") or "쇼츠 추천"
        rec = {
            "id": rec_id, "episodeId": episode_id, "kind": "short",
            "type": s.get("type"),
            "title": title,
            "titleCandidates": s.get("title_candidates"),
            "appeal": max(1, min(5, int(appeal))) if isinstance(appeal, (int, float)) else 3,
            "score100": s.get("score100"),
            "hookStrength": s.get("hook_strength"),
            "payoff": s.get("payoff"),
            "completeness": s.get("completeness"),
            "startTime": float(s.get("start", 0)),
            "endTime": float(s.get("end", 0)),
            "editNote": s.get("reason") or "",
            "tags": s.get("tags") or [],
            "status": "pending",
            "thumbnailCandidates": [{"id": f"{rec_id}-t1", "label": "시작", "time": float(s.get("start", 0)) + 0.5}],
            "adoptedClipId": None,
            "rank": rank,
            "createdAt": now_ms,
            # 하이라이트 전용 필드
            "segments": s.get("segments"),
            "overarchingTheme": s.get("overarching_theme"),
            "totalLengthSec": s.get("total_length_sec"),
        }
        cur.execute("SELECT COALESCE(MIN(ord), 0) - 1 FROM entities WHERE kind='recommendation'")
        ord_v = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO entities (kind, id, data, ord) VALUES ('recommendation', %s, %s::jsonb, %s)
            ON CONFLICT (kind, id) DO UPDATE SET data=EXCLUDED.data, ord=EXCLUDED.ord
        """, (rec_id, json.dumps(rec, ensure_ascii=False), ord_v))
        inserted += 1
    conn.commit()
    cur.close()
    return inserted


def _update_episode_pipeline(conn, episode_id: str, count: int) -> None:
    """episode.pipeline.stage=recommend 100% done · note로 개수 표시."""
    cur = conn.cursor()
    pipeline = {
        "stage": "recommend",
        "stageStatus": "done",
        "note": f"AI 쇼츠 추천 {count}건" if count else "분석 완료 · 추천 없음",
        "progress": 100,
    }
    cur.execute("""
        UPDATE entities
        SET data = jsonb_set(data, '{pipeline}', %s::jsonb)
        WHERE kind='episode' AND id=%s
    """, (json.dumps(pipeline), episode_id))
    conn.commit()
    cur.close()


def process_media(conn, media_dir: Path) -> None:
    media_id = media_dir.name
    shorts_file = media_dir / "shorts.json"
    analysis_file = media_dir / "analysis.json"
    if not shorts_file.exists():
        return
    try:
        mtime = shorts_file.stat().st_mtime
    except OSError:
        return
    cached = _mtime_cache.get(media_id)
    if cached is not None and cached >= mtime:
        return  # 변경 없음
    # 새 파일 or mtime 갱신됨 → sync
    try:
        with open(shorts_file, encoding="utf-8") as f:
            shorts_data = json.load(f)
    except Exception as e:
        _log(f"⚠️ {media_id} shorts.json 파싱 실패: {e}")
        _mtime_cache[media_id] = mtime  # skip until next change
        return
    shorts = shorts_data.get("shorts") or []
    _log(f"→ sync {media_id}: {len(shorts)} shorts")

    # 1) content_analysis 갱신 (analysis.json 있으면 그거 · 없으면 shorts.json)
    analysis_payload = None
    if analysis_file.exists():
        try:
            with open(analysis_file, encoding="utf-8") as f:
                analysis_payload = json.load(f)
            # shorts.json 우선 (analysis.json 이 stale일 수 있음)
            analysis_payload["shorts"] = shorts
            analysis_payload["mode"] = shorts_data.get("mode", analysis_payload.get("mode"))
        except Exception:
            analysis_payload = None
    if analysis_payload is None:
        analysis_payload = shorts_data
    try:
        _sync_content_analysis(conn, media_id, analysis_payload)
    except Exception as e:
        _log(f"⚠️ {media_id} content_analysis sync 실패: {e}")
        return

    # 2) recommendations 갱신 (episode_id 매핑 필요)
    episode_id = _get_episode_id(conn, media_id)
    if episode_id and shorts:
        try:
            wrote = _sync_recommendations(conn, episode_id, shorts)
            _update_episode_pipeline(conn, episode_id, wrote)
            _log(f"  ✓ recommendations {wrote} · episode.pipeline done")
        except Exception as e:
            _log(f"⚠️ {media_id} recommendations sync 실패: {e}")
    else:
        _log(f"  (episode 없음 or shorts 없음 · recommendations skip)")

    _mtime_cache[media_id] = mtime


def main() -> None:
    _log(f"analysis-sync-daemon 시작 · watching {STORAGE_ROOT} · poll {POLL_INTERVAL_SEC}s")
    if not STORAGE_ROOT.exists():
        _log(f"⚠️ storage root 없음: {STORAGE_ROOT}")
        sys.exit(1)

    # 시작 시 각 폴더 mtime 등록 (기존 파일은 skip, 새로 변경된 것만 처리)
    for media_dir in STORAGE_ROOT.iterdir():
        if not media_dir.is_dir():
            continue
        shorts_file = media_dir / "shorts.json"
        if shorts_file.exists():
            try:
                _mtime_cache[media_dir.name] = shorts_file.stat().st_mtime
            except OSError:
                pass

    _log(f"초기 스캔: {len(_mtime_cache)} media 등록 (mtime 초기화)")

    # 폴링 루프
    while True:
        try:
            conn = psycopg2.connect(DB_URL)
        except Exception as e:
            _log(f"⚠️ DB 연결 실패: {e} · 30s 후 재시도")
            time.sleep(30)
            continue
        try:
            for media_dir in STORAGE_ROOT.iterdir():
                if not media_dir.is_dir():
                    continue
                try:
                    process_media(conn, media_dir)
                except Exception as e:
                    _log(f"⚠️ {media_dir.name} 처리 실패: {e}")
        finally:
            try:
                conn.close()
            except Exception:
                pass
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _log("daemon 종료")
        sys.exit(0)
