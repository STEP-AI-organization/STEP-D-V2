"""
STEP D Core — Program metadata autofill (Gemini + google_search grounding)

프로그램 제목만 주면 웹 검색 근거로 나머지 필드(시놉시스·방송채널·편성·첫방송·연출·수상·
스핀오프·분위기 태그 등)를 채운다. 2단계 파이프라인:

  1) 검색·수집: google_search grounding tool로 초안 JSON + sources 뽑기
  2) 팩트체크: 초안의 각 필드에 대해 sources에서 실제 근거 있는지 검증 · evidence quote
     · verified=false 필드는 drop → verified 필드만 반환

출연자(cast)는 자동 채움 안 함 (다른 채널·회차마다 다르고, 잘못 채우면 downstream 오염).

Run:
    python -m core.autofill_program "환승연애 3"
    python -m core.autofill_program "환승연애 3" --out /tmp/autofill.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from google import genai
from google.genai import types

from .retry import call_with_retry

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT") or "step-d"
LOCATION = os.environ.get("VERTEX_LOCATION") or "asia-northeast3"
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"

# 자동 채울 필드 정의 (출연자·SMR·프로그램 코드 제외).
TARGET_FIELDS = [
    "section",         # 드라마/영화 · 예능 · 뮤직 등
    "synopsis",        # 한두 문단 시놉시스
    "broadcaster",     # 방송 채널
    "schedule",        # 편성 (요일·시간)
    "firstAiredDate",  # 첫 방송 (YYYY.MM.DD)
    "currentInfo",     # 현재 시즌·회차
    "director",        # 연출
    "spinoff",         # 스핀오프
    "awards",          # 수상 이력
    "moods",           # 분위기 태그 (리스트)
]

# 프론트 select 옵션과 일치해야 함 (edit-program-dialog.tsx).
VALID_SECTIONS = ["드라마/영화", "예능", "뮤직", "시사", "교양", "라이프", "스포츠", "게임", "어린이", "뉴스", "애니"]


def _extract_json(raw: str) -> dict | None:
    """LLM 응답에서 JSON 파싱. code fence·앞뒤 노이즈 대응."""
    if not raw:
        return None
    s = raw.strip()
    # code fence 제거
    if s.startswith("```"):
        m = re.match(r"```(?:json)?\s*(.*?)\s*```", s, re.DOTALL)
        if m:
            s = m.group(1)
    # 앞뒤 노이즈 있으면 { ... } 뭉치만
    start, end = s.find("{"), s.rfind("}")
    if start >= 0 and end > start:
        s = s[start : end + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return None


def _grounding_sources(resp) -> list[dict]:
    """resp.candidates[0].grounding_metadata.grounding_chunks → [{url, title}]."""
    sources: list[dict] = []
    try:
        cand = resp.candidates[0] if resp.candidates else None
        gm = getattr(cand, "grounding_metadata", None) if cand else None
        if not gm:
            return sources
        chunks = getattr(gm, "grounding_chunks", None) or []
        for c in chunks:
            web = getattr(c, "web", None)
            if not web:
                continue
            url = getattr(web, "uri", "") or getattr(web, "url", "")
            title = getattr(web, "title", "") or url
            if url:
                sources.append({"url": url, "title": title})
    except Exception:
        pass
    # 중복 URL 제거
    seen = set()
    dedup = []
    for s in sources:
        if s["url"] in seen:
            continue
        seen.add(s["url"])
        dedup.append(s)
    return dedup


def _search_and_draft(client, title: str) -> tuple[dict, list[dict], str]:
    """Step 1 — grounding tool로 초안 필드 + sources 수집."""
    system = f"""너는 한국 방송·미디어 리서처다. 주어진 프로그램에 대해 웹 검색으로 정보를 수집한다.

**규칙**:
- **웹 검색 결과에 명시적으로 있는 것만** 채운다. 근거 없으면 해당 필드는 빈 문자열.
- 추측·창작 절대 금지. 확실한 사실만.
- 출연자(cast)·SMR 정보는 채우지 마라 (별도 소스에서 관리).

