"""화면 오버레이 두 줄 프롬프트 — 2026-09-03 교체분 고정.

## 무엇을 지키나

전 프롬프트는 `title_line2` 를 **"반전·정답·핵심"** 으로 뽑으라 시켰다. 1줄이 묻고 2줄이
답해 버리니 두 줄만 읽으면 볼 이유가 사라진다 — 사용자에게 온 피드백이 정확히 그것이었다
("제목이 좀 정직하다"). 여기서 고정하는 건 그 교체가 **되돌아가지 않게** 하는 불변식들이다.

실측으로 정한 것이라 숫자·문구를 지우지 말 것:
  · 말투를 지정하면 남발한다 — "ㄷㄷ 붙여라" 로 8클립 중 7개에 붙었다
  · 정작 조회수 상위 40개 실제 제목엔 ㄷㄷ 가 **한 건도 없었다**
  · 지시문을 자막처럼 쓰면 **그대로 베낀다** — "가장 센 조각을 앞에" 가 자막으로 나왔다
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from core.recommend.recommend import _overlay_block  # noqa: E402

REFS = [
    "동료 태움질하던 간호사의 최후",
    "하하가 손절할 뻔한 양상국 미친 드립 ㅋㅋㅋㅋㅋ",
    "3글자면 충분한 부산식 맛표현 ㅋㅋㅋㅋㅋㅋ",
    "유느님한테 팩트로 맞고 있는 하하",
    "잘생겼지만 인기없는 연예인을 만난다면?",
    "전투기 조종사에서 10년차 치과의사가 된 이야기",
    "300만 유튜버들의 롤 챔피언 성대모사",
    "승강기 유지보수 영업 7년차 베테랑의 솔직 후기",
    "오랜 이상형 정용화 마이크 잡고 라이브 1열 직관",
    "부산사람처럼 메뉴 주문하는 법 ㅋㅋ",
    "하하를 이끌어준 스승",
    "인간 파파고 하드림",
    "섬세한 남자의 최후",
    "종겜 부부가 된 하하와 별 ㅋㅋㅋ",
    "홍대에서 만난 하하 나 왜 좋아해?",
    "친구들 앞에서 무용 감춘 진짜 이유",
    "10년 연기 접은 그녀 지금은",
    "동네 형처럼 굴다 정색한 순간",
]


class OverlayBlockTests(unittest.TestCase):
    def test_답을_쓰지_말라는_규칙이_살아있다(self):
        """이게 교체의 본체다 — 없어지면 '정직한 제목' 으로 되돌아간다."""
        block = _overlay_block("variety", REFS, 0)
        self.assertIn("답을 쓰지 않는다", block)
        self.assertNotIn("반전·정답·핵심", block)

    def test_뉴스는_정직형이고_유행어를_금지한다(self):
        """시사에 구어체를 주면 무게가 빠진다 — 실측 '성과급 딴 데도? / 이거 실화냐'."""
        block = _overlay_block("news", REFS, 0)
        self.assertIn("사실을 크게", block)
        self.assertIn("쓰지 마라", block)
        # 뉴스에는 말투 참조를 **아예 주지 않는다** (예능 제목이 섞이면 오염된다).
        for ref in REFS:
            self.assertNotIn(ref, block, f"뉴스 블록에 예능 참조가 샜다: {ref}")

    def test_예능은_참조를_붙인다(self):
        block = _overlay_block("variety", REFS, 0)
        self.assertTrue(any(r in block for r in REFS), "참조가 하나도 안 붙었다")

    def test_회차마다_참조_묶음이_바뀐다(self):
        """고정 목록은 버릇을 만든다 — 실측: 서로 다른 두 클립에 'N차인생' 이 똑같이 나왔다."""
        def picked(seed):
            return {ln for ln in _overlay_block("variety", REFS, seed).splitlines()
                    if ln.startswith("    · ")}

        a, b = picked(1), picked(2)
        self.assertTrue(a and b)
        self.assertNotEqual(a, b, "이웃한 회차가 완전히 같은 참조를 본다 — 회전이 안 된다")

    def test_참조가_없어도_블록이_선다(self):
        """자기 채널이 아직 없는 워크스페이스 — 참조 없이도 '정직함' 은 프롬프트가 잡는다."""
        block = _overlay_block("variety", None, 0)
        self.assertIn("답을 쓰지 않는다", block)
        self.assertNotIn("실제로 조회수가 터진", block)

    def test_해시태그는_참조에서_떼고_보여준다(self):
        block = _overlay_block("variety", ["동료 태움질하던 간호사의 최후 #닥터섬보이"], 0)
        self.assertIn("동료 태움질하던 간호사의 최후", block)
        self.assertNotIn("#닥터섬보이", block)

    def test_지시어를_출력하지_말라는_가드가_있다(self):
        """실측 2026-09-03: line1 설명문이 그대로 자막으로 나왔다("가장 센 조각을 앞에")."""
        for genre in ("variety", "drama"):
            block = _overlay_block(genre, REFS, 0)
            self.assertIn("지시어를 출력에 담지 마라", block)

    def test_초성_반응을_남발하지_말라고_한다(self):
        """말투를 지정하면 남발한다 — 상한을 명시하지 않으면 8클립 중 7개에 ㄷㄷ 가 붙었다."""
        block = _overlay_block("variety", REFS, 0)
        self.assertIn("최대 하나", block)


if __name__ == "__main__":
    unittest.main()
