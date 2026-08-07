# Program Prompt Pack — 프로그램별 분석 프로파일 시스템

2026-07-31 · 사용자 지시: 프로그램마다 참가자 명칭·용어·서사 규칙이 다르니 분석 프롬프트를 프로그램별로 커스텀 · 실무자(방송사 편집자·PD)가 UI에서 편집·저장 → 회차 분석 시 자동 반영.

## Why

지금 core 파이프라인의 프롬프트(chyron OCR·narrative·beat_annot·recommend)는 하드코딩. 프로그램 특성 무시:

- **나는 솔로**: 27기 영철 · 6인 반복 가명 · "솔로 나라"·"고독정식"·"직진" 등 고유 용어 · 인터뷰↔행동 괴리·0표 감정 추적 관점
- **환승연애**: 원커플·현커플·새 짝 관계 · "재선택"·"편지" 이벤트 · 감정선 추적
- **무한도전**: 캐릭터 고정 별명 · 게임 규칙별 특화
- **한블리(한 편의 블랙박스)**: 사건·차량 등장 순서 · 목격자 진술 대조

한 프롬프트로 다 커버 불가 · 프로그램마다 다른 앵글로 분석해야 편집자가 실제 쓸 수 있는 결과.

## 사용자 페르소나

- **주 사용자**: 방송사·MCN 편집자·PD (기술 지식 없음, 자기 프로그램 도메인 전문가)
- **행동 패턴**: 새 프로그램 등록 → 회차 파일 업로드 → 분석 결과 검토 → 편집
- **니즈**:
  - 자기 프로그램 도메인 지식(참가자 룰·용어) 을 시스템에 한 번 넣으면 이후 자동 반영
  - 다른 사람이 편집해도 일관된 결과
  - AI가 이해 못하는 도메인 규칙(예 나솔의 익명제)을 자연어로 알려주면 인식

## UX 시나리오

### 1) 신규 프로그램 등록 (30초 온보딩)

```
[+] 새 프로그램
    ↓
프로그램명 입력: "나는 솔로"
    ↓
[자동 채움] 클릭 (기존 autofill 재사용 + prompt_pack 확장)
    ↓
5-10초 대기 (Gemini + google_search)
    ↓
결과 프리뷰:
  참가자 명칭 규칙: "N기 가명 (예: 27기 영철)"
  가명 목록: 영수·영철·상철·광수·영식·영호(남) / 영숙·영자·순자·옥순·정숙·현숙(여)
  고유 용어: 솔로 나라 · 고독정식 · 귓속말 · 동시선택 · 최종선택 · 맞선택 · 랜덤데이트 · 직진
  서사 훅: 인터뷰↔행동 괴리 · 0표 감정 추적 · 선택/지목 관계 기록
    ↓
[확인 · 저장] or [편집]
```

### 2) 편집 (필요할 때만)

프로그램 상세 페이지 → **"분석 프로파일"** 탭:

```
┌─ 명칭 규칙 (naming_convention) ─────────────────────┐
│ [textarea]                                            │
│ 27기 영철 형식 · 본명은 최종 선택 시에만 공개        │
└──────────────────────────────────────────────────────┘

┌─ 가명 사전 (aliases) ─────────────────────────────────┐
│ 남: [영수] [영철] [상철] [광수] [영식] [영호] [+ 추가] │
│ 여: [영숙] [영자] [순자] [옥순] [정숙] [현숙] [+ 추가] │
└──────────────────────────────────────────────────────┘

┌─ 고유 용어 (glossary) ───────────────────────────────┐
│ 솔로 나라   | 방송 배경 세팅 (외딴 촬영지)             │
│ 고독정식    | 선택 못 받은 사람의 혼밥                 │
│ 귓속말      | 최종 선택 시 본명 공개하는 순간           │
│ 동시선택    | ...                                     │
│ [+ 항목 추가]                                        │
└──────────────────────────────────────────────────────┘

┌─ 서사 훅 (narrative_hooks) ───────────────────────────┐
│ [chip] 인터뷰↔행동 괴리 반드시 기록                    │
│ [chip] 0표 참가자 감정 변화 추적                       │
│ [chip] 선택/지목 관계 (누가 누구를) 명확히 기록         │
│ [+ 훅 추가]                                          │
└──────────────────────────────────────────────────────┘

┌─ 자유 지시 (analysis_rules) ─────────────────────────┐
│ [textarea]                                            │
│ 회차 분석 시 반드시 지킬 규칙을 자유롭게. 예:         │
│ - 남녀 짝짓기 표(누가 누구 선택) 를 요약에 포함        │
│ - 이번 회차 새로 등장한 참가자 우선 소개             │
└──────────────────────────────────────────────────────┘

[저장]  [초기화]  [다른 프로그램 프로파일 복사]
```