**채울 필드**:
- section: {" / ".join(VALID_SECTIONS)} 중 정확히 하나
- synopsis: 프로그램 시놉시스. 한두 문단(200자 내외).
- broadcaster: 방송 채널 (예: "ENA · SBS플러스", "tvN")
- schedule: 편성 (예: "수 밤 10:30")
- firstAiredDate: 첫 방송 (YYYY.MM.DD 형식)
- currentInfo: 현재 시즌·회차 (예: "시즌 3 · 12회 완결", "25기 · 191회~")
- director: 연출·프로듀서
- spinoff: 스핀오프 (있으면)
- awards: 수상 이력 (있으면)
- moods: 분위기 태그 배열 (2~5개, 예: ["극사실주의", "리얼리티", "로맨스"])

**반환 형식** (JSON만 · 다른 문장·설명 금지):
{{"section":"","synopsis":"","broadcaster":"","schedule":"","firstAiredDate":"","currentInfo":"","director":"","spinoff":"","awards":"","moods":[]}}
"""
    prompt = f"프로그램명: {title}\n\n위 프로그램에 대해 웹 검색해서 위 JSON 형식으로 반환하라."
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                tools=[types.Tool(google_search=types.GoogleSearch())],
                # grounding + response_mime_type="application/json" 병용 불가 → JSON 프롬프트로 유도
                max_output_tokens=2048,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
    except Exception as e:
        return {}, [], f"search 실패: {str(e)[:200]}"
    raw = resp.text or ""
    data = _extract_json(raw) or {}
    sources = _grounding_sources(resp)
    return data, sources, ""


def _factcheck(client, title: str, draft: dict, sources: list[dict]) -> dict:
    """Step 2 — draft의 각 필드가 sources에서 근거 확인되는지 검증.
    verified=false 필드는 drop. evidence quote 함께 반환."""
    if not draft:
        return {"verified_fields": {}, "evidence": {}, "dropped": []}
    sources_txt = "\n".join(f"[{i}] {s['title']} · {s['url']}" for i, s in enumerate(sources)) or "(sources 없음)"
    system = """너는 팩트체커다. 초안 필드 각각이 sources에 명시적 근거가 있는지 검증한다.

**규칙**:
- **verified=true** 조건: sources 중 한 곳 이상에서 그 값이 명시적으로 언급됨. 유사·추정 안 됨.
- **verified=false** 조건: sources에 근거가 없거나 모호하거나 상충하는 경우.
- evidence: verified=true인 필드에 한해, sources에서 인용한 짧은 문장 (있는 그대로).
- moods 배열은 개별 항목 각각 검증 · verified 항목만 남김.

**반환 형식** (JSON):
{"verified_fields":{"synopsis":"..."},"evidence":{"synopsis":"..."},"dropped":["director","awards"]}
"""
    prompt = f"""프로그램: {title}

=== 초안 (autofill Step 1 결과) ===
{json.dumps(draft, ensure_ascii=False, indent=2)}

=== sources (grounding) ===
{sources_txt}

