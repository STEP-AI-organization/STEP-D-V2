---
name: cost-check
description: STEP-D 원가·마진 실측 확인 — 60분당 원가, 실측 비중, 회차별 내역, 인프라 고정비. "원가/비용/마진/얼마 드는지/단가" 질문이나 원가를 인용해야 할 때 사용.
---

# 원가 실측 확인

**이 리포는 원가를 네 번 틀렸다.** ₩285·₩994·₩1,510 — 네 번 다 뿌리가 같다:
**안 돈 스테이지를 0 으로 셌거나, 프로덕션이 그걸 켰다고 짐작했다.**
그래서 여기서는 **짐작하지 않는다. 조회한다.**

## 0. 먼저 답부터 (외워도 되는 값 · 2026-09-03)

| | 60분 한 편 | 분당 |
|---|---|---|
| **인프라 뺀 벤더 원가** (Gemini·받아쓰기·임베딩) | **₩668** | ₩11.1 |
| 인프라 포함 (+서버연산 ₩99, 렌더 ₩33) | ₩800 | ₩13.3 |
| 화면 자막 읽기(chyron)까지 켜면 | ₩1,283 | ₩21.4 |

판매가 **₩60/분** (2026-08-25 인하 · 28→150→60) → 마진 ~78%.
정본은 [docs/ops/how-it-works.md](../../../docs/ops/how-it-works.md) §4 **하나뿐**이다.

⚠️ **이 표를 인용하기 전에 §1 로 현재값을 확인할 것.** 구성이 바뀌면 이 표가 먼저 낡는다 —
2026-09-03 에 실제로 그랬다(상수가 flash-lite 전환 전 값에 머물러 원장을 43% 부풀림).

## 1. 지금 원가 조회 — 이게 정답 경로

원가는 이제 **실측**이다. core 가 회차마다 `usage.json`(토큰·받아쓰기 시간 · 재시도분 누적)을
남기고 서버가 그걸 `usage_events.cost_krw` 에 넣는다(`cost_source='measured'`).

**사람이 볼 때** — 어드민 콘솔 `admin.stepd.stepai.kr` → Overview → "사용 원가 · 마진" 패널.
`60분당 원가(실측)` 와 `실측 비중` 카드가 답이다.

**에이전트가 볼 때** — DB 직접 조회. RLS 라 `set_config` 가 **필수**다(안 하면 전부 0건):

```bash
# 1) 프록시 (5433 은 Windows 예약 포트라 15432 를 쓴다)
cloud-sql-proxy --credentials-file=<경로>/stepd-deployer-key.json \
  step-d:us-central1:stepd-db --port 15432 &

# 2) 조회 — 실측 행만으로 단가를 낸다
psql -h 127.0.0.1 -p 15432 -U postgres -d stepd -At \
  -c "select set_config('app.tenant_id','*',false);" -c "
select cost_source,
       count(*)                                            as 건수,
       round(sum(quantity))                                as 분,
       round(sum(cost_krw))                                as 원가,
       round((sum(cost_krw)/nullif(sum(quantity),0))::numeric, 2) as 분당,
       round((sum(cost_krw)/nullif(sum(quantity),0)*60)::numeric) as 60분당
  from usage_events
 where kind='analyze_minutes' and occurred_at > now() - interval '30 days'
 group by cost_source;"
```

- `cost_source='measured'` 행만 단가로 쓴다. `'estimated'` 는 상수 폴백이라 **섞으면 안 된다.**
- `measured` 가 0 건이면 → 아직 배포 전이거나 `usage.json` 을 못 읽고 있다는 뜻이다.
- NULL 은 2026-09-03 마이그레이션(0052) **이전** 행이다. 소급하지 않았다(모르는 걸 칠하지 않는다).

## 2. "그 편이 왜 비쌌나" — 회차별 내역

```sql
select media_id, quantity as 분, cost_krw,
       cost_detail->>'runs'        as 시도횟수,   -- 2 이상이면 재시도분이 포함된 값이다
       cost_detail->>'geminiKrw'   as gemini,
       cost_detail->>'externalKrw' as 받아쓰기,
       cost_detail->'byModel'      as 모델별
  from usage_events
 where kind='analyze_minutes' and cost_source='measured'
 order by occurred_at desc limit 10;
```

