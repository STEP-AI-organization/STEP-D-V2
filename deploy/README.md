# deploy/ — 배포·프로비저닝

**표준 경로는 하나다:**

```bash
bash deploy/cloud.sh <status|server|worker|gebd|migrate|all>
```

비대화형 Bash + deployer 서비스계정으로 돈다. PowerShell 5.1 은 gcloud 의 정상 경고(stderr)만
나와도 실패로 판정해서 배포가 멈춘다 — 그래서 표준을 Bash 로 잡았다.

| 파일 | 무엇 |
|---|---|
| `cloud.sh` | **표준 배포** — 서버·워커 Jobs·GEBD·마이그레이션·상태 |
| `deploy-web.ps1` | 프론트 → Vercel (커밋 author 를 contact@stepai.kr 로 강제) |
| `cloudbuild-worker.yaml` | 워커 이미지 빌드 설정 |
| `gebd/` | GEBD GPU VM — Dockerfile·기동 스크립트·경계 추론 |
| `naver-pc/` | **윈도우2**(네이버 워커 PC) 설치·자가갱신·원격 갱신 |
| `worker-*.sh` · `gebd-vm*.sh` | VM 프로비저닝 보조 |

- 배포 런북: [docs/ops/deploy.md](../docs/ops/deploy.md)
- 윈도우2 갱신: [docs/ops/deploy-win2.md](../docs/ops/deploy-win2.md)
- 인프라 SSOT: [docs/ops/infra.md](../docs/ops/infra.md)

> 구 배포 자산(pm2·Caddy·docker-compose·`deploy-server.ps1`·`deploy-worker.ps1`)은
> **2026-08-12 삭제됐다.** 워커 VM 상시 운영 전제라 현재 배치와 맞지 않았다.