각 필드가 sources에서 근거 확인되는지 판단하고 verified_fields·evidence·dropped 반환."""
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0,
                response_mime_type="application/json",
                max_output_tokens=2048,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
    except Exception as e:
        # 팩트체크 실패 시 draft 그대로 반환 (verified 표시 못 함)
        return {
            "verified_fields": draft, "evidence": {}, "dropped": [],
            "factcheck_error": str(e)[:200],
        }
    raw = resp.text or ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = _extract_json(raw) or {"verified_fields": {}, "evidence": {}, "dropped": []}
    return {
        "verified_fields": data.get("verified_fields") if isinstance(data.get("verified_fields"), dict) else {},
        "evidence": data.get("evidence") if isinstance(data.get("evidence"), dict) else {},
        "dropped": data.get("dropped") if isinstance(data.get("dropped"), list) else [],
    }


def _sanitize_fields(fields: dict) -> dict:
    """반환 필드 정규화. section은 whitelist · moods는 리스트 · 나머지는 문자열."""
    out: dict = {}
    for k in TARGET_FIELDS:
        v = fields.get(k)
        if v is None:
            continue
        if k == "moods":
            if isinstance(v, list):
                cleaned = [str(m).strip() for m in v if str(m).strip()]
                if cleaned:
                    out[k] = cleaned[:8]  # 상한
            continue
        if k == "section":
            sv = str(v).strip()
            if sv in VALID_SECTIONS:
                out[k] = sv
            continue
        sv = str(v).strip()
        if sv:
            out[k] = sv
    return out


def autofill(title: str) -> dict:
    """title → {fields, sources, evidence, dropped, error?}."""
    if not title or not title.strip():
        return {"fields": {}, "sources": [], "evidence": {}, "dropped": [], "error": "title empty"}
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    print(f"[autofill] Step 1: 웹 검색 (title={title!r})", file=sys.stderr)
    draft, sources, search_err = _search_and_draft(client, title)
    if search_err and not draft:
        return {"fields": {}, "sources": sources, "evidence": {}, "dropped": [],
                "error": search_err}

    print(f"[autofill] Step 1 완료 · 초안 필드 {len(draft)}개 · sources {len(sources)}개", file=sys.stderr)
    print(f"[autofill] Step 2: 팩트체크", file=sys.stderr)
    fc = _factcheck(client, title, draft, sources)
    verified = _sanitize_fields(fc.get("verified_fields") or {})
    print(f"[autofill] Step 2 완료 · verified {len(verified)}개 · dropped {len(fc.get('dropped') or [])}", file=sys.stderr)

    return {
        "fields": verified,
        "sources": sources,
        "evidence": fc.get("evidence") or {},
        "dropped": fc.get("dropped") or [],
        "factcheck_error": fc.get("factcheck_error") or "",
    }


def autofill_with_questions(title: str) -> dict:
    """검색·팩트체크 실행 후 draft + questions 반환.
    questions는 애매하거나 근거 부족(dropped) 필드에 대해 사용자에게 한 번에 물을 목록.
    각 질문에 suggestions(추천 답변 · 검색 결과에서 뽑음) + '기타(직접 입력)' 옵션.
    사용자가 UI에서 답 받으면 서버는 그대로 draft에 병합만 하면 됨(추가 콜 X).

    반환: {draft, sources, evidence, dropped, questions}
    questions: [{"field": "director", "question": "연출자 아시나요?", "suggestions": ["김철수"], "allowOther": true}]
    """
    if not title.strip():
        return {"draft": {}, "sources": [], "evidence": {}, "dropped": [], "questions": [], "error": "title empty"}
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    print(f"[autofill·q] Step 1: 웹 검색 (title={title!r})", file=sys.stderr)
    draft, sources, search_err = _search_and_draft(client, title)
    if search_err and not draft:
        return {"draft": {}, "sources": sources, "evidence": {}, "dropped": [], "questions": [],
                "error": search_err}
    fc = _factcheck(client, title, draft, sources)
    verified = _sanitize_fields(fc.get("verified_fields") or {})
    dropped = fc.get("dropped") or []
    evidence = fc.get("evidence") or {}
    print(f"[autofill·q] verified {len(verified)} · dropped {len(dropped)} · sources {len(sources)}", file=sys.stderr)

    # 질문 생성 — dropped 필드 위주 · 각 필드에 suggestions 추출.
    # LLM에 raw draft(팩트체크 전) + sources 주고 "각 dropped 필드에 대해 suggestions 최대 3개" 요청.
    questions: list[dict] = []
    if dropped and draft:
        q_system = """너는 방송 정보 대화 assistant. 아래 raw draft(팩트체크 통과 못한 필드 포함)와
sources를 보고, 사용자에게 던질 짧은 질문 리스트를 만든다.

**규칙**:
- 각 dropped 필드에 대해 1개 질문.
- suggestions는 raw draft 값·sources에서 유추한 후보 (최대 3개). 확신 없으면 빈 배열.
- 질문 톤은 짧고 친절하게. "혹시 X 아시나요?" 형식.

**반환 형식** (JSON):
{"questions":[{"field":"director","question":"연출자 아시나요?","suggestions":["김철수"],"allowOther":true}]}
"""
        q_prompt = f"""프로그램: {title}

=== raw draft ===
{json.dumps(draft, ensure_ascii=False, indent=2)}

=== dropped (팩트체크 못한 필드) ===
{json.dumps(dropped, ensure_ascii=False)}

