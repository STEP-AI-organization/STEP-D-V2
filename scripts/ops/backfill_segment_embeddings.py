"""search_segments 의 빈 임베딩 백필.

인덱싱 시점에 Vertex 임베딩이 실패하면 core/embed.py 는 **local 폴백을 하지 않고**
None 을 남긴다 (다른 공간의 벡터를 섞으면 코사인이 깨지므로 옳은 설계다).
그 결과 emb_dialogue/emb_summary 가 NULL 인 행은 벡터 유사도가 항상 0이 되어
의미 검색이 사실상 죽는다 — 키워드(pg_trgm) 축만 남는다.

이 스크립트는 NULL 인 행만 골라 다시 임베딩해 채운다.

사용:
  python scripts/backfill_segment_embeddings.py                 # 전체
  python scripts/backfill_segment_embeddings.py m_981d7c08      # 특정 미디어
  python scripts/backfill_segment_embeddings.py --dry           # 대상 수만 확인
"""
from __future__ import annotations

import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

BATCH = 64


def load_env(path: pathlib.Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))


def to_vector(vec) -> str | None:
    return None if vec is None else "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


def main() -> int:
    args = [a for a in sys.argv[1:]]
    dry = "--dry" in args
    media = next((a for a in args if not a.startswith("--")), None)

    load_env(ROOT / "apps" / "server" / ".env")
    import psycopg2
    from core.search.embed import embed_texts

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()

    where = "(emb_dialogue IS NULL OR emb_summary IS NULL)"
    params: list[object] = []
    if media:
        where += " AND media_id = %s"
        params.append(media)

    cur.execute(f"SELECT count(*) FROM search_segments WHERE {where}", params)
    total = cur.fetchone()[0]
    print(f"백필 대상: {total} 세그먼트" + (f" (media={media})" if media else ""))
    if dry or total == 0:
        return 0

    cur.execute(
        f"SELECT segment_id, coalesce(dialogue,''), coalesce(summary,'') "
        f"FROM search_segments WHERE {where} ORDER BY segment_id", params)
    rows = cur.fetchall()

    done = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        dia = embed_texts([r[1] for r in chunk])
        summ = embed_texts([r[2] for r in chunk])
        for (seg_id, _, _), d, m in zip(chunk, dia, summ):
            if d is None and m is None:
                continue   # 임베딩 실패 — NULL 로 남긴다 (local 폴백 금지)
            cur.execute(
                "UPDATE search_segments SET emb_dialogue = %s::vector, emb_summary = %s::vector "
                "WHERE segment_id = %s",
                (to_vector(d), to_vector(m), seg_id))
            done += 1
        conn.commit()
        print(f"  {min(i + BATCH, len(rows))}/{len(rows)} · 채움 {done}")

    cur.execute(
        "SELECT count(*), count(emb_dialogue), count(emb_summary) FROM search_segments"
        + (" WHERE media_id = %s" if media else ""),
        [media] if media else [])
    print("결과 (전체/대사벡터/요약벡터):", cur.fetchone())
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
