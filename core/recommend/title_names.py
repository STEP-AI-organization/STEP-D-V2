"""제목 전용 배우 대응표. 대사와 분석 결과는 변환하지 않는다."""
import json

NAMELESS_TITLE = "다시 보는 이 장면"


def title_cast(ctx):
    rows = (ctx or {}).get("titleCast", [])
    if not isinstance(rows, list):
        return []
    return [m for m in rows if isinstance(m, dict) and isinstance(m.get("actorName"), str)
            and m["actorName"].strip() and isinstance(m.get("characterNames"), list)
            and all(isinstance(n, str) and n.strip() for n in m["characterNames"])]


def title_names_prompt(ctx):
    cast = title_cast(ctx)
    if not cast:
        return ""
    rows = [f'- 극중 이름 {json.dumps(m["characterNames"], ensure_ascii=False)} = 배우명 '
            f'{json.dumps(m["actorName"], ensure_ascii=False)}' for m in cast]
    return ("\n\n[제목 인물 표기 — 배우명]\n" + "\n".join(rows)
            + "\n- title·title_line1·title_line2·제목 후보는 극중 이름 대신 위 배우명(활동명)을 쓴다."
            + "\n- 이 대응표는 이름 변환의 근거다. 장면·대사에 극중 이름이 확인되면 대응 배우명은 대사에 없어도 사용할 수 있다. 기존의 '대사·요약에 나온 이름만' 규칙에 대한 예외다."
            + "\n- 명단에 있다는 이유만으로 등장했다고 판단하지 마라. 해당 구간에 근거가 있는 인물만 쓴다. 대응되지 않거나 아역·성인역 구분이 불확실하면 이름 없는 상황형 제목을 쓴다."
            + "\n- 극중 이름이 든 대사를 제목에서 직접 인용하지 말고 배우명을 쓰는 관찰형 문장으로 다시 쓴다. 조사도 자연스럽게 맞춘다."
            + "\n- 극중 사건을 배우의 실제 사생활·범죄로 서술하지 마라. 필요하면 연기·장면임을 드러낸다. 대사 자막·hook_quote·줄거리·characters는 원문을 유지한다.")


def is_actor_title(text, ctx):
    cast = title_cast(ctx)
    for actor in sorted((m["actorName"] for m in cast), key=len, reverse=True):
        text = text.replace(actor, "\0")
    return not any(n != m["actorName"] and n in text
                   for m in cast for n in m["characterNames"])


def visible_actor_names(ctx, visible_cast):
    """YOLO 가 이 구간에서 **확인한** 배우명 집합. 실명형 판정·검증이 같은 집합을 본다."""
    allowed = set()
    cast = title_cast(ctx)
    for row in (visible_cast if isinstance(visible_cast, list) else []):
        if not isinstance(row, dict):
            continue
        actor = str(row.get("actorName") or "").strip()
        name = str(row.get("name") or "").strip()
        if actor:
            allowed.add(actor)
        for member in cast:
            if name == str(member.get("actorName") or "").strip() or name in member.get("characterNames", []):
                allowed.add(member["actorName"].strip())
    allowed.discard("")
    return allowed


def is_visible_actor_title(text, ctx, visible_cast):
    """Reject configured actor names that were not identified in the selected beats.

    ``is_actor_title`` only proves that a title uses actor names instead of character
    names.  It does not prove that the actor is in this clip.  YOLO cast output supplies
    that missing fact.  Old recommendations without ``visible_cast`` keep legacy behavior.
    """
    if not is_actor_title(text, ctx):
        return False
    if not isinstance(visible_cast, list):
        return True
    allowed = visible_actor_names(ctx, visible_cast)
    cast = title_cast(ctx)
    configured = {m["actorName"].strip() for m in cast}
    mentioned = {name for name in configured if name and name in text}
    return mentioned.issubset(allowed)


def guard_title_result(result, ctx):
    """실패·휴리스틱 폴백을 포함해 모든 추천 출구에서 검증. 원문 인용은 치환하지 않는다."""
    if not title_cast(ctx):
        return result
    for short in result.get("shorts", []):
        visible_cast = short.get("visible_cast") if "visible_cast" in short else None
        title = str(short.get("title") or "")
        if not is_visible_actor_title(title, ctx, visible_cast):
            short["title"] = NAMELESS_TITLE
        lines = [str(short.get(k) or "") for k in ("title_line1", "title_line2")]
        if not all(is_visible_actor_title(line, ctx, visible_cast) for line in lines):
            # 두 줄 중 하나만 버리면 문장 의미가 바뀐다. 검증한 한 줄 제목으로 함께 대체한다.
            short["title_line1"] = ""
            short["title_line2"] = ""
        if isinstance(short.get("title_candidates"), list):
            short["title_candidates"] = list(dict.fromkeys(
                [short.get("title") or NAMELESS_TITLE] + [c for c in short["title_candidates"]
                 if isinstance(c, str) and c.strip() and is_visible_actor_title(c, ctx, visible_cast)]))
        _guard_overlay_variants(short, ctx, visible_cast)
    return result


def _guard_overlay_variants(short, ctx, visible_cast):
    """오버레이 3형(title_alts kind name/quote/situation · 2026-09-15) 검증 + 실명형 승격.

    - 모든 변형의 줄은 미확인 배우명 검증(is_visible_actor_title)을 통과해야 남는다.
    - kind "name"(실명형)은 추가로 **확인된 배우명을 실제로 담고 있어야** 실명형이다 —
      이름 없는 문장에 name 딱지만 붙은 것은 situation 으로 강등한다.
    - 검증 통과한 실명형이 있으면 **기본(title_line1/2)을 실명형으로 교체**한다
      (사용자 2026-09-15 "실명형에 우리 파이프라인" — YOLO 확인이 곧 승격 조건이다).
      원래 기본 줄은 alts 맨 앞에 남겨 운영자가 되돌릴 수 있게 한다.
    선별이 아니라 **결정론 규칙**이다 — LLM 에게 어느 형을 내보낼지 묻지 않는다.
    """
    alts = short.get("title_alts")
    if not isinstance(alts, list) or not alts:
        return
    allowed = visible_actor_names(ctx, visible_cast)
    kept = []
    promote = None
    for alt in alts:
        if not isinstance(alt, dict):
            continue
        a1 = str(alt.get("title_line1") or "").strip()
        a2 = str(alt.get("title_line2") or "").strip()
        if not (a1 or a2):
            continue
        if not all(is_visible_actor_title(line, ctx, visible_cast) for line in (a1, a2) if line):
            continue  # 미확인 배우명이 든 변형은 유형 불문 버린다
        kind = str(alt.get("kind") or "").strip().lower()
        if kind == "name":
            if not any(name in a1 or name in a2 for name in allowed):
                alt = {**alt, "kind": "situation"}   # 이름 없는 실명형 → 상황형 강등
            elif promote is None:
                promote = (a1, a2)
        kept.append(alt)
    short["title_alts"] = kept
    if promote:
        prev = (str(short.get("title_line1") or "").strip(), str(short.get("title_line2") or "").strip())
        if prev != promote:
            if prev[0] or prev[1]:
                kept.insert(0, {"title_line1": prev[0], "title_line2": prev[1]})
            short["title_line1"], short["title_line2"] = promote
