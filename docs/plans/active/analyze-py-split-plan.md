# core/analyze.py 분할 계획 (미실행)

2026-08-06. `analyze.py` 1019줄 · 함수 7개 (실제로는 `analyze()` 하나에 대부분 몰림).
스테이지 경계는 명확하지만 로컬 변수 공유가 많아 순진하게 쪼개면 폭발.

**지금 실행 안 함.** 이유: 병렬 세션들이 이 파일 자주 건드려서 conflict 위험 · 큰 diff 는 리뷰 불가.
안정된 브랜치에서 별도.

## 목표 구조

```
core/
  analyze.py              (오케스트레이터만 · 300줄 이하 · 스테이지 함수 호출 + 체크포인트/progress/usage)
  stages/
    __init__.py
    stt.py                (Soniox·whisper·hybrid)
    refine.py             (자막 정제 + speaker 후처리)
    chyron.py             (chyron per-seg · 이미 core/chyron_scan.py 있음 · wrapper 만)
    faces.py              (얼굴 클러스터링 · 이미 core/faces.py)
    ppl.py                (PPL 검출)
    scenes.py             (청크 분할)
    narrative.py          (서사 요약)
    boundaries.py         (shot boundary · GEBD 로드 · 이미 core/boundaries.py)
    scene_type.py         (이미 core/scene_type.py)
    beats.py              (이미 core/beats.py + annotate)
    shorts.py             (propose+select)
    search_index.py       (segments 임베딩 · 이미 core/index_segments.py)
```

대부분 이미 별 파일에 있고 · analyze.py 안에서 얇게 감싸는 코드가 몰려있는 상태.

## 분할 규칙

1. **각 스테이지 함수 시그니처 통일**:
   ```python
   def run(ctx: PipelineContext) -> None:
       """스테이지 하나. ctx 에서 필요한 것 읽고 · 결과를 ctx 에 쓰고 · checkpoint 자동."""
   ```
2. **`PipelineContext` 도입** (dataclass):
   - `out_dir`, `video_path`, `media_id`, `program_context`, `genre`, `fast`, `resume`
   - `stt`, `refined`, `faces`, `beats`, `shorts`, `narrative`, ... (스테이지 산출)
   - `_progress` · `step` · `_save_json` · `_load_json` · `checkpoint_ok(name, fingerprint)` 유틸
3. **체크포인트 재사용 로직 표준화** — 지금 각 스테이지마다 `if resume and _existing: reuse; else: run` 반복.
   `ctx.load_or_run(name, fingerprint, fn)` 하나로.
4. **usage 로깅 자동화** — retry.py 는 이미 hook. 스테이지 시작/종료 시 델타만 뽑아 `ctx.usage_by_stage`.
5. **에러 격리** — 스테이지 함수는 raise · 오케스트레이터가 어느 스테이지에서 죽었는지 로그.

## 다음 단계

1. `PipelineContext` 정의 + `load_or_run` 유틸 먼저 (기존 함수 안에서 사용 · 아무것도 안 옮김 · 낮은 리스크).
2. 스테이지 하나씩 별 파일로 이동 (STT → refine → chyron 순서로 · 각 이동 후 실측 재확인).
3. 최종에 `analyze.py` 는 스테이지 리스트를 순회하는 얇은 오케스트레이터만 남김.

## 리스크

- 로컬 변수 공유가 광범위 · ctx 로 옮기는 과정에서 이름 오탈자 시 조용히 다른 값 사용
- 체크포인트 fingerprint 로직이 각 스테이지 특화 · 일반화 시 캐시 무효화 패턴 바뀔 수 있음
- 병렬 세션들이 다른 스테이지 건드리고 있으면 rebase 폭발

## 대안: refactor 안 하고 안 아프게

- 지금처럼 스테이지 경계에 `# ── STAGE N: ... ──` 헤더 주석만 강화 · 접힘·검색 개선
- 진짜 문제 (체크포인트 중복 · usage 로깅 누락) 만 인플레이스 개선
- 파일 길이 자체는 문제 X

**결정 필요**: refactor vs 스탠드.
