"""
원가 원장(usage.json) 불변식 — **돈이 걸린 계측**이라 실패 방향이 중요하다.

이 리포는 원가를 네 번 틀렸고 뿌리가 매번 같았다: **안 돈 스테이지를 0 으로 셌다**
(CLAUDE.md 상단 경고). 체크포인트 재개가 그 함정의 제조기다 — 재개 회차의 프로세스 누적은
"이번에 실제로 돈 스테이지" 만 담으므로, 그걸 그대로 저장하면 한 편의 원가가 ₩30 이 된다.

그래서 여기서 고정하는 건 둘이다:
  1. 회차 누적은 **더해진다** (덮어쓰지 않는다) — 버린 재시도도 실제로 나간 돈이다
  2. 단가를 모르는 벤더는 **원가 0 · 물량은 기록** — 지어낸 숫자가 원장에 들어가면 안 된다
"""
import importlib

import pytest


@pytest.fixture(autouse=True)
def _reset_usage():
    """모듈 전역 누적기라 테스트마다 초기화한다 (안 하면 서로 오염된다)."""
    from core.common import retry
    retry.USAGE.clear()
    retry.USAGE.update({"calls": 0, "in_tokens": 0, "out_tokens": 0, "by_model": {}})
    retry.EXTERNAL.clear()
    yield


def test_soniox_단가가_정본과_같다():
    """60분 = ₩141 (docs/ops/how-it-works.md §4 "받아쓰기 ₩141").

    이 값이 틀리면 60분 원가 ₩800 중 18%가 틀어진다.
    """
    from core.common.retry import record_external, usage_summary
    record_external("soniox", qty=60.0)
    u = usage_summary()
    assert 140 <= u["external_krw"] <= 142, u["external_krw"]
    assert u["external"]["soniox"]["qty"] == 60.0


def test_단가를_모르는_벤더는_원가0_물량만():
    """지어낸 단가가 원장에 들어가느니 0 이 낫다 — 0 은 '모른다'가 눈에 보인다."""
    from core.common.retry import record_external, usage_summary
    record_external("vertex-embed", qty=204, unit="text")
    u = usage_summary()
    assert u["external"]["vertex-embed"]["qty"] == 204
    assert u["external"]["vertex-embed"]["krw"] == 0.0
    assert u["external_krw"] == 0.0


def test_est_krw_는_gemini와_외부를_모두_담는다():
    """받아쓰기가 빠지면 원장이 그만큼 과소계상되고 마진이 실제보다 좋아 보인다."""
    from core.common import retry
    retry.record_external("soniox", qty=60.0)
    # flash-lite 입력 100만 토큰 = ₩142 (단가표 기준). 배치 키를 쓰면 절반이 되므로
    # 여기서는 동기 경로를 흉내내 by_model 에 직접 넣는다.
    retry.USAGE["by_model"]["gemini-2.5-flash-lite"] = {"calls": 1, "in": 1_000_000, "out": 0, "cached": 0}
    u = retry.usage_summary()
    assert u["gemini_krw"] == pytest.approx(142.0, abs=0.5)
    assert u["external_krw"] == pytest.approx(141.6, abs=0.1)
    assert u["est_krw"] == pytest.approx(u["gemini_krw"] + u["external_krw"], abs=0.01)


def test_음수나_0_은_기록하지_않는다():
    from core.common.retry import record_external, usage_summary
    record_external("soniox", qty=0)
    record_external("soniox", qty=-5)
    assert usage_summary()["external"] == {}


class Test재시도_누적:
    """`_merge_usage` — 재개 회차가 이전 시도분을 **더한다**."""

    def _merge(self, prev, cur):
        m = importlib.import_module("core.analyze_stages")
        return m._merge_usage(prev, cur)

    def test_원가는_더해진다_덮어쓰지_않는다(self):
        # 1차 시도: STT 까지 돌고 죽었다(₩141). 2차: 체크포인트 재개라 STT 는 안 돌고
        # Gemini 만 ₩510. 한 편의 진짜 원가는 ₩651 이지 ₩510 이 아니다.
        prev = {"calls": 2, "in_tokens": 10, "out_tokens": 5, "gemini_krw": 0.0,
                "external_krw": 141.6, "est_krw": 141.6,
                "external": {"soniox": {"unit": "min", "qty": 60.0, "krw": 141.6, "calls": 1}},
                "by_model": {}, "runs": 1}
        cur = {"calls": 200, "in_tokens": 900, "out_tokens": 300, "gemini_krw": 510.0,
               "external_krw": 0.0, "est_krw": 510.0, "external": {}, "by_model": {}}
        out = self._merge(prev, cur)
        assert out["est_krw"] == pytest.approx(651.6, abs=0.01)
        assert out["external_krw"] == pytest.approx(141.6, abs=0.01)
        assert out["gemini_krw"] == 510.0
        assert out["calls"] == 202
        assert out["runs"] == 2, "몇 번 시도했는지 알아야 '왜 비쌌나'를 답할 수 있다"

    def test_모델별_내역도_합쳐진다(self):
        prev = {"est_krw": 10, "by_model": {"gemini-2.5-flash-lite": {"calls": 5, "in": 100, "out": 20, "cached": 0}}}
        cur = {"est_krw": 20, "by_model": {"gemini-2.5-flash-lite": {"calls": 3, "in": 50, "out": 10, "cached": 0},
                                           "gemini-2.5-flash": {"calls": 1, "in": 9, "out": 2, "cached": 0}}}
        out = self._merge(prev, cur)
        lite = out["by_model"]["gemini-2.5-flash-lite"]
        assert (lite["calls"], lite["in"], lite["out"]) == (8, 150, 30)
        assert out["by_model"]["gemini-2.5-flash"]["calls"] == 1

    def test_외부벤더_물량도_합쳐진다(self):
        prev = {"est_krw": 1, "external": {"soniox": {"unit": "min", "qty": 30.0, "krw": 70.8, "calls": 1}}}
        cur = {"est_krw": 1, "external": {"soniox": {"unit": "min", "qty": 60.0, "krw": 141.6, "calls": 1}}}
        out = self._merge(prev, cur)
        assert out["external"]["soniox"]["qty"] == 90.0
        assert out["external"]["soniox"]["krw"] == pytest.approx(212.4, abs=0.01)
