"""프로그램별 운영자 커스텀 프롬프트(titlePrompt·recommendPrompt) 소비 불변식.

이 리포 최빈 실패모드는 "저장은 되는데 소비처에 미도달"이다. 서버가 program_context.json 에
실어 보낸 두 필드가 recommend 프롬프트에 실제로 얹히는지를 고정한다:
  - _operator_prompt_block 렌더 규칙 (순수 함수 — 직접 검증)
  - 주입 지점 존재 (소스 스캔 — beat-only 추천·재제목·_base_system 세 곳.
    프롬프트 문자열 자체는 LLM 몫이라 검증하지 않고, 배선 여부만 고정한다)
"""
from __future__ import annotations

import unittest
from pathlib import Path

from core.recommend.recommend import _operator_prompt_block

_RECOMMEND_SRC = (Path(__file__).resolve().parent.parent / "recommend" / "recommend.py").read_text(
    encoding="utf-8"
)


class OperatorPromptBlockTests(unittest.TestCase):
    def test_value_renders_with_header(self) -> None:
        out = _operator_prompt_block({"recommendPrompt": "요리 완성 장면을 우선"}, "recommendPrompt", "추천 구간 선택")
        self.assertIn("## 프로그램별 운영자 지시 — 추천 구간 선택", out)
        self.assertIn("요리 완성 장면을 우선", out)

    def test_missing_or_blank_is_noop(self) -> None:
        # 값이 없으면 헤더까지 통째로 생략 — 빈 지시 블록은 모델에게 소음이다.
        self.assertEqual(_operator_prompt_block(None, "titlePrompt", "제목 작성"), "")
        self.assertEqual(_operator_prompt_block({}, "titlePrompt", "제목 작성"), "")
        self.assertEqual(_operator_prompt_block({"titlePrompt": "   "}, "titlePrompt", "제목 작성"), "")
        self.assertEqual(_operator_prompt_block({"other": "x"}, "titlePrompt", "제목 작성"), "")

    def test_long_input_is_capped(self) -> None:
        # 운영자 입력은 길이 통제가 없다 — 1000자 컷이 프롬프트 낭비를 막는다.
        out = _operator_prompt_block({"titlePrompt": "가" * 5000}, "titlePrompt", "제목 작성")
        self.assertLess(len(out), 1200)


class OperatorPromptWiringTests(unittest.TestCase):
    """소스 스캔 — 주입 지점이 지워지면(리팩터링 등) 여기서 잡는다."""

    def test_beat_only_gets_both_prompts(self) -> None:
        # beat 이어붙이기(propose_shorts_beat_only)에는 recommendPrompt(구간 조합) +
        # titlePrompt(제목) 둘 다 얹는다.
        body = _RECOMMEND_SRC.split("def propose_shorts_beat_only", 1)[1].split("\ndef ", 1)[0]
        self.assertIn('_operator_prompt_block(_CURRENT_PROGRAM_CTX, "recommendPrompt"', body)
        self.assertIn('_operator_prompt_block(_CURRENT_PROGRAM_CTX, "titlePrompt"', body)

    def test_retitle_gets_title_prompt(self) -> None:
        body = _RECOMMEND_SRC.split("def _retitle_final_windows", 1)[1].split("\ndef ", 1)[0]
        self.assertIn("_operator_prompt_block(_CURRENT_PROGRAM_CTX, 'titlePrompt'", body)

    def test_base_system_gets_recommend_prompt(self) -> None:
        # 구 scene-based 후보 추출 경로(_base_system)에도 recommendPrompt 를 얹는다.
        body = _RECOMMEND_SRC.split("def _base_system", 1)[1].split("\ndef ", 1)[0]
        self.assertIn('_operator_prompt_block(_CURRENT_PROGRAM_CTX, "recommendPrompt"', body)


if __name__ == "__main__":
    unittest.main()
