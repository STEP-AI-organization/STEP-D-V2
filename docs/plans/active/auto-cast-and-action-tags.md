# 자동 cast 발견 + action 태그 · 자연어 검색 강화

2026-08-06. 목표는 검색 쿼리 `"환승연애 23기 영철 스킨십"` 수준을 사람 개입 최소로 지원.
지금 실측 (`m_981d7c08`, 32분 회차) 에서 `characters: ["발화자 6"]` 으로만 잡히는 이유 = cast_registry 미등록 · chyron 스킵.

---

## Part 1 · 자동 cast 발견 (사람 개입 최소)

### 4단 결합

1. **chyron 을 registry 없이 먼저 돌림 (수집 모드)** — 현재 `chyron_scan.py::map_speakers_from_chyron`
   이 `registry=None` 이면 감지된 모든 이름을 후보로 반환. Levenshtein 편집거리 ≤1 유사 병합도
   이미 있음. 첫 회차에서 "화면에 뜬 이름들" 자동 수집.
2. **크로스-회차 확정** — 같은 `programId` 의 회차 **3개 이상**에서 반복 등장한 이름 =
   **자동 확정 cast** (정규 출연진). 1~2회만 뜬 이름 = 게스트 후보로 flag.
   이 규칙 하나로 정규진과 1회성 게스트가 자동 분리됨.
3. **Web grounding 검증** — `core/autofill_program.py` (Gemini + google_search) 재사용. 후보 이름 리스트
   + 프로그램 제목을 넘겨 "실제 이 프로그램 출연진인지" 크로스체크 (위키·나무위키·포털). 오탐
   (스태프 이름·자막 오식·프로그램 제목 조각) 걸러냄.
4. **STT + 얼굴 클러스터로 강화** — 대사 중 호칭 (`영철아`, `영철 씨`, `영철이`) 을 파싱해서
   후보 추가. 얼굴 클러스터가 같은데 chyron 이 다른 이름을 부여했으면 conflict flag → 사람 검수 큐.

### 결과 기대치

- **정규 프로그램**: 회차 **3~5개 지나면 registry 90%+ 자동 완성**. 사람은 flagged 것만 검수.
- **신규 게스트**: 다음 회차에서 자동 후보로 뜸.
- **완전 신규 프로그램** (첫 회차뿐): 크로스-회차 신호 X → (3) grounding 만으로 확정.
  검증 실패시 사람 검수 큐.

### 함정 · 한계

- chyron 이 안 뜨는 콘텐츠 (드라마 정극·시사·다큐) 는 이 스택이 약함. → IMDB/왓챠피디아
  크롤이 primary, chyron 은 조연/엑스트라 보조용.
- 동명이인 (같은 프로그램 안 두 명이 같은 이름) — 얼굴 클러스터로 구분 (`영철A`, `영철B`).
- 애칭/본명 혼용 (`재석`·`유재석`·`유놀이`) — canonicalize 매핑 테이블이 필요. 초기엔 사람
  검수 후 저장, 이후 자동.

### 배선 순서

1. chyron 배치화 (Fix 2 · `chyron-per-seg-hardening.md`) — 비용/시간 낮춤. 전제.
2. `analyze.py` 완료 후 자동으로 `cast_registry` 후보 다이제스트 생성 → DB `program_cast_candidates`
   테이블에 upsert (name, count, last_episode_id, needs_review).
3. 회차 3개 이상 반복 시 자동으로 `program.cast` 에 promote.
4. Web UI · 프로그램 상세페이지에 "후보" 섹션 (지금은 "확정"만) · 사람이 원클릭 승인/거절.

---

## Part 2 · action 태그 · multi-label

### 왜 multi-label

한 세그가 여러 상황 겹침 (예: "웃으면서 스킨십하며 이동"). 단일 태그로 잡으면 recall 망가짐.
`["웃음", "스킨십", "이동"]` 처럼 배열로.

### 스키마

- `search_segments.action_tags TEXT[]` + **GIN index** (Postgres array 검색 O(log n)).
- 쿼리 파서: `"영철 스킨십 웃음"` → `characters @> ARRAY['영철'] AND action_tags && ARRAY['스킨십','웃음']`

### Vocabulary (고정 · 예능 기준 30~50개)

자유 태그는 오탐 폭발 (`웃음`·`빵터짐`·`ㅋㅋ` 다 다르게 잡힘). Vocabulary 고정 필수.
카테고리별:

- **감정계**: `웃음` · `분노` · `울음` · `경악` · `설렘` · `감동` · `민망`
- **인터랙션계**: `스킨십` · `포옹` · `시비` · `고백` · `거절` · `키스` · `말다툼`
- **활동계**: `먹방` · `이동` · `운동` · `게임` · `요리` · `쇼핑` · `여행`
- **발화계**: `폭로` · `인용` · `직업공개` · `반전` · `질문` · `농담` · `자기소개`
- **소품/장면계**: `선물` · `데이트` · `파티` · `이벤트` · `축하`

Vocabulary 는 md 파일로 관리 (`core/action_vocab.md`), 프로덕션은 DB kv 로. 편집자가 UI 로
편집 가능.

### 어떻게 붙이나

- **chyron per-seg 배치 콜에 함께 붙임** (추가 콜 0 · 프롬프트만 확장).
  ```
  각 프레임에 대해:
  - name: 이름 태그
  - action_tags: 아래 vocabulary 중 해당하는 것 (여러 개 가능, 없으면 [])
  ```
- Vision + 세그 STT 텍스트를 결합 프롬프트에 · Gemini flash 로 충분.

### 부수 이점

- 프로그램 단위 태그 stats = "이 프로그램에서 자주 나오는 상황" 프로파일. 컨텐츠 기획·
  광고주 매칭·CTR 예측 특성으로도 재활용.
- 검색뿐 아니라 **shorts 추천 필터** 로도 씀 (`웃음+반전` 위주로 뽑기).

---

## Part 3 · 검색 파서 확장

지금 `apps/server/src/search-parse.ts` 가 characters 만 파싱. 다음을 슬롯화:

- `season` / `episode` — `"23기"`, `"5화"` → 정수
- `characters` — 이미 있음 · 자동 cast 로 registry 풍부해지면 recall 상승
- `action_tags` — vocabulary 매칭
- `semantic` — 나머지 자연어 → 벡터 검색

프로그램 메타에 `season` 필드가 필요 → 프로그램 등록/autofill 확장.

### 결과 SQL 대략

```sql
SELECT * FROM search_segments
WHERE program_id = 'p_xxx'
  AND episode = 5
  AND characters @> ARRAY['영철']
  AND action_tags && ARRAY['스킨십', '웃음']
ORDER BY (1 - (emb_summary <=> query_vec)) DESC
LIMIT 20;
```

---

## 우선순위 · 착수 순서

1. **chyron 배치화 (전제)** — [[chyron-per-seg-hardening]] Fix 2.
2. **action_tags 배선** — chyron 배치 프롬프트에 함께 · 스키마 컬럼 추가 · GIN index.
3. **자동 cast 다이제스트** — analyze 완료 후 후보 upsert · 크로스-회차 확정 로직.
4. **검색 파서 확장** — season/action 슬롯 파싱.
5. **Web UI** — 프로그램 상세 · cast 후보 승인 UI · 검색 필터 chip.

각각 별도 이슈로 쪼갤 것. 이 문서는 큰 그림.

## 관련

- [[chyron-per-seg-hardening]] — chyron 견고화 전제
- [[pipeline-optimization-findings]] — 비용/시간 실측 근거
- `core/chyron_scan.py`, `core/autofill_program.py`, `apps/server/src/search-parse.ts`
