# narrative-first 쇼츠 추천 (재설계 명세)

작성: 2026-07-23 · 상태: **명세 검토 대기** · 승인 후 구현

## 문제 (현재 방식의 한계)

현재는 **bottom-up 스캔·픽·컷·리타이틀** 4단계:
1. 청크(5분) 병렬 스캔 → 후보 뽑기 (Phase 1)
2. 전역 후보 합성 → N개 선별 (Phase 2)
3. `validate_shorts` — 경계 스냅, 앞뒤 확장
4. 재제목 패스 — 최종 창 안 자막만 보고 title 재생성

이 방식에서 반복 관찰된 이슈:

| 이슈 | 원인 |
|---|---|
| **제목-내용 불일치** (환승연애 #1) | 재제목이 창 안 자막만 보고 title 붙임 → 창이 이상해도 그럴싸하게 붙음 (문제 mask) |
| **setup 놓침** (반응만 잡음) | Phase 1이 payoff 편향 · 앞쪽 확장 로직 늦게 추가 (beat_setup) |
| **겹치는 후보** (환승연애 #1/#2 7.5s 겹침) | 후보 병합 룰 없음 |
| **모델 편향** | "쇼츠 후보를 찾아라" 지시가 리액션 순간을 잡게 만듦 |

## 새 방식 (top-down · narrative-first)

**핵심 아이디어**: 편집자가 실제로 하는 순서.
1. 먼저 **회차 전체 서사를 파악**
2. **이 회차의 하이라이트 스토리 N개**를 정의 ("은규 한의사 반전", "지연 정체 공개"...)
3. 각 스토리마다 **setup → payoff → closure**를 어디부터 어디까지 담을지 결정
4. 그 시간 구간 그대로 컷

파이프라인 위치 (기존과 동일):
```
… → narrative(회차 서사 요약) → shorts_recommend(NEW) → 배포
```

`narrative` 스테이지는 이미 5분 블록별 title/summary/key_moments를 생성하고 있음 — 그 결과를 primary input으로 사용.

---

## 함수 시그니처

### Step 1 · build_shorts_plan (핵심 Gemini 콜 · 1회)

```python
def build_shorts_plan(
    client,
    narrative: dict,          # narrative.full_summary + segments + key_conflicts + characters
    transcript: list[dict],   # refined 세그먼트 (start, end, text, speaker) — 샘플링
    profile: dict | None,     # 프로그램 이해 프로파일 (hookWeights, watchPoints, taboos, examples)
    genre: str,               # 자동 감지된 장르
    n: int,                   # 뽑을 쇼츠 수
    cast_registry: list[dict] | None,  # 등록 출연자 명단 (이름 정규화)
    faces_summary: dict | None,        # faces.clusters 요약 (익명 M1/F1 통계)
    ppl_summary: dict | None,          # ppl.brand_summary (구간별 브랜드 등장)
) -> list[dict]:
```

프롬프트 컨텍스트:
1. 장르팩 · 프로파일 (`hookWeights`, `watchPoints`, `taboos`, `examples`, `visualProfile`)
2. 등록 출연자 명단
3. **full_summary** (에피소드 전체 서사 마크다운)
4. **narrative.segments** (5분 블록별 title/summary/key_moments/characters/tone)
5. **narrative.key_conflicts** (갈등·핵심 사건 with time_range)
6. **faces_summary** (선택 · "화면 등장 인물 개수: M1 1032프레임(주요), M2 442프레임, F2 63프레임..." 형태 — 이름 매핑 있으면 실명)
7. **ppl_summary** (선택 · "브랜드 등장: 삼성 5회, 나이키 2회...")
8. **transcript 균등 샘플** (전체 이해용, 1500줄 상한)

시스템 프롬프트 요지 (초안):
```
너는 <장르> 방송 쇼츠 편집자다. 방금 이 회차 전체 서사와 자막을 읽었다.
편집자 관점에서, 이 회차에서 **독립적인 하이라이트 스토리 N개**를 정의하라.

각 스토리:
1. 완결된 서사 단위여야 한다 (setup → payoff → closure).
2. 30~60초 안에 담길 수 있어야 한다.
3. 스토리들끼리 시간·주제가 겹치지 않아야 한다.
4. 시청자가 클릭할 훅과 왜 봐야 하는지 근거가 있어야 한다.

각 스토리 필드:
- story_title: 이 쇼츠의 제목 (12~30자 · 클릭 유도 · 스포일러/오해 없이)
- story_synopsis: 무슨 이야기인지 2~3문장
- setup_start_sec: 스토리 시작 (setup) 초 단위 · 실제 자막 시각 기반
- payoff_moment_sec: 클라이맥스 초 단위
- payoff_end_sec: 스토리 완결 초 단위 (여운 포함)
- characters: 이 스토리의 주역 인물 이름 (등록 명단만)
- hook: 반전/감정고조/돌직구/질문/정보성/웃음/갈등/공감/기타
- hook_strength, payoff, completeness (각 0-10, 서로 독립)
- reason: 왜 이게 쇼츠로 터질지 한 문장
```

출력 (JSON array of N stories).

### Step 2 · refine_boundaries (룰 기반 · Gemini 없음)

```python
def refine_boundaries(
    stories: list[dict],
    transcript: list[dict],
    scenes: list[dict],
    duration: float,
) -> list[dict]:
```

각 스토리에 대해:
1. `setup_start_sec` → 발화·문장 종결어미 경계로 정렬 (뒤로 or 앞으로 최소 이동)
2. `payoff_end_sec` → 종결어미 스냅 (뒤로 최대 8초 · 문장 완결)
3. 총 길이 30~60초 창 검사:
   - 60초 초과: `payoff_moment_sec` 기준으로 trim (앞뒤 유예 남기고 60초 안에)
   - 30초 미만: `payoff_moment_sec` 기준 앞뒤 확장 (2:1 setup:closure)
4. 중복 검사: 다른 스토리와 시간 겹치면 병합 or 뒷 것 삭제

### Step 3 · 반환 (기존 shorts.json 스키마)

```json
{
  "genre": "talk",
  "shorts": [
    {
      "rank": 1,
      "start": 101.0, "end": 164.0,
      "title": "은규 한의사 반전에 참가자들 술렁",
      "reason": "예상 밖 직업 공개에 참가자들이 놀라며 관점 뒤집힘",
      "hook_strength": 8, "payoff": 8, "completeness": 8,
      "appeal": 5, "score100": 80.0,
      "hook": "반전",
      "tags": ["반전", "직업공개"],
      "characters": ["은규"],
      "story_synopsis": "...",
      "final_score": ..., "program_fit": ...,
      "channel_scores": {...}
    }, ...
  ],
  "mode": "narrative_first"
}
```

기존 스키마와 호환 (UI 손댈 필요 없음).

---

## Gemini 콜 수·비용 변화

108분 청문회 기준:

| 항목 | 지금 (chunk_scan) | 새 (narrative_first) |
|---|---|---|
| Phase 1 (청크 병렬) | ~13콜 | 0 |
| Phase 2 (합성) | 1콜 | 0 |
| 재제목 패스 | 1콜 | 0 |
| build_shorts_plan | — | **1콜** |
| **합계** | **~15콜** | **1콜** |

Phase 1이 프롬프트 크지만 청크당이므로 총 토큰 대비:
- 지금: 청크별 대사 + narrative + conflicts + ppl + 시스템 → 청크당 ~4K 토큰 × 13 = **~52K 입력**
- 새 방식: full_summary + segments + key_conflicts + transcript 샘플 + 시스템 → **~30K 입력** (한 번, 겹침 제거)

**Gemini 입력 토큰 40%+ 절감** · **콜 수 93% 감소**.

---

## 문제 해결 매핑

| 지금 문제 | 새 방식이 해결하는 방식 |
|---|---|
| 제목-내용 불일치 | `story_title`이 정의 단계에서 생성 · 컷은 그 story를 그대로 담음 · 재제목 불필요 |
| setup 놓침 | `setup_start_sec`을 스토리 정의에 필수 · payoff만 잡히지 않음 |
| 겹침 | 스토리 정의 자체가 unique · 정의 단계에서 시간 중복 지시로 방지 |
| Phase 1 payoff 편향 | "완결된 스토리" 지시가 완결 강제 · full_summary + key_conflicts 함께 봄 |

## 새 방식의 리스크

| 리스크 | 대응 |
|---|---|
| narrative 품질에 shorts 종속 | narrative 이미 4콜(full+segments+chars+conflicts) 병렬화됨 · 안정적 |
| narrative가 놓친 하이라이트는 shorts에도 없음 | full_summary+segments+conflicts 통합으로 커버 · 필요 시 transcript 샘플 확대 |
| 처음 튜닝 필요 | chunk_scan 모드와 feature flag로 병존해 A/B |
| 30~60초 창 안 맞는 스토리 | refine_boundaries에서 trim/extend · 실패 시 chunk_scan 폴백 |

## cast_people C3 처리

현재 recommend에 넣은 `cast_people` 컨텍스트 = 항상 no-op (cast.people = 항상 0건).

두 가지 옵션:
1. **삭제**: recommend에서 `cast_people` 매개변수·`_cast_timeline_context_for_range` 제거 (약 30줄)
2. **faces로 교체**: `faces.json.clusters` + `mapping`을 요약해 "이 구간 M1 3분, F2 1분 등장" 형태로 컨텍스트 주입 — 익명 인물 정보도 편집 판단에 도움

**결정 필요**. narrative_first에서도 마찬가지 (faces_summary 사용 여부).

---

## 마이그레이션 계획

### Phase A — 병존 (feature flag)

```python
# analyze.py
mode = os.environ.get("RECOMMEND_MODE") or "chunk_scan"  # 또는 "narrative_first"
if mode == "narrative_first":
    rec = recommend_narrative_first(...)
else:
    rec = recommend(...)  # 기존
```

RECOMMEND_VER 로 캐시 무효화. shorts.json에 `mode` 필드 추가.

**첫 배포**: 8건 재분석 · chunk_scan vs narrative_first A/B diff (`docs/research/narrative-first-ab.md`).

### Phase B — 정착

A/B 결과 확인 후:
- narrative_first가 명확히 낫다면 default 전환 · chunk_scan 유지 (폴백)
- 혼재라면 장르별로 분기 (talk: narrative_first, sports: chunk_scan 등)

### Phase C — 정리

- 결정 후 안 쓰는 경로 삭제
- cast_people C3 삭제 (얼굴 클러스터 도입 여부 결정)

---

## 승인 요청 항목

1. **설계 흐름 OK?** (build_shorts_plan → refine_boundaries → 반환)
2. **프롬프트 필드 OK?** (setup_start_sec / payoff_moment_sec / payoff_end_sec 3점 방식)
3. **cast_people 처리** — 삭제 vs faces로 교체
4. **A/B 병존** vs **바로 대체**
5. **RECOMMEND_MODE env vs 다른 스위칭 메커니즘**

승인 시 다음 순서로 구현:
1. `recommend_narrative_first()` 함수 (recommend.py에 추가)
2. `analyze.py`에서 mode 분기
3. cast_people 처리 (삭제 or faces 요약 추가)
4. RECOMMEND_VER 갱신
5. 재분석 → A/B diff 리포트