=== sources ===
{json.dumps([{'title': s.get('title'), 'url': s.get('url')} for s in sources], ensure_ascii=False)}

각 dropped 필드에 대해 사용자에게 물을 짧은 질문 리스트 생성."""
        try:
            resp = call_with_retry(lambda: client.models.generate_content(
                model=MODEL,
                contents=q_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=q_system,
                    temperature=0.3,
                    response_mime_type="application/json",
                    max_output_tokens=1024,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            ))
            qdata = json.loads(resp.text or "{}")
            for q in (qdata.get("questions") or []):
                field = str(q.get("field", "")).strip()
                if field not in dropped:
                    continue
                sugs = [str(s).strip() for s in (q.get("suggestions") or []) if str(s).strip()][:3]
                questions.append({
                    "field": field,
                    "question": str(q.get("question") or f"{field} 아시나요?").strip(),
                    "suggestions": sugs,
                    "allowOther": True,
                })
        except Exception as e:
            print(f"[autofill·q] 질문 생성 실패 (스킵): {str(e)[:80]}", file=sys.stderr)
            # 폴백 — 각 dropped 필드에 대해 기본 질문 하나씩
            LABELS = {
                "director": "연출자", "spinoff": "스핀오프", "awards": "수상",
                "broadcaster": "방송 채널", "schedule": "편성", "firstAiredDate": "첫 방송",
                "currentInfo": "현재 시즌·회차", "synopsis": "시놉시스", "moods": "분위기 태그",
            }
            for f in dropped:
                questions.append({
                    "field": f,
                    "question": f"{LABELS.get(f, f)} 아시나요?",
                    "suggestions": [], "allowOther": True,
                })
    return {
        "draft": verified,
        "sources": sources,
        "evidence": evidence,
        "dropped": dropped,
        "questions": questions,
    }


def chat_turn(title: str, history: list[dict], draft: dict | None = None,
              sources: list[dict] | None = None) -> dict:
    """대화형 자동 채움. history는 [{role:'assistant'|'user', content:str}, ...].
    첫 turn (history=[]): 웹 검색·초안·팩트체크 실행 후 assistant 메시지 반환.
    이후: 사용자 답 반영해서 다음 질문 or 최종 apply.

    반환: {message, action, fields?, sources?, evidence?, dropped?, draft?}
    action:
      - 'question': message가 사용자에게 물을 질문. draft/sources는 다음 turn에 넘기라고 반환.
      - 'apply': 채움 완료. fields·sources·evidence·dropped 반환.
      - 'error': 실패.
    """
    if not title.strip():
        return {"message": "제목이 비어있습니다.", "action": "error"}
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    # 첫 turn: 검색·초안·팩트체크 실행 (기존 autofill 재사용)
    if not history:
        print("[autofill·chat] 첫 turn: 검색·팩트체크", file=sys.stderr)
        d, srcs, err = _search_and_draft(client, title)
        if err and not d:
            return {"message": f"웹 검색 실패: {err[:120]}", "action": "error"}
        fc = _factcheck(client, title, d, srcs)
        verified = _sanitize_fields(fc.get("verified_fields") or {})
        dropped = fc.get("dropped") or []
        evidence = fc.get("evidence") or {}
        summary_lines = [f"**{title}** 검색 결과입니다."]
        if verified:
            summary_lines.append(f"확인된 필드 {len(verified)}개: " + ", ".join(sorted(verified.keys())))
        if dropped:
            summary_lines.append(f"근거 부족으로 뺀 필드 {len(dropped)}개: " + ", ".join(dropped))
        summary_lines.append(f"근거 sources: {len(srcs)}개")
        # 추가 질문 필요? 사용자에게 확인
        if dropped:
            summary_lines.append("")
            summary_lines.append(f"혹시 **{', '.join(dropped[:3])}** 아시면 알려주시겠어요? (모르시면 '없음' 이라고 답해주세요) 답이 없어도 '적용' 이라고 하시면 확인된 것만 채웁니다.")
        else:
            summary_lines.append("")
            summary_lines.append("이대로 적용할까요? '적용' 이라고 답하시면 빈 필드에 반영합니다.")
        return {
            "message": "\n".join(summary_lines),
            "action": "question",
            "draft": verified,
            "sources": srcs,
            "evidence": evidence,
            "dropped": dropped,
        }

    # 이후 turn: 사용자 답을 draft에 반영하거나 최종 apply
    last_user = ""
    for m in reversed(history):
        if m.get("role") == "user":
            last_user = str(m.get("content") or "").strip()
            break

    # '적용' 명령어 감지 → 현재 draft 그대로 반환
    if any(kw in last_user for kw in ("적용", "확정", "그대로", "ok", "OK", "apply")):
        return {
            "message": f"확인된 필드 {len(draft or {})}개를 빈 필드에 반영합니다.",
            "action": "apply",
            "fields": draft or {},
            "sources": sources or [],
        }

    # LLM에게 사용자 답 반영을 위임 (매 턴 검색 다시 안 함 · draft만 갱신)
    system = f"""너는 방송 프로그램 정보 정리 assistant. 사용자와 짧게 대화해서 프로그램 필드를
