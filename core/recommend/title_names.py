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


def guard_title_result(result, ctx):
    """실패·휴리스틱 폴백을 포함해 모든 추천 출구에서 검증. 원문 인용은 치환하지 않는다."""
    if not title_cast(ctx):
        return result
    for short in result.get("shorts", []):
        title = str(short.get("title") or "")
        if not is_actor_title(title, ctx):
            short["title"] = NAMELESS_TITLE
        lines = [str(short.get(k) or "") for k in ("title_line1", "title_line2")]
        if not all(is_actor_title(line, ctx) for line in lines):
            # 두 줄 중 하나만 버리면 문장 의미가 바뀐다. 검증한 한 줄 제목으로 함께 대체한다.
            short["title_line1"] = ""
            short["title_line2"] = ""
        if isinstance(short.get("title_candidates"), list):
            short["title_candidates"] = list(dict.fromkeys(
                [short.get("title") or NAMELESS_TITLE] + [c for c in short["title_candidates"]
                 if isinstance(c, str) and c.strip() and is_actor_title(c, ctx)]))
    return result
