# STEP D Lab — 실험/검수 admin

코어 파이프라인 결과(STT·정제 자막·장면·프레임)를 브라우저에서 눈으로 확인하는 도구.
파이프라인 실험 → 결과 확인 → 파라미터 조정 루프를 위한 화면.

## 구조 (중요)

본사이트(apps/web)·admin 둘 다 나중에 **Vercel**로 올라가고, 백엔드 **서버는 apps/server 하나**다.
그래서 admin은 **독립 서버가 아니라 프론트엔드**이고, 데이터는 그 하나의 서버가 준다.

```
admin/index.html  (정적 프론트, → 나중에 Vercel)
      │  fetch /api/lab/*
      ▼
apps/server  (하나뿐인 백엔드, Node/Hono)
      │  로컬: repo-root core/ 파일 직접 읽음  ← 지금
      │  운영: 워커 VM이 만든 결과를 DB/GCS에서  ← 나중
      ▼
core/  (파이썬 파이프라인: pipeline_output.json · refined_segments.json · scenes.json · scene_frames/)
```

- `admin/`은 apps/web(프로덕션 프론트)과 분리된 실험용. 같은 하나의 서버를 쓴다.
- 서버 엔드포인트: `GET /api/lab/data` · `/api/lab/frames/:name` · `/api/lab/video` · `/lab`(admin HTML 서빙, 로컬 편의).

## 로컬 실행

```powershell
# 1. 코어 파이프라인 결과 생성 (core/)
#    프로덕션 진입점은 core.analyze 하나 (STT→정제→장면→시각채점→이름자막→쇼츠)
core/.venv310/Scripts/python -m core.analyze core/영상.mp4 --out core   # → analysis.json + scene_frames/

# 2. 서버 띄우기 (하나뿐인 백엔드)
cd apps/server; $env:PORT=4100; pnpm start

# 3. 브라우저
#   http://localhost:4100/lab
```

⚠️ 단, `/api/lab/data`는 `analysis.json`이 아니라 **단계별 산출물**(`pipeline_output.json` ·
`refined_segments.json` · `scenes.json` · `shorts.json`)을 읽는다. `core.analyze`는 이 파일들을
만들지 않으므로, lab 화면을 새 결과로 갱신하려면 단계별 CLI를 직접 돌린다:

```powershell
core/.venv310/Scripts/python -m core.refine    core/pipeline_output.json   # → refined_segments.json
core/.venv310/Scripts/python -m core.scenes    core/영상.mp4 --transcript core/refined_segments.json  # → scenes.json + scene_frames/
core/.venv310/Scripts/python -m core.vision    core/scenes.json            # scenes.json에 시각점수 in-place
core/.venv310/Scripts/python -m core.names     core/scenes.json            # scenes.json에 이름자막 in-place
core/.venv310/Scripts/python -m core.recommend core/scenes.json            # → shorts.json
```

원시 STT(`pipeline_output.json`)를 만들던 구 `core.pipeline` 모듈은 제거됨 — 현재 `core/`의
`pipeline_output.json`은 보존된 샘플 산출물이다. 전체 파이프라인·스키마는
[docs/reference/core-pipeline-reference.md](../docs/reference/core-pipeline-reference.md) 참고.

## 화면

- **왼쪽**: 영상 플레이어 + 현재 자막
- **장면 탭**: 91개 장면을 프레임 썸네일 그리드로. 각 카드에 시각·길이·대사·무음배지.
  카드 클릭 → 그 장면으로 영상 이동. (무음 장면 = 대사 없이 화면이 핵심인 후보)
- **자막 탭**: 정제/원본 토글, "바뀐 것만" 필터. 타임스탬프 클릭 → 영상 이동.

## 나중에 (Vercel 분리)

admin을 Vercel로 올릴 때:
- `admin/index.html`을 정적 배포(또는 Next로 이관)
- `/api/lab/*` 호출은 apps/web과 동일하게 Vercel rewrite로 그 하나의 서버(Cloud Run)에 프록시
- 서버의 lab 라우트는 로컬 core/ 대신 워커가 적재한 DB/GCS를 읽도록 교체
- 프론트 코드는 그대로 (`/api/lab/*` 상대경로 유지)
