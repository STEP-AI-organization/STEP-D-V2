"""Gemini 배치 모드 불변식 — 돈과 정확성이 둘 다 걸려 있다.

여기서 고정하는 것 세 가지:
 1. **켜짐 판정의 실패 방향** — 오타·빈값·버킷없음은 전부 "꺼짐"(=동기로 비싸게 돌지만 돈다).
 2. **응답 짝짓기** — 출력 JSONL 줄 순서를 믿지 않는다. 순서로 zip 하면 엉뚱한 세그먼트에
    엉뚱한 이름이 붙는데, 이건 조용히 틀리는 종류다.
 3. **원가 50%** — 배치 토큰이 동기와 같은 값으로 계산되면 마진 판단이 통째로 틀어진다.
"""
from __future__ import annotations

import json
import os
import unittest

from core.common import batch as B


class 켜짐판정(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in
                       ("GEMINI_BATCH", "GEMINI_BATCH_BUCKET", "GCS_BUCKET")}

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _set(self, **kw):
        for k in ("GEMINI_BATCH", "GEMINI_BATCH_BUCKET", "GCS_BUCKET"):
            os.environ.pop(k, None)
        for k, v in kw.items():
            os.environ[k] = v

    def test_스위치와_버킷이_다_있어야_켜진다(self):
        self._set(GEMINI_BATCH="1", GEMINI_BATCH_BUCKET="stepd-media")
        self.assertTrue(B.batch_enabled())

    def test_버킷이_없으면_꺼진_것으로_본다(self):
        # 켜 놓고 버킷을 안 준 상태에서 "배치인 줄 알고" 진행하면 회차가 안 돈다.
        self._set(GEMINI_BATCH="1")
        self.assertFalse(B.batch_enabled())

    def test_오타는_꺼짐이다(self):
        for v in ("ture", "", "0", "off", "no"):
            self._set(GEMINI_BATCH=v, GEMINI_BATCH_BUCKET="b")
            self.assertFalse(B.batch_enabled(), v)

    def test_미디어_버킷을_폴백으로_쓴다(self):
        self._set(GEMINI_BATCH="on", GCS_BUCKET="gs://stepd-media/")
        self.assertEqual(B.batch_bucket(), "stepd-media")


class 응답짝짓기(unittest.TestCase):
    def test_표식으로_되짚는다(self):
        req = {"contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": "image/jpeg", "data": "x"}},
            {"text": "프롬프트\n#REQ:41"}]}]}
        self.assertEqual(B._marker_index(req), 41)

    def test_표식이_없으면_버린다(self):
        # 짝을 모르면 **버리는 게 맞다** — 순서로 추측하면 남의 이름이 붙는다.
        req = {"contents": [{"role": "user", "parts": [{"text": "표식 없음"}]}]}
        self.assertIsNone(B._marker_index(req))

    def test_응답에서_첫_텍스트를_꺼낸다(self):
        resp = {"candidates": [{"content": {"parts": [{"text": '{"name":"영철"}'}]}}]}
        self.assertEqual(json.loads(B._first_text(resp))["name"], "영철")

    def test_차단_응답은_None(self):
        self.assertIsNone(B._first_text({"candidates": [{"finishReason": "SAFETY"}]}))


class 원가계산(unittest.TestCase):
    def test_배치_토큰은_반값으로_센다(self):
        from core.common.retry import USAGE, record_batch_usage, usage_summary
        before = usage_summary()["est_krw"]
        snapshot = {k: dict(v) for k, v in USAGE["by_model"].items()}
        try:
            record_batch_usage("gemini-2.5-flash", 1_000_000, 0, 1)
            after = usage_summary()["est_krw"]
            # 동기 단가는 in ₩425/1M — 배치면 그 절반이어야 한다
            self.assertAlmostEqual(after - before, 425 * 0.5, delta=0.5)
        finally:
            USAGE["by_model"] = snapshot

    def test_배치와_동기가_같은_키에_섞이지_않는다(self):
        from core.common.retry import USAGE, record_batch_usage, usage_summary
        snapshot = {k: dict(v) for k, v in USAGE["by_model"].items()}
        try:
            record_batch_usage("gemini-2.5-flash", 100, 10, 1)
            keys = usage_summary()["by_model"].keys()
            self.assertIn("gemini-2.5-flash:batch", keys,
                          "배치가 별도 키로 안 남으면 usage.json 만 보고 배치 여부를 알 수 없다")
        finally:
            USAGE["by_model"] = snapshot


class 폴백방향(unittest.TestCase):
    def test_버킷이_없으면_None_을_돌려_동기로_보낸다(self):
        saved = {k: os.environ.get(k) for k in ("GEMINI_BATCH_BUCKET", "GCS_BUCKET")}
        for k in saved:
            os.environ.pop(k, None)
        try:
            r = B.batch_generate(model="gemini-2.5-flash",
                                 requests=[[B.text_part("x")]], gen_config={}, label="t",
                                 log=lambda _m: None)
            self.assertIsNone(r, "None 이 아니면 caller 가 동기 폴백을 못 한다")
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_빈_요청은_빈_결과다(self):
        # 폴백(None)과 "할 일이 없다"([]) 를 구분해야 한다.
        self.assertEqual(B.batch_generate(model="m", requests=[], gen_config={}, label="t"), [])

    def test_폴백하면_잡을_취소한다(self):
        # 취소를 빼면 우리가 안 읽을 결과를 서버가 끝까지 만들고 **요금은 그대로 나간다**
        # (동기 재실행분과 합쳐 이중 지불). 소스에 취소 호출이 있는지 고정한다.
        import inspect
        src = inspect.getsource(B)
        self.assertIn("batches.cancel", src, "폴백 경로에 잡 취소가 없다 — 이중 지불된다")
        for guard in ("TIMEOUT_SEC", "START_TIMEOUT_SEC"):
            self.assertIn(f"_cancel(client, name, log)", src)
            self.assertIn(guard, src)

    def test_취소_실패는_회차를_멈추지_않는다(self):
        calls = []

        class _Boom:
            class batches:
                @staticmethod
                def cancel(name):
                    raise RuntimeError("권한 없음")

        B._cancel(_Boom(), "projects/x/jobs/1", lambda m: calls.append(m))
        self.assertTrue(any("취소 실패" in m for m in calls))


if __name__ == "__main__":
    unittest.main()
