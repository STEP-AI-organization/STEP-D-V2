import re
from collections.abc import Iterable


HOOK_CATEGORIES: dict[str, tuple[int, tuple[str, ...]]] = {
    "shock": (
        22,
        (
            "충격",
            "소름",
            "소름돋",
            "대박",
            "미쳤",
            "미친",
            "레전드",
            "실화",
            "역대급",
            "말도 안",
            "진짜?",
            "난리",
            "shocking",
            "crazy",
        ),
    ),
    "reversal": (
        19,
        (
            "반전",
            "그런데",
            "근데",
            "하지만",
            "알고 보니",
            "알고보니",
            "갑자기",
            "결국",
            "분위기",
            "뒤집",
            "바뀌",
            "twist",
        ),
    ),
    "curiosity": (
        18,
        (
            "왜",
            "뭐야",
            "무슨",
            "어떻게",
            "비밀",
            "처음 공개",
            "몰랐",
            "정체",
            "이유",
            "진실",
            "공개",
            "마지막",
            "결말",
            "한마디",
            "secret",
        ),
    ),
    "conflict": (
        17,
        (
            "논란",
            "싸움",
            "말싸움",
            "분노",
            "화났",
            "정색",
            "저격",
            "폭로",
            "경고",
            "하지 마",
            "절대",
            "갈릴",
        ),
    ),
    "emotion": (
        15,
        (
            "눈물",
            "울컥",
            "오열",
            "감동",
            "슬프",
            "웃긴",
            "웃겨",
            "폭소",
            "빵터",
            "멘붕",
            "당황",
            "무섭",
            "설렘",
            "빡침",
        ),
    ),
    "payoff": (
        13,
        (
            "꿀팁",
            "방법",
            "해야 합니다",
            "이렇게",
            "바뀝니다",
            "드디어",
            "성공",
            "실패",
            "결과",
            "정답",
            "tip",
        ),
    ),
}

SPOKEN_ENDINGS = ("잖아", "잖아요", "거야", "거죠", "거예요", "했어요", "합니다", "아니에요", "맞아요", "네요")
COMMENT_TRIGGERS = ("여러분", "댓글", "반응", "인정", "공감", "맞죠", "어때요", "갈릴", "난리", "태그")
TOKEN_RE = re.compile(r"[0-9A-Za-z가-힣]{2,}")
STOPWORDS = {
    "그리고",
    "그런데",
    "하지만",
    "제가",
    "저는",
    "이거",
    "그거",
    "영상",
    "정말",
    "진짜",
    "shorts",
    "clip",
}


def clean_text(text: object, max_length: int | None = None) -> str:
    value = " ".join(str(text or "").split())
    if max_length and len(value) > max_length:
        return value[: max_length - 3].rstrip() + "..."
    return value


def unique(items: Iterable[str], limit: int) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        cleaned = clean_text(item)
        key = cleaned.lower()
        if not cleaned or key in seen:
            continue
        seen.add(key)
        result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def score_text_for_korean_shorts(text: str) -> tuple[float, list[str]]:
    normalized = clean_text(text).lower()
    score = 8.0
    matched: list[str] = []

    for _category, (weight, terms) in HOOK_CATEGORIES.items():
        hits = [term for term in terms if term.lower() in normalized]
        if hits:
            matched.extend(hits[:3])
            score += weight

    question_count = normalized.count("?") + normalized.count("？")
    exclaim_count = normalized.count("!") + normalized.count("！")
    score += min(14.0, question_count * 5 + exclaim_count * 3)

    if any(ending in normalized for ending in SPOKEN_ENDINGS):
        score += 7
    if any(trigger in normalized for trigger in COMMENT_TRIGGERS):
        score += 5

    text_length = len(normalized)
    if 35 <= text_length <= 220:
        score += 10
    elif 15 <= text_length < 35:
        score += 5
    elif text_length > 320:
        score -= 8

    hangul_chars = sum(1 for char in normalized if "가" <= char <= "힣")
    if hangul_chars >= 12:
        score += min(8.0, hangul_chars / max(1, text_length) * 10)

    return max(0.0, min(100.0, score)), unique(matched, 10)


