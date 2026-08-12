"""Bulk 준비 · GCS templates/thumbnail/manifest.json 기준으로 미처리 항목 batch 처리.

사용자 흐름 (2026-07-28):
1. Web UI 에서 "YouTube 자동 수집" 클릭 → 서버가 raw 썸네일을 GCS 에 업로드 + manifest 추가
2. 이 스크립트 실행 → 로컬(GCS ADC 있음) 에서:
   - 미분석 (_analyzed=false) 항목: 이미지 다운 → Vision 분석 → manifest 갱신
   - 미가공 (cleaned_path 없음) 항목: 이미지 다운 → preprocess → cleaned 업로드 → manifest 갱신
3. 완료 후 GCS manifest 갱신 · 파이프라인이 바로 사용

사용:
  python scripts/thumbnail_bulk_prepare.py                # 분석 + 가공 모두
  python scripts/thumbnail_bulk_prepare.py --only-analyze
  python scripts/thumbnail_bulk_prepare.py --only-preprocess
  python scripts/thumbnail_bulk_prepare.py --limit 10     # 처음 N개만
"""
from __future__ import annotations

import argparse
import io
import json
import os
import pathlib
import sys
import tempfile

from google.cloud import storage

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

BUCKET = os.environ.get("GCS_BUCKET", "stepd-media")
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "step-d")
GCS_PREFIX = "templates/thumbnail"
GCS_MANIFEST = f"{GCS_PREFIX}/manifest.json"
GCS_CLEANED = f"{GCS_PREFIX}/cleaned"


def _bucket():
    client = storage.Client(project=PROJECT)
    return client.bucket(BUCKET)


def load_manifest() -> list[dict]:
    b = _bucket()
    blob = b.blob(GCS_MANIFEST)
    if not blob.exists():
        print(f"[FAIL] {GCS_MANIFEST} 없음", file=sys.stderr); return []
    return json.loads(blob.download_as_text(encoding="utf-8"))


def save_manifest(entries: list[dict]) -> None:
    b = _bucket()
    blob = b.blob(GCS_MANIFEST)
    blob.upload_from_string(json.dumps(entries, ensure_ascii=False, indent=2),
                             content_type="application/json")
    print(f"[ok] manifest → gs://{BUCKET}/{GCS_MANIFEST}")


def download_to_temp(gcs_path: str, tmp_dir: pathlib.Path) -> pathlib.Path | None:
    b = _bucket()
    blob = b.blob(gcs_path)
    if not blob.exists():
        return None
    local = tmp_dir / pathlib.Path(gcs_path).name
    blob.download_to_filename(str(local))
    return local


def upload_from_local(gcs_path: str, local: pathlib.Path, content_type: str = "image/png") -> None:
    b = _bucket()
    blob = b.blob(gcs_path)
    blob.upload_from_filename(str(local), content_type=content_type)


def run_analyze(entries: list[dict], tmp_dir: pathlib.Path, limit: int | None) -> tuple[int, int]:
    """미분석 항목 · Vision 분석."""
    from thumbnail_reference_manifest import analyze_one  # 재사용
    todo = [e for e in entries if not e.get("_analyzed")]
    if limit:
        todo = todo[:limit]
    ok = 0; fail = 0
    for e in todo:
        gcs = e.get("path", "")
        if not gcs.startswith(GCS_PREFIX):
            gcs = f"{GCS_PREFIX}/{pathlib.Path(gcs).name}"
        print(f"[analyze] {e['id']} ← gs://{BUCKET}/{gcs}", end=" ", flush=True)
        local = download_to_temp(gcs, tmp_dir)
        if not local:
            print("FAIL · GCS 없음"); fail += 1; continue
        try:
            meta = analyze_one(local)
        except Exception as ex:
            print(f"FAIL · {str(ex)[:80]}"); fail += 1; continue
        if not meta:
            print("FAIL · empty"); fail += 1; continue
        # entry 갱신 (기존 사용자 태그 유지)
        preserved = {k: e.get(k) for k in ("program", "custom_tags", "user_note", "cleaned_path", "source")
                     if e.get(k) is not None}
        e.update({"_analyzed": True, **meta, **preserved})
        print(f"OK · {meta.get('composition')} · {meta.get('person_count')}인 · {meta.get('mood')}")
        ok += 1
    return ok, fail


def run_preprocess(entries: list[dict], tmp_dir: pathlib.Path, limit: int | None) -> tuple[int, int]:
    """미가공 항목 · 슬롯 라벨 + 중립 배경."""
    from thumbnail_preprocess_template import preprocess_one
    todo = [e for e in entries if not e.get("cleaned_path")]
    if limit:
        todo = todo[:limit]
    ok = 0; fail = 0
    for e in todo:
        gcs = e.get("path", "")
        if not gcs.startswith(GCS_PREFIX):
            gcs = f"{GCS_PREFIX}/{pathlib.Path(gcs).name}"
        print(f"[preprocess] {e['id']} ← gs://{BUCKET}/{gcs}", end=" ", flush=True)
        local = download_to_temp(gcs, tmp_dir)
        if not local:
            print("FAIL · GCS 없음"); fail += 1; continue
        out_local = tmp_dir / f"{e['id']}_clean.png"
        try:
            got = preprocess_one(local, out_local)
        except Exception as ex:
            print(f"FAIL · {str(ex)[:80]}"); fail += 1; continue
        if not got:
            print("FAIL · empty"); fail += 1; continue
        # GCS 업로드
        cleaned_gcs = f"{GCS_CLEANED}/{e['id']}_clean.png"
        upload_from_local(cleaned_gcs, out_local, "image/png")
        e["cleaned_path"] = cleaned_gcs
        print(f"OK → gs://{BUCKET}/{cleaned_gcs}")
        ok += 1
    return ok, fail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only-analyze", action="store_true")
    ap.add_argument("--only-preprocess", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    entries = load_manifest()
    if not entries:
        return 1
    print(f"[bulk] manifest {len(entries)} entries · GCS_BUCKET={BUCKET}\n")

    tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="thumb_bulk_"))
    print(f"[bulk] tmp dir: {tmp_dir}\n")

    do_analyze = not args.only_preprocess
    do_preprocess = not args.only_analyze

    ok_a = fail_a = 0
    ok_p = fail_p = 0

    if do_analyze:
        print("── 1) Vision 분석 ──────────────────")
        ok_a, fail_a = run_analyze(entries, tmp_dir, args.limit)
        save_manifest(entries)  # 각 단계 후 저장 (재개 안전)
        print(f"[analyze 완료] ok={ok_a} fail={fail_a}\n")

    if do_preprocess:
        print("── 2) 사전 가공 (슬롯 라벨 + 중립 배경) ──────────────────")
        ok_p, fail_p = run_preprocess(entries, tmp_dir, args.limit)
        save_manifest(entries)
        print(f"[preprocess 완료] ok={ok_p} fail={fail_p}\n")

    print(f"\n=== 총 결과 ===")
    print(f"  analyze: ok={ok_a} fail={fail_a}")
    print(f"  preprocess: ok={ok_p} fail={fail_p}")
    print(f"  manifest → gs://{BUCKET}/{GCS_MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
