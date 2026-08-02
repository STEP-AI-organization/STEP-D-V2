"""
STEP D Core — 검색엔진 셀프테스트 (인덱서→검색→로그 end-to-end)

GCP 없이 배관을 검증한다 (EMBED_BACKEND=local 강제 — 의미 품질이 아니라 필터·하이브리드
융합·권리 주석·로그 왕복의 정합성을 본다). 프로덕션은 Vertex 임베딩으로 그대로 스왑.

Run:
    python -m core.search_selftest        # 통과 시 exit 0
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("EMBED_BACKEND", "local")


def _fixture(wd: Path) -> None:
    data = {
        "beats": {"beats": [
            {"id": 0, "start": 10.0, "end": 32.0, "title": "영철 자기소개", "summary": "영철이 자기소개하며 분위기를 띄운다", "characters": ["영철"], "hook": "웃음", "is_complete": True},
            {"id": 1, "start": 32.0, "end": 58.0, "title": "", "summary": "", "characters": [], "hook": "감정고조", "is_complete": True},
            {"id": 2, "start": 58.0, "end": 80.0, "title": "게임 라운드1", "summary": "팀을 나눠 게임을 시작한다", "characters": ["영철", "공주"], "hook": "정보성", "is_complete": True},
            {"id": 3, "start": 80.0, "end": 104.0, "title": "영철 인터뷰", "summary": "영철이 인터뷰룸에서 오늘 감정을 털어놓는다", "characters": ["영철"], "hook": "공감", "is_complete": True},
            {"id": 4, "start": 104.0, "end": 132.0, "title": "결과 발표", "summary": "최종 선택 결과가 공개되고 반전이 일어난다", "characters": ["민경", "공주"], "hook": "반전", "is_complete": True},
            {"id": 5, "start": 132.0, "end": 150.0, "title": "엔딩", "summary": "다음 회차 예고", "characters": [], "hook": "기타", "is_complete": True},
        ]},
        "refined": [
            {"start": 10.5, "end": 15.0, "text": "안녕하세요 영철입니다 잘 부탁드려요", "speaker": "영철"},
            {"start": 33.0, "end": 40.0, "text": "사실 저 처음부터 좋아했어요", "speaker": "민경"},
            {"start": 60.0, "end": 66.0, "text": "자 이제 게임 시작합니다", "speaker": "영철"},
            {"start": 82.0, "end": 95.0, "text": "오늘 솔직히 좀 서운했어요 그래도 괜찮아요", "speaker": "영철"},
            {"start": 106.0, "end": 112.0, "text": "최종 선택은 공주님입니다", "speaker": "공주"},
        ],
        "scene_type": [
            {"shot_id": 0, "start": 9.0, "end": 57.0, "type": "on_scene", "confidence": 0.9},
            {"shot_id": 1, "start": 57.0, "end": 80.0, "type": "on_scene", "confidence": 0.85},
            {"shot_id": 2, "start": 80.0, "end": 104.0, "type": "interview", "confidence": 0.92},
            {"shot_id": 3, "start": 104.0, "end": 150.0, "type": "on_scene", "confidence": 0.8},
        ],
        "cast": {"people": [
            {"name": "영철", "appearances": [{"start": 8.0, "end": 104.0}]},
            {"name": "민경", "appearances": [{"start": 31.0, "end": 58.0}, {"start": 104.0, "end": 132.0}]},
            {"name": "공주", "appearances": [{"start": 58.0, "end": 132.0}]},
        ]},
        "chyron": [{"time": 12.0, "names": ["영철"]}, {"time": 35.0, "names": ["민경"]}, {"time": 108.0, "names": ["공주"]}],
        "narrative": {"segments": [{"start": 32.0, "end": 58.0, "summary": "민경이 영철에게 마음을 고백하는 긴장된 순간"}]},
        "shorts": {"genre": "variety", "shorts": [
            {"start": 33.0, "end": 56.0, "title": "민경의 고백", "appeal": 5},
            {"start": 104.0, "end": 130.0, "title": "반전 결과", "appeal": 4},
        ]},
    }
    for name, obj in data.items():
        (wd / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def _beats(res, k=10):
    return [int(r["segment_id"].split("#b")[-1]) for r in res["results"][:k]]


def run() -> None:
    from core.index_segments import build_segments
    from core import search
    from core.search_log import SearchLogger, read_events

    with tempfile.TemporaryDirectory() as tmp:
        wd = Path(tmp)
        _fixture(wd)
        result = build_segments(wd, media_id="m1", genre="variety", embed=True)
        segs = result["segments"]
        assert result["count"] == 6, result["count"]

        # 스코프·권리는 파이프라인 신호 전이라 placeholder → 테스트용 주입
        for s in segs:
            s["scope"] = {"scope_type": "cohort", "scope_id": "23기", "episode": "5", "aired_at": "2026-07-20"}
        by_beat = {s["source_beat"]: s for s in segs}
        by_beat[4]["rights"]["spoiler"] = True
        by_beat[2]["rights"]["ppl"] = True
        by_beat[5]["rights"]["cast_ok"] = False

        # 1) 인물 union: beat1은 characters 비었지만 cast/chyron으로 민경·영철 채워짐
        assert set(by_beat[1]["characters"]) >= {"영철", "민경"}, by_beat[1]["characters"]
        # 2) 빈 summary가 narrative에서 보충됨
        assert "고백" in by_beat[1]["summary"], by_beat[1]["summary"]
        # 3) 쇼츠 겹침 플래그
        assert by_beat[1]["is_short"] is True and by_beat[0]["is_short"] is False

        # 4) 하이브리드: BM25 승자(고백 beat1)가 1위 — 무매칭 모달리티 노이즈 상쇄 안 됨
        r = search.search(segs, "민경 고백 장면")
        assert _beats(r)[0] == 1, _beats(r)

        # 5) 인물 AND 장면유형 필터
        r = search.search(segs, "영철 인터뷰")
        assert r["results"] and all("영철" in x["characters"] and x["scene_type"] == "interview" for x in r["results"])
        assert _beats(r)[0] == 3, _beats(r)

        # 6) 스포일러 필터 — 기본 제외, allow_spoiler에서만 노출
        assert 4 not in _beats(search.search(segs, "반전 결과 발표"))
        assert 4 in _beats(search.search(segs, "반전 결과 발표", allow_spoiler=True))

        # 7) 쇼츠 여부 필터
        r = search.search(segs, "터진 하이라이트")
        assert r["results"] and all(x["is_short"] for x in r["results"])

        # 8) 로그 4종 왕복 + 경계조정 delta
        log = SearchLogger(wd / "search_log.jsonl")
        r = search.search(segs, "민경 고백 장면")
        qid = log.log_search("민경 고백 장면", r["parsed"], r["results"], user="pd01", role="editor")
        top = r["results"][0]
        log.log_click(qid, top["segment_id"], rank=1)
        log.log_boundary_adjust(qid, top["segment_id"],
                                before={"start": top["start"], "end": top["end"]},
                                after={"start": top["start"] - 3.0, "end": top["end"]})
        log.log_export(qid, top["segment_id"], start=top["start"] - 3.0, end=top["end"])
        ev = read_events(wd / "search_log.jsonl")
        assert [e["event"] for e in ev] == ["search", "click", "boundary_adjust", "export"]
        assert next(e for e in ev if e["event"] == "boundary_adjust")["delta_start"] == -3.0

    print("✅ search_selftest 통과 (backend=%s)" % os.environ["EMBED_BACKEND"])


if __name__ == "__main__":
    try:
        run()
    except AssertionError as e:
        print(f"❌ 실패: {e}", file=sys.stderr)
        raise SystemExit(1)