def keyword_tags(text: str, limit: int = 12) -> list[str]:
    tokens = TOKEN_RE.findall(text)
    useful = [token for token in tokens if token.lower() not in STOPWORDS and len(token) <= 18]
    return unique(useful, limit)


def labels(text: str) -> list[str]:
    lowered = clean_text(text).lower()
    result = ["쇼츠", "한국쇼츠"]
    label_map = {
        "충격": ("충격", "소름", "대박", "미쳤", "역대급"),
        "반전": ("반전", "그런데", "근데", "알고 보니", "알고보니", "결국", "마지막"),
        "논란": ("논란", "싸움", "분노", "저격", "폭로", "갈릴"),
        "감정": ("눈물", "울컥", "오열", "감동", "웃긴", "폭소", "당황"),
        "꿀팁": ("꿀팁", "방법", "이렇게", "정답", "성공"),
    }
    for label, needles in label_map.items():
        if any(needle.lower() in lowered for needle in needles):
            result.append(label)
    return unique(result, 8)


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?。！？])\s+|(?<=[.!?。！？])", text)
    return [clean_text(part) for part in parts if clean_text(part)]


def _viral_base_title(base: str, hook: str) -> str:
    if not base:
        return f"{hook} 터진 순간 다들 멈췄습니다"
    if len(base) <= 30:
        return f"{base}, 이건 그냥 못 넘깁니다"
    return f"{hook} 때문에 분위기 바로 뒤집힘"


def _quote_hook(sentence: str, hook: str) -> str:
    quote = clean_text(sentence, 28)
    if quote:
        return f'"{quote}" 이 말 나오자마자 끝났습니다'
    return f"{hook} 나온 뒤 반응이 갈렸습니다"


def build_title_options(
    title: object,
    transcript: object,
    thumbnail_text: object,
    hook_terms: Iterable[object],
) -> list[dict[str, str]]:
    transcript_text = clean_text(transcript, 520)
    sentences = split_sentences(transcript_text)
    first = sentences[0] if sentences else transcript_text
    second = sentences[1] if len(sentences) > 1 else first
    hooks = [clean_text(term) for term in hook_terms if clean_text(term)]
    hook = hooks[0] if hooks else "이 장면"
    base = clean_text(title or first or "놓치면 아쉬운 장면", 54)
    overlay = clean_text(thumbnail_text or hook, 18)

    raw = [
        (_viral_base_title(base, hook), overlay, "shock", "중립 요약보다 클릭을 유도하는 반응형 제목입니다."),
        (f"{hook} 터진 순간, 분위기 바로 얼어붙음", clean_text(f"{hook} 터진 순간", 18), "hook", "첫 문장에서 감정 반응을 강하게 여는 훅입니다."),
        ("마지막 한마디 듣고 다들 멈췄습니다", "마지막 한마디", "curiosity", "결말을 숨겨 완주율을 노리는 궁금증형 제목입니다."),
        (_quote_hook(first, hook), clean_text(first or hook, 18), "quote", "강한 대사를 사건처럼 보이게 만드는 대사형 옵션입니다."),
        ("이 장면은 댓글 싸움 날 듯", "댓글 갈릴 듯", "comment", "댓글 참여를 유도하는 자극형 옵션입니다."),
    ]

    options: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_title, raw_overlay, style, reason in raw:
        option_title = clean_text(raw_title, 70) or "놓치면 아쉬운 장면"
        if option_title.lower() in seen:
            option_title = clean_text(f"{option_title} #{len(options) + 1}", 70)
        seen.add(option_title.lower())
        options.append(
            {
                "id": f"opt_{len(options) + 1}",
                "title": option_title,
                "overlay_text": clean_text(raw_overlay, 24) or overlay,
                "style": style,
                "reason": reason,
            }
        )
    return options[:5]
