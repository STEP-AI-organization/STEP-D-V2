from typing import Any

from app.services.korean_shorts import clean_text, unique


def _number(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _score_band(score: float) -> str:
    if score >= 88:
        return "publish_candidate"
    if score >= 76:
        return "review_candidate"
    if score >= 62:
        return "needs_edit"
    return "weak"


def _first_sentence(text: str, limit: int = 86) -> str:
    cleaned = clean_text(text, limit * 3)
    if not cleaned:
        return ""
    for marker in (".", "!", "?", "。", "！", "？", "\n"):
        if marker in cleaned:
            part = cleaned.split(marker, 1)[0].strip()
            if part:
                return clean_text(part, limit)
    return clean_text(cleaned, limit)


def _hook_line(clip: object, hook_terms: list[str]) -> str:
    thumbnail = clean_text(getattr(clip, "thumbnail_text", ""), 36)
    if thumbnail:
        return thumbnail
    title = clean_text(getattr(clip, "title", ""), 44)
    if title:
        return title
    transcript = _first_sentence(str(getattr(clip, "transcript", "") or ""), 44)
    if transcript:
        return transcript
    return hook_terms[0] if hook_terms else "첫 3초 훅 확인 필요"


def _risk_flags(duration: float, evaluation: dict[str, Any], clip: object) -> list[str]:
    flags: list[str] = []
    if duration > 65:
        flags.append("길이가 길어 후반 이탈 가능성")
    if duration < 18:
        flags.append("맥락이 부족해 보일 수 있음")
    if _number(evaluation.get("hook_score"), 100) < 68:
        flags.append("첫 3초 훅 약함")
    if _number(evaluation.get("retention_score"), 100) < 68:
        flags.append("중반 유지력 점검 필요")
    if _number(evaluation.get("shareability_score"), 100) < 64:
        flags.append("댓글/공유 포인트 약함")
    if bool(evaluation.get("fallback")):
        flags.append("Vision 평가 대신 STT 기반 fallback")
    boundary_reason = str(evaluation.get("boundary_reason") or "")
    if "fallback" in boundary_reason:
        flags.append("컷 경계 수동 확인 권장")
    if not clean_text(getattr(clip, "thumbnail_text", ""), 80):
        flags.append("썸네일 문구 보강 필요")
    return unique(flags, 6)


def _retention_plan(hook_terms: list[str], labels: list[str], duration: float, evaluation: dict[str, Any]) -> list[str]:
    first_hook = hook_terms[0] if hook_terms else "반전/감정 키워드"
    plan = [
        f"0-3초: '{first_hook}'를 자막 색상 강조로 먼저 보여주기",
        "3-12초: 표정/반응이 보이는 구간을 끊지 않고 유지하기",
    ]
    if any(label in labels for label in ("반전", "충격", "소름")):
        plan.append("후반: 반전 또는 리액션 직전까지 호기심을 남기기")
    elif _number(evaluation.get("emotion_score"), 0) >= 78:
        plan.append("후반: 감정 반응이 끝나는 지점까지 자연스럽게 닫기")
    else:
        plan.append("후반: 결론 자막을 짧게 넣어 맥락 손실 줄이기")
    if duration > 55:
        plan.append("게시 전: 45-55초 버전으로 한 번 더 압축 검토")
    return plan[:4]


def _upload_actions(score: float, risks: list[str], hook_terms: list[str]) -> list[str]:
    actions = [
        "제목 첫 20자 안에 핵심 상황 넣기",
        "썸네일 문구는 8-14자 안쪽으로 유지",
        "업로드 전 모바일 화면에서 자막 겹침 확인",
    ]
    if score >= 88:
        actions.insert(0, "상위 후보라 당일 업로드 큐에 우선 배치")
    if hook_terms:
        actions.append(f"태그/설명에 '{hook_terms[0]}' 변형 키워드 포함")
    if risks:
        actions.append("리스크 항목 확인 후 필요하면 Apply & Render로 재렌더")
    return unique(actions, 6)


def build_clip_briefing(
    clip: object,
    youtube_metadata: dict[str, Any],
    korean_shorts_signals: dict[str, Any] | None = None,
) -> dict[str, Any]:
    evaluation = getattr(clip, "evaluation_json", None) or {}
    signals = korean_shorts_signals or {}
    hook_terms = unique([str(item) for item in signals.get("hook_terms", []) or evaluation.get("hook_terms", []) if item], 8)
    labels = unique([str(item) for item in youtube_metadata.get("labels", []) if item], 8)
    duration = round(max(0.0, _number(getattr(clip, "end_time", 0)) - _number(getattr(clip, "start_time", 0))), 2)
    viral_score = _number(getattr(clip, "score", 0))
    hook_score = _number(evaluation.get("hook_score"), _number(getattr(clip, "local_score", 0)))
    retention_score = _number(evaluation.get("retention_score"), viral_score)
    share_score = _number(evaluation.get("shareability_score"), viral_score)

    risks = _risk_flags(duration, evaluation, clip)
    hook_line = _hook_line(clip, hook_terms)
    reason = clean_text(getattr(clip, "reason", "") or evaluation.get("reason") or "", 180)
    if not reason:
        reason = "한국 쇼츠 훅 점수와 대표 프레임 기준으로 선별된 후보입니다."

    return {
        "score_band": _score_band(viral_score),
        "hook_line": hook_line,
        "why_it_works": reason,
        "first_three_seconds": clean_text(f"{hook_line} / {', '.join(hook_terms[:3])}", 120),
        "retention_plan": _retention_plan(hook_terms, labels, duration, evaluation),
        "risk_flags": risks,
        "upload_actions": _upload_actions(viral_score, risks, hook_terms),
        "score_summary": {
            "viral": round(viral_score, 1),
            "hook": round(hook_score, 1),
            "retention": round(retention_score, 1),
            "share": round(share_score, 1),
            "duration_seconds": duration,
        },
    }
