# scripts/ — 개발·운영 스크립트

> **여기 있는 건 제품 코드가 아니다.** 제품은 `apps/` 와 `core/` 다.
> 배포 스크립트는 여기가 아니라 [`deploy/`](../deploy/) 에 있다.

| 폴더 | 무엇 | 다시 돌릴 일이 있나 |
|---|---|---|
| [`dev/`](dev/) | 로컬에서 결과를 눈으로 확인하는 도구 (렌더·뷰어·프로브) | **있다** — 파이프라인 만질 때 계속 쓴다 |
| [`ops/`](ops/) | 운영·유지보수 1회성 작업 (백필·리셋·수집) | **있다** — 다만 대부분 **파괴적이다. 읽고 실행할 것** |
| [`thumbnail/`](thumbnail/) | 썸네일 엔진 파이프라인 | **있다** — `core/thumbnail/*` 가 직접 호출한다. 옮기면 코드가 깨진다 |
| [`experiments/`](experiments/) | 지난 실험 기록 (exp7~13, STT 정합, 컷 비교 등) | **대체로 없다** — 결론은 `docs/` 에 있다. 재현하려는 게 아니면 볼 일 없다 |

`dev.ps1` (루트) 은 로컬 개발 스택(Postgres + 웹 + 서버)을 띄운다 — [docs/ops/local-dev.md](../docs/ops/local-dev.md).

---

## experiments/ 를 대하는 법

**결론은 코드가 아니라 문서에 있다.** 실험 스크립트는 그때의 데이터·경로·API 키를 전제로
쓰여서, 지금 그대로 돌리면 대부분 실패한다. 그게 정상이다 — 고치지 말고 문서를 봐라.

| 실험 | 결론이 있는 곳 |
|---|---|
| exp7~13 (시청자 신호·제목·리텐션) | [docs/research/](../docs/research/) · [docs/plans/done/](../docs/plans/done/) |
| STT 정합 (`stt_*`) | [docs/plans/done/](../docs/plans/done/) · 확정 스택은 CLAUDE.md |
| 썸네일 소스 실험 | [docs/research/thumbnail-source-experiments.md](../docs/research/thumbnail-source-experiments.md) |

새 실험을 추가할 땐 여기 넣되, **결론은 반드시 `docs/` 에 남긴다.** 스크립트만 남으면
6개월 뒤엔 아무도 그게 뭘 증명했는지 모른다.

---

## ⚠️ ops/ 는 프로덕션에 닿는다

`reset_video_data.py` 처럼 이름이 곧 경고인 것들이 있다. 실행 전에:

1. 그 스크립트가 읽는 `DATABASE_URL` 이 **어느 DB** 인지 확인 (로컬 vs Cloud SQL 프록시)
2. 파일 상단 주석을 읽는다 — 대부분 전제와 되돌리는 법이 적혀 있다
