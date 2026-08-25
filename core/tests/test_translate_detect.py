"""외국어 자막 감지(결정론) 테스트 — LLM 호출 없음.

케이스는 2026-08-25 사용자 스크린샷(눈떠보니 OOO · 중국어 출연자 회차)의 실제 줄에서 왔다.
"""
from core.stt.translate import is_foreign


def test_pure_chinese_detected():
    assert is_foreign("挺好吃的，这汤。但是辣，辣得一点。")
    assert is_foreign("味道挺好吃的。还有，还有，水多了一点。你煮的餐饭我吃过，已经非常高兴了。")
    assert is_foreign("就像做人一样，你做得好一点也没用，都要让他去装扮自己，是不是？ 装扮。")


def test_korean_kept():
    assert not is_foreign("한 입 먹어보고 싶긴 해. 한 입. 궁금하긴 해요.")
    assert not is_foreign("먹을 만한데 그 매운 게 탁 쳐버리니까")
    assert not is_foreign("아, 파를 또 데코레이션을 또")


def test_mixed_hangul_dominant_kept():
    # 한글 우세 혼합줄 — 한 글자 한자 삽입은 보존 (과번역 방지).
    assert not is_foreign("好, 먹읍시다 우리 그냥")
    assert not is_foreign("네, OK 좋아요")


def test_mixed_foreign_dominant_detected():
    assert is_foreign("是啊。 我知道。 你要勤力工作 응")


def test_english_sentence_detected_short_latin_kept():
    assert is_foreign("I really want to try this soup right now")
    assert not is_foreign("MC")          # 짧은 라틴 삽입 보존
    assert not is_foreign("OK")
    assert not is_foreign("")


def test_already_translated_shape():
    # 번역 결과 표기 "(…)" 는 한국어라 재감지되지 않는다 — 재실행 멱등의 근거.
    assert not is_foreign("(한 입 먹어 보세요)")
