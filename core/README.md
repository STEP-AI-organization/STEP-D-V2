# core/ — AI 파이프라인 (Python)

> **이건 워커가 아니다.** 워커는 `apps/server/src/worker.ts`(TypeScript)이고,
> 그 워커가 이 파이프라인을 **자식 프로세스로 띄운다**: `python -m core.analyze`.
> 헷갈리기 쉬운 지점이라 먼저 적는다 — 큐·재시도·진행률은 워커 몫, **영상을 이해하는 일은
> 전부 여기** 몫이다.

```
apps/server (Node)  ──spawn──▶  core/ (Python)  ──▶  Postgres · GCS
   큐 · 재시도 · 진행률              STT · 장면 · beat · 추천 · 검색색인
```

접점은 `apps/server/src/content-pipeline.ts` **하나뿐**이다. 진행률은 stdout 에 `@@PROGRESS`
로 흘려보내고 워커가 파싱한다.

---

## 실행 순서 — 폴더가 곧 단계다

```
analyze.py                     오케스트레이터 (단계별 체크포인트 · 재시도 시 재개)
  │
  ├─ stt/        음성 → 자막      Soniox STT + 화자분리 + 후처리(이름 확정)
  ├─ scenes/     영상 → 장면      shot 경계 · scene_type · GEBD 경계 · 화면자막(chyron)
  ├─ beats/      장면 → beat      최소 6초 단위로 쪼개고 Vision 으로 주석
  ├─ recommend/  beat → 쇼츠 추천  (beat-only · 시청자 신호 반영)
  └─ search/     세그먼트 색인     pgvector 임베딩 + 키워드축
```

| 폴더 | 무엇 | 대표 모듈 |
|---|---|---|
| [`stt/`](stt/) | 음성인식·정제·화자 | `asr` `align` `refine` `speaker_*` `names` |
| [`scenes/`](scenes/) | 장면 경계·유형·화면자막 | `boundaries` `scenes` `scene_type` `shots` `chyron_scan` |
| [`beats/`](beats/) | beat 생성·주석·서사 | `beats` `beat_annot` `narrative` |
| [`recommend/`](recommend/) | 쇼츠 추천·시청자 신호 | `recommend` `signals` `comment_signal` `learn_profile` |
| [`search/`](search/) | 검색 세그먼트 색인·질의 | `index_segments` `embed` `search` |
| [`vision/`](vision/) | 프레임 이해·인물 | `vision` `faces` `portraits` `cast` `ppl` |
| [`thumbnail/`](thumbnail/) | 썸네일 엔진 | `cli` `plan` `simple_gen` `swap` |
| [`evaluate/`](evaluate/) | 품질 평가 배치 | `eval_*` `evaluate` |
| [`common/`](common/) | 공용 — 모델명·재시도·클라이언트 | `models` `retry` `openai_client` `glossary.json` |

**모델 이름은 `common/models.py` 한 곳에서만 바꾼다.** 단계별 오버라이드는 env
(`GEMINI_REFINE_MODEL` 등).

---

## 기본이 off 인 것들 — 지우지 말 것

| 스위치 | 기본 | 왜 |
|---|---|---|
| `RUN_FACES` | off | 되살릴 때만 켠다 |
| `RUN_PPL` | **off** | 과다검출 + 실행시간 절반을 먹었다 (2026-08-06 결정) |
| `RUN_REFINE` · `RUN_CHYRON_PER_SEG` | 상황별 | CLAUDE.md 참고 |

끈 기능의 코드를 삭제하지 않는다 — 근거가 바뀌면 다시 켠다.

---

## 로컬 실행

⚠️ **`apps/server/.env` 를 로드하고 `core/.venv310` 으로 돌려야 한다.** 안 지키면 중간
산출물(`stt.json` 등)이 지워져 STT 를 다시 사는 일이 생긴다(₩270 재지출 실측).

```powershell
core\.venv310\Scripts\python.exe -m core.analyze <mediaId> ...
```

자세히는 [docs/reference/core-pipeline-reference.md](../docs/reference/core-pipeline-reference.md)
· [docs/ops/local-dev.md](../docs/ops/local-dev.md).

---

## import 규칙

패키지 내부도 **절대 경로**를 쓴다 — `from core.common.models import TEXT`.
상대 경로(`from ..models import`)를 쓰면 모듈을 옮길 때마다 깊이가 어긋나 조용히 깨진다
(2026-08-12 재편 때 실제로 그랬다).

⚠️ `__file__` 기준으로 자산을 읽는 코드는 옮길 때 같이 고쳐야 한다
(예: `stt/refine.py` 가 읽는 `common/glossary.json`).
