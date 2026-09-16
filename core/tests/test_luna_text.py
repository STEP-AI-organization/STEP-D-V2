"""GPT-5.6 Luna 번역 실험 (2026-09-16) — OpenAI 응답 어댑터가 usage 원장에 잡히는지.

이 리포 최빈 실패모드는 "기능은 있는데 출력이 소비처에 미도달"이다. 여기서 소비처는
`retry._record_usage`(usage.json 원장)다 — 어댑터의 필드명이 genai 모양과 어긋나면
Luna 비용이 원장에서 통째로 빠지고, 원가 보고가 조용히 과소계상된다.
"""
import unittest
from types import SimpleNamespace

from core.common import retry

try:
    from core.common import openai_client
    _IMPORT_ERR = None
except Exception as e:  # openai 는 기본 요건이지만, 웹·서버만 하는 로컬을 막지 않는다
    openai_client = None
    _IMPORT_ERR = e


def _fake_openai_resp(model="gpt-5.6-luna-2026-07-09", content="번역 결과",
                      p=100, c=10, cached=5):
    """openai SDK chat.completions 응답의 최소 모양."""
    return SimpleNamespace(
        model=model,
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))],
        usage=SimpleNamespace(
            prompt_tokens=p, completion_tokens=c,
            prompt_tokens_details=SimpleNamespace(cached_tokens=cached),
        ),
    )


@unittest.skipIf(openai_client is None, f"openai 미설치: {_IMPORT_ERR}")
class TestWrapChatResponse(unittest.TestCase):
    def test_genai_필드명으로_매핑된다(self):
        r = openai_client.wrap_chat_response(_fake_openai_resp(), "gpt-5.6-luna")
        self.assertEqual(r.text, "번역 결과")
        self.assertEqual(r.usage_metadata.prompt_token_count, 100)
        self.assertEqual(r.usage_metadata.candidates_token_count, 10)
        self.assertEqual(r.usage_metadata.cached_content_token_count, 5)
        # 원장 키 — OpenAI 는 model 에 날짜 붙은 정식명을 돌려준다. 단가 매칭은 startswith 라
        # "gpt-5.6-luna" 접두가 살아 있어야 한다.
        self.assertTrue(r.model_version.startswith("gpt-5.6-luna"))

    def test_record_usage_가_실제로_집계한다(self):
        """어댑터 → _record_usage 통합 — 필드명이 하나라도 어긋나면 여기서 잡힌다."""
        saved = {k: (dict(v) if isinstance(v, dict) else v) for k, v in retry.USAGE.items()}
        saved["by_model"] = {k: dict(v) for k, v in retry.USAGE["by_model"].items()}
        try:
            r = openai_client.wrap_chat_response(_fake_openai_resp(), "gpt-5.6-luna")
            retry._record_usage(r)
            m = retry.USAGE["by_model"].get("gpt-5.6-luna-2026-07-09")
            self.assertIsNotNone(m, "Luna 호출이 by_model 에 안 잡혔다")
            self.assertEqual(m["in"], 100)
            self.assertEqual(m["out"], 10)
            self.assertEqual(m["cached"], 5)
        finally:
            retry.USAGE.clear()
            retry.USAGE.update(saved)


class TestLunaPricing(unittest.TestCase):
    def test_단가표에_루나가_있다(self):
        # $0.20/$1.20 · ₩1,416/USD (표의 다른 항목과 같은 환율 기준).
        self.assertEqual(retry._PRICE_KRW_PER_1M.get("gpt-5.6-luna"), {"in": 283, "out": 1699})

    def test_usage_summary_가_루나_비용을_계산한다(self):
        """모델명에 날짜 suffix 가 붙어도(startswith 매칭) 원가가 잡혀야 한다."""
        saved = {k: (dict(v) if isinstance(v, dict) else v) for k, v in retry.USAGE.items()}
        saved["by_model"] = {k: dict(v) for k, v in retry.USAGE["by_model"].items()}
        try:
            retry.USAGE["by_model"].clear()
            retry.USAGE["by_model"]["gpt-5.6-luna-2026-07-09"] = {
                "calls": 1, "in": 1_000_000, "out": 0, "cached": 0,
            }
            s = retry.usage_summary()
            self.assertAlmostEqual(s["gemini_krw"], 283.0, places=1)
        finally:
            retry.USAGE.clear()
            retry.USAGE.update(saved)


if __name__ == "__main__":
    unittest.main()