### 3) 회차 업로드 → 자동 반영

- 회차 파일 업로드 → core 파이프라인 실행
- content-pipeline.ts 가 그 프로그램의 prompt_pack 을 python subprocess env 로 전달
- core/analyze.py 가 각 스테이지 프롬프트 조립 시 · prompt_pack 필드 삽입
- 결과에 프로그램 특화 정보가 반영됨 (예 chyron 이 "N기 가명" 형식 정확히 인식)

## 데이터 모델

### `program.prompt_pack` (JSONB, PostgreSQL)

```json
{
  "naming_convention": "27기 영철 형식. 본명은 최종 선택 순간에만 공개.",
  "aliases": {
    "male":   ["영수", "영철", "상철", "광수", "영식", "영호"],
    "female": ["영숙", "영자", "순자", "옥순", "정숙", "현숙"]
  },
  "glossary": [
    { "term": "솔로 나라",   "definition": "외딴 촬영지 세팅" },
    { "term": "고독정식",   "definition": "선택 못 받은 사람의 혼밥" },
    { "term": "귓속말",     "definition": "최종 선택 시 본명 공개" },
    { "term": "동시선택",   "definition": "..." },
    { "term": "직진",       "definition": "적극 어필" }
  ],
  "narrative_hooks": [
    "인터뷰-행동 괴리 반드시 기록",
    "0표(선택 못 받음) 참가자 감정 변화 추적",
    "선택/지목 장면에서 누가 누구를 선택했는지 명확히"
  ],
  "analysis_rules": "회차 요약에 남녀 짝짓기 표를 포함. 새 등장 참가자를 우선 소개. 자막 태그의 'N기 가명' 형식을 화자 라벨로 사용.",
  "updated_by": "user_id",
  "updated_at": "2026-07-31T15:00:00Z"
}
```

기존 `program.cast` 는 유지 · prompt_pack 은 그 위 도메인 지식. `cast` 는 인물 목록 (photo·역할 등) · `prompt_pack` 은 프로그램 규칙.

### Migration (기존 프로그램)

- 스키마: program 테이블에 `prompt_pack JSONB DEFAULT '{}'` 컬럼 추가 (nullable)
- 기존 프로그램은 빈 팩 · 편집자가 채우기 전에는 기본 프롬프트로 fallback
- 신규 프로그램 · 등록 직후 autofill 로 초안 자동 생성

## Server (apps/server/src/index.ts)

### 라우트 추가

```ts
// 프로그램 프로파일 편집
PATCH /api/programs/:id/prompt-pack
  body: { naming_convention?, aliases?, glossary?, narrative_hooks?, analysis_rules? }
  → 200 { prompt_pack }

// 자동 채움 (기존 autofill 확장)
POST /api/programs/:id/autofill
  → 기존: title/description/cast 자동 생성
  → 추가: prompt_pack 초안도 함께 생성 (Gemini + google_search grounding)
```

### 파이프라인 통합 (content-pipeline.ts)

```ts
// content.analyze 잡 시작 시
const program = await db.getProgram(episode.programId);
const promptPack = program.prompt_pack || {};
env["STEPD_PROMPT_PACK"] = JSON.stringify(promptPack);
// python subprocess 는 env 에서 읽음
```

## Core (Python)

### 로더

`core/prompt_pack.py` (신규):

