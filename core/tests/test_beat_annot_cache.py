"""beat_annot 프롬프트 캐시 접두 불변식.

이 파일이 지키는 것은 **결과가 아니라 순서**다. 파트 순서가 어긋나도 산출물은 멀쩡해서
아무도 눈치채지 못하는데, 비용만 조용히 오른다 — 그래서 테스트로 고정한다.

배경(2026-09-14 실측): 프로덕션 18회차에서 캐시 적중이 콜의 14.9% 뿐이었고 9회차는
정확히 0% 였다. 원인이 **둘** 이었다.

  1. `prior_ctx`(CTX_RECENT 블록 경계에서 바뀜)가 head 텍스트 안에 있어서, 그 뒤에 오던
     **1,806토큰짜리 명찰판 이미지가 공통 접두 밖으로** 밀려났다.
  2. `[요청]` 고정 지시문 전부가 **변동부(시각·발화) 뒤**에 있었다.

둘이 겹쳐 실제 공통 접두가 Vertex count_tokens 기준 **197토큰**(명찰판 있어도 368)에
불과했다 — Gemini 암묵 캐시 최소치 ~1,024 에 한참 못 미친다. 고친 뒤:

    상황              옛 접두 → 새 접두
    명찰판 없음          197 →  1,017   (경계 · 시놉시스 길이에 좌우됨)
    명찰판 있음          368 →  2,994   (여유 있게 통과)

⚠️ 한국어는 **1.78자/토큰**이다(실측). 자 수로 어림하면 60% 틀린다 — 임계치 근처를
논할 땐 반드시 `count_tokens` 로 잴 것.
"""
import pytest

pytest.importorskip("google.genai", reason="google-genai 없으면 파트 조립을 검사할 수 없다")

from core.beats.beat_annot import (  # noqa: E402
    build_parts, build_prompt_head, build_prompt_tail,
)

BOARD = b"\xff\xd8board"
FRAME_A = b"\xff\xd8frameA"
FRAME_B = b"\xff\xd8frameB"


def _kinds(parts):
    """파트를 ('text', 내용) / ('image', 바이트) 로 납작하게."""
    out = []
    for p in parts:
        if getattr(p, "text", None):
            out.append(("text", p.text))
        else:
            blob = getattr(p, "inline_data", None)
            out.append(("image", getattr(blob, "data", None)))
    return out


def _common_prefix(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return a[:n]


def test_명찰판_이미지는_prior_ctx_앞에_온다():
    """이미지가 prior_ctx 뒤로 가면 블록 경계마다 접두에서 빠진다 — 그게 원래 버그였다."""
    parts = _kinds(build_parts("HEAD", BOARD, "CTX", [FRAME_A], "TAIL"))
    assert parts[0] == ("text", "HEAD")
    assert parts[1] == ("image", BOARD)
    assert parts[2][0] == "text" and parts[2][1].startswith("CTX")


def test_prior_ctx_가_달라도_접두에_명찰판_이미지가_남는다():
    """CTX_RECENT 블록이 넘어가 prior_ctx 가 바뀌는 상황. 이게 핵심 회귀 케이스다."""
    a = _kinds(build_parts("HEAD", BOARD, "CTX-블록1", [FRAME_A], "TAIL-A"))
    b = _kinds(build_parts("HEAD", BOARD, "CTX-블록2 더 길어짐", [FRAME_B], "TAIL-B"))
    pre = _common_prefix(a, b)
    assert ("image", BOARD) in pre, (
        "명찰판 이미지가 공통 접두에서 빠졌다 — 블록 경계마다 캐시가 통째로 빗나간다"
    )


def test_beat_마다_변하는_것은_전부_뒤에_온다():
    """접두가 끝나는 지점 뒤에만 프레임·tail 이 있어야 한다."""
    a = _kinds(build_parts("HEAD", BOARD, "CTX", [FRAME_A], "TAIL-A"))
    b = _kinds(build_parts("HEAD", BOARD, "CTX", [FRAME_B], "TAIL-B"))
    pre = _common_prefix(a, b)
    assert ("image", FRAME_A) not in pre and ("image", FRAME_B) not in pre
    # 같은 블록 안(prior_ctx 동일)이면 prior_ctx 까지가 전부 접두여야 한다
    assert pre == a[:3], f"같은 블록인데 접두가 짧다: {pre}"


def test_head_에는_prior_ctx_가_섞이지_않는다():
    """head 는 회차 내내 한 글자도 안 변해야 한다 — 섞이면 접두가 매번 깨진다."""
    head = build_prompt_head("프로그램 설명", ["김원효", "이수지"])
    assert "지금까지의 흐름" not in head
    assert "b0 " not in head
    # 같은 입력이면 언제나 같은 문자열
    assert head == build_prompt_head("프로그램 설명", ["김원효", "이수지"])


def test_명찰판이_없어도_순서가_유지된다():
    """cast 미등록 프로그램. 이미지가 없으니 prior_ctx 가 head 바로 뒤."""
    parts = _kinds(build_parts("HEAD", None, "CTX", [FRAME_A], "TAIL"))
    assert parts[0] == ("text", "HEAD")
    assert parts[1][0] == "text" and parts[1][1].startswith("CTX")
    assert parts[2] == ("image", FRAME_A)


def test_고정_지시문은_tail_에_없다():
    """[요청] 블록이 tail 로 돌아가면 접두가 197토큰으로 쪼그라든다 — 그게 원래 상태였다."""
    tail = build_prompt_tail({"start": 1.0, "end": 9.0, "transcript": "대사",
                              "boundary": {"start_kind": "gebd"}})
    for 고정문구 in ("[요청]", "정지 관찰형", "on_screen_captions", "맥락 이어붙이기"):
        assert 고정문구 not in tail, f"고정 문구가 변동부에 있다: {고정문구}"


def test_beat0_head_는_이후_head_의_접두다():
    """has_prior 로 head 가 2종이 되는데, 짧은 쪽이 긴 쪽의 **접두**여야 캐시가 안 깨진다."""
    pc = "제목: 어떤 프로그램\n장르: 예능"
    first = build_prompt_head(pc, ["A"], False)     # beat 0 (앞 맥락 없음)
    rest = build_prompt_head(pc, ["A"], True)       # beat 1+
    assert rest.startswith(first), "맥락규칙이 head 중간에 끼어들어 접두가 깨졌다"


def test_head_는_같은_회차에서_항상_같다():
    """beat 이 달라도 head 는 한 글자도 달라지면 안 된다 (캐시 접두의 정의)."""
    pc = "제목: 어떤 프로그램\n장르: 예능"
    assert build_prompt_head(pc, ["A", "B"], True) == build_prompt_head(pc, ["A", "B"], True)


def test_tail_은_정확히_한_번만_들어간다():
    """조립을 함수로 뺄 때 호출부의 옛 append 가 남아 tail 이 두 번 실린 적이 있다."""
    parts = _kinds(build_parts("HEAD", BOARD, "CTX", [FRAME_A], "TAIL"))
    assert [p for p in parts if p == ("text", "TAIL")] == [("text", "TAIL")]
    assert parts[-1] == ("text", "TAIL")