채운다. 이미 웹 검색·팩트체크로 초안이 있음. 사용자가 추가 정보 주면 draft에 반영, 모른다고
하면 그 필드 스킵.

**규칙**:
- 사용자가 정보 주면 draft에 반영 (기존 값 있어도 사용자 값 우선).
- 사용자가 '없음'·'모름'·'안다'·'모르겠음' 등이라 답하면 그 필드는 그대로 두고 다음 확인.
- 남은 확인 필드가 없거나 사용자가 '적용'이라 하면 action='apply'.
- 아직 확인할 게 있으면 짧은 질문 하나만 (한 번에 1개 필드).

**반환 형식** (JSON만):
{{"message":"...","action":"question|apply","draft":{{...}},"asked_field":"..."}}

draft는 지금까지 확인된 필드 (기존 + 사용자 답 반영). asked_field는 이번 턴에 물어본 필드명(문자열).
"""
    dropped_list = []
    if history:
        # 첫 assistant 메시지에서 dropped 언급을 유추 (간단히)
        pass
    prompt = f"""프로그램: {title}

=== 현재 draft (팩트체크 통과한 필드) ===
{json.dumps(draft or {}, ensure_ascii=False, indent=2)}

=== 대화 기록 ===
""" + "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in history) + f"""

사용자의 마지막 답을 draft에 반영하고, 남은 확인 필드가 있으면 짧게 물어라. 없으면 action='apply'."""
    try:
        resp = call_with_retry(lambda: client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.3,
                response_mime_type="application/json",
                max_output_tokens=1024,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        ))
        raw = resp.text or "{}"
        data = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        return {"message": f"응답 처리 실패: {str(e)[:120]}", "action": "error"}
    new_draft = _sanitize_fields(data.get("draft") or draft or {})
    action = data.get("action") if data.get("action") in ("question", "apply") else "question"
    msg = str(data.get("message") or "").strip() or "다음으로 진행할까요?"
    result = {"message": msg, "action": action, "draft": new_draft, "sources": sources or []}
    if action == "apply":
        result["fields"] = new_draft
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["oneshot", "chat", "questions"], default="oneshot")
    ap.add_argument("title", help="프로그램 제목")
    ap.add_argument("--history", help="chat 모드: JSON 배열 [{role, content}...]")
    ap.add_argument("--draft", help="chat 모드: 이전 turn draft (JSON dict)")
    ap.add_argument("--sources", help="chat 모드: 이전 turn sources (JSON list)")
    ap.add_argument("--out", help="결과 JSON 저장 경로. 없으면 stdout.")
    args = ap.parse_args()
    if args.mode == "chat":
        history = json.loads(args.history) if args.history else []
        draft = json.loads(args.draft) if args.draft else None
        srcs = json.loads(args.sources) if args.sources else None
        result = chat_turn(args.title, history, draft, srcs)
    elif args.mode == "questions":
        result = autofill_with_questions(args.title)
    else:
        result = autofill(args.title)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        from pathlib import Path
        Path(args.out).write_text(payload, encoding="utf-8")
        print(f"→ {args.out}", file=sys.stderr)
    else:
        print(payload)


if __name__ == "__main__":
    main()