`runs ≥ 2` 면 **버린 재시도까지 합산된 값**이다 — 그게 맞다. 한 편의 진짜 원가는 그것이다.
원본 증빙은 GCS `analysis/{mediaId}/usage.json` 에 그대로 있다.

## 3. 원가를 인용하기 전 체크리스트

1. **실측인가 상수인가** — `cost_source` 를 봤나. 안 봤으면 그 숫자는 상수일 수 있다.
2. **전체 실행인가** — `runs` 가 1 인가. 체크포인트 재개분만 보고 "싸다" 고 하면 틀린다.
3. **어떤 스테이지가 켜져 있나** — 짐작 금지. 프로덕션 잡 env 를 **실제로 조회**한다:
   ```bash
   gcloud run jobs describe stepd-worker-content --region us-central1 \
     --format="value(spec.template.spec.template.spec.containers[0].env)"
   ```
   특히 `RUN_CHYRON_PER_SEG`(기본 0=OFF) · `GEMINI_BEAT_ANNOT_MODEL`(flash-lite) ·
   `RUN_FACES`/`RUN_PPL`(기본 off) · `GEMINI_BATCH`(기본 OFF).
4. **인프라를 섞지 않았나** — 아래 §4.

## 4. 인프라는 별도로 센다 (섞지 말 것)

`usage_events` 의 원가는 **벤더 실비만**이다. Cloud Run·Cloud SQL·GCS·GPU VM 은 회차가 아니라
**시간**에 붙는 고정비라 편당 원가에 섞으면 트래픽에 따라 값이 흔들린다.

정본: [docs/ops/infra.md](../../../docs/ops/infra.md)

- 고정비 ≈ **₩125,000~140,000/월** (Cloud SQL ₩69,800 + `stepd-server` min-instances=1 ₩36,000~55,000 + GEBD 부팅디스크 ₩13,800 …)
- 변동비 = **분당 ₩15.4** (벤더 11.1 + 인프라 4.3)
- **회차 수가 아니라 분으로 곱할 것.** 실측 평균이 17.3분이라 "N건 × 60분 단가" 는 3.5배 부풀려진다.
- 지금 물량(월 ~693분)에서 **총액의 90%가 고정비다** → 줄이는 레버는 파이프라인이 아니라 Cloud SQL·min-instances.

## 5. 알려진 한계 — 물어보면 이렇게 답한다

- **검색 임베딩(~2%)은 원가에 안 잡힌다.** `embed_content` 는 토큰 훅을 안 타서, 단가를
  지어내지 않고 **물량만** 남긴다(`cost_detail->'external'->'vertex-embed'`). 청구서로 소급 검산 가능.
- **분석(`analyze_minutes`)만 원가가 붙는다.** 렌더·배포 잡은 아직 `cost_krw` 를 안 쌓는다.
- **GEBD GPU VM 은 인프라 쪽**이라 편당 원가에 없다(2026-09-03 spot 전환 · 단가는 다음 청구서로 확정).

## 6. 값이 이상할 때

| 증상 | 원인 |
|---|---|
| `measured` 0 건 | 배포 안 됐거나 `usage.json` 못 읽음 → 워커 로그에서 `[usage]` 줄 확인 |
| 단가가 갑자기 2배 | `RUN_CHYRON_PER_SEG=1` 로 켜졌는지 (₩13.3 → ₩21.4) |
| 조회가 전부 0건 | `set_config('app.tenant_id','*')` 를 안 했다 (FORCE RLS) |
| 원가 > 매출 | 매출은 **기간 내 충전액**이라 선불 시점 차이일 뿐일 수 있다 |

## 관련 코드

| 무엇 | 어디 |
|---|---|
| 토큰·벤더 누적 | `core/common/retry.py` (`usage_summary` · `record_external`) |
| 회차 dump·재시도 합산 | `core/analyze_stages.py` (`dump_usage` · `_merge_usage`) |
| 원장 기록 | `apps/server/src/pipeline/content-pipeline.ts` (`readRunCost`) |
| 폴백 상수 | `apps/server/src/billing/billing.ts` (`COST_KRW_PER_MINUTE`) |
| 조회 API | `apps/server/src/index.ts` `GET /api/superadmin/usage` |
| 화면 | `admin/src/views/Overview.tsx` |