```python
def load_prompt_pack() -> dict:
    """env STEPD_PROMPT_PACK 에서 JSON 로드 · 빈 팩이면 {} 반환."""
    raw = os.environ.get("STEPD_PROMPT_PACK") or "{}"
    try:
        return json.loads(raw)
    except Exception:
        return {}

def render_block(pack: dict) -> str:
    """프롬프트 삽입용 텍스트 블록 조립. 프로그램 특화 정보가 없으면 빈 문자열."""
    if not pack:
        return ""
    lines = ["=== 이 프로그램 도메인 규칙 ==="]
    if pack.get("naming_convention"):
        lines.append(f"명칭: {pack['naming_convention']}")
    aliases = pack.get("aliases") or {}
    if aliases:
        male = ", ".join(aliases.get("male") or [])
        female = ", ".join(aliases.get("female") or [])
        if male: lines.append(f"남 가명: {male}")
        if female: lines.append(f"여 가명: {female}")
    gloss = pack.get("glossary") or []
    if gloss:
        lines.append("용어:")
        for g in gloss[:20]:
            lines.append(f"  - {g.get('term')}: {g.get('definition','')}")
    hooks = pack.get("narrative_hooks") or []
    if hooks:
        lines.append("서사 훅:")
        for h in hooks[:10]:
            lines.append(f"  - {h}")
    if pack.get("analysis_rules"):
        lines.append(f"자유 지시: {pack['analysis_rules']}")
    lines.append("=== 위 규칙 반드시 반영해서 결과 생성 ===")
    return "\n".join(lines)
```

### 각 스테이지 프롬프트 삽입

- `core/chyron_scan.py::PROMPT` 조립 시 `render_block(pack)` 를 앞부분에 추가
- `core/narrative.py` · `core/beat_annot.py` · `core/recommend.py` · `core/refine.py` 등 프롬프트 있는 곳 모두 같은 방식
- 프로그램팩 없으면 기존 프롬프트 그대로 · 있으면 도메인 블록이 앞에 붙음

## Web (apps/web)

### 페이지: `/programs/[id]` 상세페이지에 "분석 프로파일" 탭 추가

컴포넌트:
- `NamingConventionField` — textarea + placeholder 예시
- `AliasesField` — 남/여 두 그룹 · chip 형태 add/remove
- `GlossaryTable` — key-value 2열 · 행 add/remove · sort 자동
- `NarrativeHooksField` — chip list · add
- `AnalysisRulesField` — textarea (긴 자유 지시)
- `[자동 채움]` 버튼 → autofill dialog 재사용 (prompt_pack 초안 포함)
- `[다른 프로그램에서 복사]` — 프로그램 select + prompt_pack 복사

Preset 라이브러리 (선택):
- 자주 쓰는 훅 (예 "인터뷰↔행동 괴리") 를 preset chip 으로 제공 · 클릭 add

## Autofill 확장 (core/autofill_program.py)

기존 · title/description/cast 만 생성 → prompt_pack 필드도 함께.

Gemini 프롬프트 확장:
```
프로그램명: "나는 솔로"
1) title/description/cast (기존 유지)
2) prompt_pack:
   - naming_convention (참가자를 어떻게 부르는지)
   - aliases (반복 사용 가명이 있으면)
   - glossary (프로그램만의 용어)
   - narrative_hooks (분석 시 반드시 추적할 관점 3-5개)
   - analysis_rules (자유 지시)
google_search grounding 활성화 · 공식 소개·팬 위키 참고.
```

## 구현 로드맵

| # | 세션 | 산출물 |
|---|---|---|
| 1 | 이 세션 | 이 문서 (승인 대기) |
| 2 | Core 로더 + 각 스테이지 삽입 | `core/prompt_pack.py` · 4-5 파일 프롬프트 수정 |
| 3 | Server 스키마·라우트 | schema.sql 컬럼 · PATCH 라우트 · autofill 확장 |
| 4 | Web UI | 프로그램 상세 페이지 "분석 프로파일" 탭 |
| 5 | Autofill (Python core) | autofill_program.py 에 prompt_pack 초안 생성 |
| 6 | E2E 스모크 | 나는솔로 회차로 · 프로파일 등록 → 분석 결과 확인 |
| 7 | 배포 | server + web 프로덕션 배포 |

## 유의사항

- 프로그램팩은 도메인 지식 · 함부로 자동 변경 X (편집자만 편집)
- Autofill 은 초안 · 반드시 편집자 승인 후 저장 (자동 저장 X)
- 프롬프트 블록 크기 관리 (glossary·hooks 상한) · 토큰 낭비 방지
- prompt_pack 변경 시 이후 분석부터 적용 · 이전 분석은 재분석해야 반영됨
- 프로덕션 첫 배포 시 · 기존 프로그램 모두 빈 팩 · fallback 은 기존 프롬프트 그대로 (호환)

## 참고

- 기존 관련 자산: `beat-annot-principles` · `cast-registry-primary` · `core/autofill_program.py`
- 이 문서 승인 후 세션 2 부터 구현 착수.
