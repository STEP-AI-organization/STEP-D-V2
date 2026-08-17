# STEP D — 비용 · 의존성 정본

> 작성 2026-08-11. **외부에 돈이 나가는 것과 우리가 남에게 매달려 있는 것**을 한 곳에 모은다.
> 인프라 스펙 자체는 [infra.md](infra.md) 가 정본이고, 여기는 **그 위에 얹히는 돈·의존 관계**다.
>
> ⚠️ 이 문서를 만든 이유: `infra.md`(2026-08-07) 이후 **결제·다회사·네이버·캔바·팩토리**가
> 통째로 들어왔는데 비용 표는 그대로였다. 그리고 아래 §4 에서 확인했듯 **파이프라인 원가가
> 코드 안에서 두 곳에 서로 다른 값으로 박혀 있고, 둘 중 하나는 4.7배 틀렸다.**

> ## 🔴 2026-08-16 정정 — 아래 §4·§6·§7 의 회차 원가는 **여전히 과소계상**이다
>
> 이 문서가 근거로 쓴 `tmp/_analysis/drama-eb5cd1/usage.json`(248콜)은 **체크포인트 재개
> 실행**이라 파이프라인 일부만 담고 있었다. `analysis.json` 의 `stage_sec` 을 보면
> stt·refine·narrative·shots·scene_type 이 전부 0.0초이고, 248 = beat_annot 227 +
> propose 1 + 쇼츠 QA 20 으로 정확히 떨어진다.
>
> **빠진 최대 항목은 chyron(화면 자막 읽기)** — STT 세그먼트마다 Gemini Vision 1콜이라
> 60분 회차에 약 800콜, **회차 Gemini 콜의 75%** 다.
>
> | | 이 문서(§4) | 정정 |
> |---|---|---|
> | 60분 회차 원가 | ₩994 (분당 17.0) | **₩1,510 (분당 25.2)** |
> | 마진 (판매 ₩28/분) | 36% | **7%** |
> | 손익분기 | 월 88편 | **월 470편** |
>
> **회차 원가·마진 인용은 [how-it-works.md](how-it-works.md) §4 에서만 할 것.**
> 이 문서는 **단가표(§3)와 의존성 인벤토리(§2)** 가 정본이고, 그 둘은 유효하다.
> §10 의 조치 두 개(retry.py 단가표 · billing.ts 상수)는 2026-08-16 에 적용 완료.

### 결론 세 줄 (2026-08-11 시점 · 위 정정 참고)

1. **회차당 실원가는 ₩285 가 아니라 ₩994 다** (58.6분 기준 · usage.json 실측 토큰 재계산). `core/retry.py` 단가표가 Gemini 2.0 Flash 가격을 2.5 Flash 라벨에 붙여 놓아 **4.7배 과소계상** 중. ← ⚠️ 이 ₩994 도 chyron 누락으로 과소계상(위 정정)
2. **크레딧 ₩28/분은 우연히 옳다** — 실측 원가 ₩17.0/분, PG 수수료 후 마진 36%. 다만 **GEBD·썸네일을 크레딧에 포함하면 즉시 역마진**이다. ← ⚠️ 정정 후 마진은 7%
3. **손익분기는 월 88회차.** 그 아래는 고정비 ₩56,600 을 못 덮는다. 가장 큰 레버는 **Gemini Batch 모드(-50%)** — 단독으로 손익분기를 50회차 아래로 내린다. ← ⚠️ 정정 후 470편

## 0. 갱신 규칙

- **단가가 바뀌면 §3 만 고친다.** §4~§7 은 §3 을 참조하는 계산이다.
- **새 외부 API 를 붙이면 §2 표에 줄을 추가한다.** 줄을 안 추가하면 그건 아무도 모르는 지출이다.
- 환율은 **₩1,416/USD** (2026-08-11 Wise 중간환율) 기준. 환율 칸을 따로 두지 않고 원화만 적되,
  달러 원가를 같이 병기해 재환산이 가능하게 한다.

---

## 1. 한눈에 — 지금 돈이 나가는 곳

```
                    ┌──────────────── 회차마다 나감 (변동비) ────────────────┐
업로드 ─┬─ Soniox STT          $0.10/시간          ← 유일한 STT 유료 경로
        ├─ Vertex Gemini       토큰 종량           ← 회차 원가의 최대 항목
        ├─ Vertex 임베딩       $0.025/1M 토큰      ← 사실상 0
        ├─ Cloud Run Job       4vCPU·8Gi × 실행시간
        └─ (옵션) GEBD GPU VM  L4 $0.868/시간 × ~18분
                    │
              (사람이 채택)
                    │
        ├─ (옵션) OpenAI gpt-image-2   장당 $0.041~0.165   ← 자동 OFF
        ├─ Canva Connect API           API 무료 · Pro 구독 필요
        └─ 배포: YouTube API(무료·쿼터) / 네이버(사무실 PC) / Meta·TikTok(스텁)

                    ┌──────────────── 매달 나감 (고정비) ────────────────┐
        Cloud SQL db-g1-small · GEBD VM 부팅디스크 · AR 이미지 · GCS · Vercel
                    │
                    └─ 매출 발생 시: KG이니시스 카드수수료 3.20%
```

**돈이 안 나가는데 의존은 하는 것**(끊기면 기능이 죽는다): YouTube Data/Analytics API(쿼터),
네이버 로그인 세션(사무실 PC), Hugging Face(pyannote 화자분리 가중치), yt-dlp(연구용).

---

## 2. 외부 의존성 전수 인벤토리

**과금** 칸: 💰=쓴 만큼 청구 · 🔒=구독/계약 · 🆓=무료(쿼터·한도 있음) · —=미사용

| # | 서비스 | 쓰는 곳 (코드) | 인증 | 과금 | 끊기면 생기는 일 | 폴백 | 락인 |
|---|---|---|---|---|---|---|---|
| 1 | **Vertex AI Gemini** | `core/models.py` 경유 17개 스테이지 전부 | ADC / SA | 💰 | **파이프라인 전멸.** refine 은 전부 실패 시 예외로 죽음(설계) | 없음 | **높음** |
| 2 | **Vertex 임베딩** `text-multilingual-embedding-002` | `core/index_segments.py`(문서축) · `apps/server/src/search-embed.ts`(쿼리축) | ADC / SA | 💰 | 의미검색 소실 | ✅ **pg_trgm 키워드축 단독** | 낮음 |
| 3 | **Soniox STT** | `core/asr.py` (`STT_PROVIDER=soniox`) | `SONIOX_API_KEY` | 💰 | 클라우드 STT 불가 → 파이프라인 0단계에서 정지 | ⚠️ whisper/hybrid 는 **CUDA 필요** — Cloud Run Job 엔 GPU 없음 | **높음** |
| 4 | **OpenAI Images** `gpt-image-2` | `core/openai_client.py` → `thumbnail/image_gen.py`·`nano_banana.py` | `OPENAI_API_KEY` | 💰 | 썸네일 생성 불가 | 없음 (원본 프레임 사용) | 중간 |
| 5 | **GCP Cloud Run (서비스)** | `stepd-server` | SA | 💰 | 제품 전체 정지 | 없음 | 중간 |
| 6 | **GCP Cloud Run Jobs** | `stepd-worker-content` · `stepd-worker-youtube` | SA | 💰 | 잡이 큐에 쌓이기만 함 | 로컬 pm2 워커 | 중간 |
| 7 | **GCP Cloud SQL** (PG16) | 전부 | 소켓/프록시 | 💰🔒 | **전체 정지** | 없음 | **높음** |
| 8 | **GCS** `stepd-media` | 원본·클립·프레임·분석 산출물 | SA | 💰 | 업로드/스트리밍 정지 | `STEPD_STORAGE_DIR` 로컬 | 중간 |
| 9 | **GCE GPU VM** (L4) | `gebd.detect` — 장면경계 모델 | SA | 💰 | 경계 품질 저하 | ✅ **ffmpeg shots + STT gap 폴백** | 낮음 |
| 10 | **Cloud Scheduler** | 워커 Job 15분 기동 | — | 🆓 (3개까지) | 잡이 안 깨어남 | 수동 `:run` | 낮음 |
| 11 | **Artifact Registry** | 서버·워커·GEBD 이미지 | SA | 💰 | 배포 불가 | — | 낮음 |
| 12 | **Vercel** | `apps/web` · `admin/` | Git | 🔒 | 프론트 정지 | — | 중간 |
| 13 | **YouTube Data API v3** | `apps/server/src/youtube.ts` — 채널·영상·댓글·업로드 | OAuth | 🆓 쿼터 | 채널 동기화·실업로드 정지 | 없음 | **높음** |
| 14 | **YouTube Analytics API** | 성과·수익 지표 | OAuth(+monetary 스코프) | 🆓 쿼터 | 성과 트래킹 정지 | 없음 | **높음** |
| 15 | **PortOne + KG이니시스** | `src/portone.ts`·`billing.ts`·`credits.ts` | 4종 시크릿 | 💰 **3.20%** | **결제 불가 → 크레딧 충전 불가** | 없음(설정 없으면 결제창 자체를 안 염) | **높음** |
| 16 | **Canva Connect API** | `src/canva.ts` — 쇼츠 오버레이 템플릿 PNG export | OAuth(PKCE) · 단일 계정 | 🆓 API / 🔒 **Pro 구독** | 템플릿 갱신 불가 (기존 PNG 는 남음) | ⚠️ 무료플랜이면 투명배경 거부 → 마젠타 colorkey 우회 필요 | 중간 |
| 17 | **네이버 TV / 클립** | `src/naver-tv.ts` + Playwright | **로그인 세션 파일** | 🆓 | 네이버 배포 정지 | 없음 | **매우 높음** |
| 18 | **Meta Graph API** | OAuth 연결만 | `META_APP_*` | 🆓 | — | — | — |
| 19 | **TikTok API** | OAuth 연결만 | `TIKTOK_*` | 🆓 | — | — | — |
| 20 | **Hugging Face** (pyannote 3.1) | `core/asr.py` 화자분리 (whisper/hybrid 경로) | `HF_TOKEN` | 🆓 | speaker 필드가 빈 채로 나감 | ✅ 조용히 비움 | 낮음 |
| 21 | **yt-dlp** | `youtube.download` · `match.*` (연구용) | 쿠키(선택) | 🆓 | 연구 데이터셋 수집 정지 | — | 낮음 (제품 경로 아님) |
| 22 | **remove.bg** | `.env.example` 에 `REMOVEBG_API_KEY` 선언 | — | ❓ | **배선 미확인** | 로컬 배경제거 | — |

### 2-1. 주의해서 봐야 할 줄

- **#3 Soniox 는 대체재가 사실상 없다.** `whisper`/`hybrid` 는 CUDA 를 요구하는데 `stepd-worker-content`
  Job 에는 GPU 가 없다. Soniox 가 죽으면 **클라우드에서 분석이 아예 시작되지 않는다.**
  ⚠️ 코드 기본값은 `gemini`(오디오 전사)라, `STT_PROVIDER` 를 안 넣으면 지문이 어긋나
  비싼 체크포인트가 무효화된다 — 이 사고는 이미 한 번 났다(`pipeline-current-state.md` §8).
- **#17 네이버가 구조적으로 제일 약하다.** 공개 업로드 API 가 없어 Playwright 자동화이고,
  해외 IP 로는 캡차에 막혀 **사무실 상시 PC 한 대**가 단일 장애점이다. 세션 쿠키도 그 PC 로컬에만 있다.
  PC 가 꺼지거나 네이버가 로그인 UI 를 바꾸면 그 레인은 통째로 멈춘다.
- **#15 결제는 없으면 매출이 0 이다.** `portoneConfigured()` 가 4종 env 중 하나라도 비면
  결제 경로를 아예 안 연다(의도된 설계). 시크릿 4개가 곧 매출 스위치다.
- **#16 캔바는 계정 등급에 기능이 물려 있다.** Pro 라서 `transparent_background:true` 가 되는
  것이지 API 스펙이 아니다. 계정 다운그레이드 = 렌더 파이프라인 우회 작업.
- **#22 remove.bg 는 `.env.example` 에만 있다.** 부분 검색에서 `REMOVEBG_API_KEY` 를 읽는
  코드를 찾지 못했다(전수 확인 미완). 실제로 안 쓰면 `.env.example` 에서 지우고, 쓰면
  이 표에 단가를 채울 것. **확인 명령:** `grep -ri removebg core apps --include=*.py --include=*.ts`

---

## 3. 단가표 (2026-08-11 공시가)

### 3-1. AI / STT

| 서비스 | 단위 | USD | 원화(₩1,416/USD) | 비고 |
|---|---|---|---|---|
| Gemini 2.5 Flash | 1M 입력 토큰 | $0.30 | **₩425** | 현행 기본 모델 (`core/models.py`) |
| Gemini 2.5 Flash | 1M 출력 토큰 | $2.50 | **₩3,540** | |
| Gemini 2.5 Flash | 1M 캐시 입력 | $0.03 | **₩42** | 표준가의 10% |
| Gemini 2.5 Flash-Lite | 1M 입/출력 | $0.10 / $0.40 | ₩142 / ₩566 | |
| Gemini 2.5 Pro | 1M 입/출력 | $1.25 / $10.00 | ₩1,770 / ₩14,160 | |
| Gemini 3 Flash Preview | 1M 입/출력 | $0.50 / $3.00 | ₩708 / ₩4,248 | |
| Gemini 3.1 Flash-Lite | 1M 입/출력 | $0.25 / $1.50 | ₩354 / ₩2,124 | |
| Gemini 3.5 Flash | 1M 입/출력 | $1.50 / $9.00 | ₩2,124 / ₩12,744 | |
| Vertex `text-multilingual-embedding-002` | 1M 토큰 | $0.025 | **₩35** | |
| Soniox STT (async) | 1시간 | $0.10 | **₩142** | **화자분리·언어식별·포맷팅 포함** |
| Soniox STT (realtime) | 1시간 | $0.12 | ₩170 | 미사용 |
| OpenAI `gpt-image-2` | 1장 (medium·비정사각) | $0.041 | **₩58** | 16:9·9:16 은 정사각보다 쌈 |
| OpenAI `gpt-image-2` | 1장 (high·비정사각) | $0.165 | ₩234 | |
| Batch/Flex 모드 | — | 표준가 **-50%** | | ⚠️ 현재 미사용 — §10 참조 |

> ⚠️ **`.env.example` 의 `GEMINI_MODEL=gemini-3.1-flash` 는 공시 목록에 없는 이름이다.**
> 존재하는 3.x 계열은 `3 Flash Preview` · `3.1 Flash-Lite` · `3.5 Flash` · `3.6 Flash` · `3.1 Pro Preview` 다.
> 주석대로 프로덕션에 넣으면 모델을 못 찾고 죽거나, 붙더라도 **3.5 Flash 는 2.5 Flash 의 5배**다.
> 코드 기본값(`core/models.py` = `gemini-2.5-flash`)과 `.env.example` 주석이 **어긋나 있다.**

### 3-2. GCP 인프라 (infra.md §월비용 · Billing API 직접 조회 2026-08-07)

| 항목 | 단가 |
|---|---|
| L4 GPU | $0.560040/시간 |
| G2 코어 | $0.026238/시간 |
| T4 GPU | $0.350000/시간 |
| Cloud SQL vCPU / RAM | $0.041300/시간 · $0.007000/GiB·시간 |
| Balanced PD | $0.100000/GiB·월 |

### 3-3. 결제

| 항목 | 요율 | 비고 |
|---|---|---|
| KG이니시스 신용카드 (일반결제) | **3.20%** | 가입비 무료 |
| 포트원 중계 수수료 | 별도 고지 | 헬프센터 요금 페이지 확인 필요 |

---

## 4. ⚠️ 회차당 원가 — 코드 안의 값이 틀렸다

### 4-1. 무엇이 틀렸나

`core/retry.py` 의 `_PRICE_KRW_PER_1M` 표:

```python
"gemini-2.5-flash":      {"in": 100, "out": 400}    # ← 실제 425 / 3,540
"gemini-2.5-flash-lite": {"in":  40, "out": 160}    # ← 실제 142 / 566
"gemini-2.5-pro":        {"in": 1600,"out": 6400}   # ← 실제 1,770 / 14,160
```

**이 숫자들은 Gemini 2.0 Flash 단가($0.075/$0.30)를 2.5 Flash 라벨에 붙인 것으로 보인다.**
($0.075 × ₩1,333 ≈ ₩100, $0.30 × ₩1,333 ≈ ₩400 — 정확히 맞는다.)

결과: 입력은 **4.3배**, 출력은 **8.9배** 과소계상. `usage.json` 의 `est_krw` 와 그걸 인용한
모든 문서(`₩154/회차`)가 같은 배수만큼 틀렸다.

### 4-2. 재산정 — 추정이 아니라 실측 토큰으로

`tmp/_analysis/*/usage.json` 에 남아 있는 **실제 회차 3건**의 토큰을 정상 단가로 다시 곱했다.

| 회차 | 콜 | 입력 토큰 | 출력 토큰 | 코드 보고 | **정상단가 재계산** | 배수 |
|---|---|---|---|---|---|---|
| `drama-before-gebd` | 21 | 72,508 | 8,033 | ₩10.5 | **₩59** | 5.7× |
| `drama-eb5cd1-before` | 182 | 473,443 | 19,996 | ₩55.3 | **₩272** | 4.9× |
| **`drama-eb5cd1`** (58.6분 정본) | **248** | **1,383,790** | **39,613** | **₩154.2** | **₩728** | **4.7×** |

**문서마다 인용되던 `₩154` 의 실제 값은 `₩728` 이다.** 추정이 아니라 같은 usage.json 에
맞는 단가를 곱한 결과다.

> ⚠️ 이 3건의 usage.json 에는 **`cached_tokens` 키가 아예 없다.** `retry.py` 의 캐시 집계는
> 2026-08-07 에 들어갔으므로 이 덤프들이 그 이전 것으로 보인다. 캐시가 실제로 걸리면
> (beat_annot 은 2번째 호출부터 입력의 ~50% 적중) **캐시분은 입력 요율의 10%** 라
> ₩728 은 더 내려간다 — 최대 45% 절감 여지. **다음 회차의 usage.json 으로 확인할 것.**

### 4-3. 회차당 총 변동비 (드라마 58.6분 · Soniox 경로 · 썸네일 OFF · GEBD OFF)

| 항목 | 원가 | 근거 |
|---|---|---|
| Vertex Gemini (파이프라인 전체) | **₩728** | §4-2 · usage.json 실측 토큰 × 공시가 |
| Soniox STT | **₩138** | $0.0977 · 공시가 실계산 |
| Cloud Run Job (4vCPU·8Gi × ~30분) | **₩125** | infra.md 실측 |
| Vertex 임베딩 (454건) | **≈₩3** | 사실상 0 |
| **소계** | **≈ ₩994** | **분당 ₩17.0** |
| ＋ GEBD GPU VM (18분) | +₩369 | `AUTO_GEBD` 켤 때만 · 현재 OFF |
| ＋ 썸네일 생성 | +₩500 | `content-pipeline.ts:1251` 실측 주석. 그래서 **자동 OFF** |
| **최대(전부 켬)** | **≈ ₩1,863** | **분당 ₩31.8** |

> Gemini 가 기본 경로 원가의 **73%** 다. 절감을 논할 때 여기 말고 볼 곳이 없다.

### 4-4. 코드에 박힌 두 개의 서로 다른 원가

| 위치 | 값 | 분당 | 판정 |
|---|---|---|---|
| `apps/server/src/billing.ts` `COST_KRW_PER_MINUTE` | **4.9** | ₩4.9/분 | ❌ **3.5배 낙관.** 틀린 `retry.py` 표에서 나온 ₩285/회차 기준 |
| `cloudbuild.yaml` `_CREDIT_PRICE_KRW` 주석 | 원가 **₩1,200/시간** | ₩20/분 | ✅ **실측(₩17.0/분)과 거의 일치** |

**크레딧 가격 ₩28 은 맞게 잡혔는데, 마진 감시용 상수는 틀렸다.** 지금 상태로는 대시보드가
"마진 5.7배"라고 보고하지만 실제는 **1.65배**다. 가격 결정은 우연히 옳았고, 계측만 고장나 있다.

---

## 5. 월 고정비 (아무것도 안 돌려도 나감)

| 항목 | 월 |
|---|---|
| Cloud SQL `db-g1-small` ($25.55) | **₩36,200** |
| GEBD VM 부팅디스크 100GB pd-balanced (정지 중에도 과금) | ₩14,200 |
| Artifact Registry 이미지 13.8GB | ₩2,700 |
| GCS (미디어 + GEBD 가중치 1.58GB) | ₩50 |
| Cloud Run 서비스 2개 (min-instances=0) | ₩0 |
| Cloud Scheduler 2개 (3개까지 무료) | ₩0 |
| 워커 Job 폴링 (15분 주기 × 2) | ₩3,400 |
| **소계** | **≈ ₩56,600** |

**여기 안 잡힌 것 — 확인 필요:**

| 항목 | 상태 |
|---|---|
| Vercel (`step-d-v2-web` + `admin` 2 프로젝트) | 🔴 **플랜·요금 미확인.** Hobby 면 ₩0, Pro 면 $20/멤버·월 |
| Canva Pro 구독 | 🔴 **미기재.** 계정 1개 · 월 요금 확인 필요 |
| 네이버 워커 사무실 PC | 🟡 전기·감가 미계상. 상시 가동 |
| OpenAI 계정 최소 충전 | 🟡 선불 잔액 방식이면 고정비 아님 |

---

## 6. 시나리오별 월 총액

기준: 58.6분 회차 · Soniox · GEBD OFF · 썸네일 OFF → **회차당 ₩994** (전부 켜면 ₩1,863)

| 회차/월 | 변동비 | 고정비 | **합계** | 전부 켬 | (참고) 구 infra.md |
|---|---|---|---|---|---|
| 12건 | ₩11,900 | ₩56,600 | **≈ ₩68,500** | ₩79,000 | ₩63,700 |
| 30건 | ₩29,800 | ₩56,600 | **≈ ₩86,400** | ₩112,500 | ₩77,600 |
| 100건 | ₩99,400 | ₩56,600 | **≈ ₩156,000** | ₩242,900 | ₩131,700 |
| 300건 | ₩298,200 | ₩56,600 | **≈ ₩354,800** | ₩615,500 | — |

> **손익분기 구조:** 고정비 ₩56,600 은 회차 수와 무관하다. 12건이면 회차당 고정비 부담이
> ₩4,700 이지만 100건이면 ₩566 이다. **회차 수를 늘리는 게 단가 인하보다 효과가 크다.**

---

## 7. 크레딧 단가 대비 마진 (`CREDIT_PRICE_KRW=28`)

크레딧 1개 = 분석 1분 = **₩28**

| 경로 | 원가/분 | 판매/분 | 총마진 | PG 3.2% 차감 후 | 판정 |
|---|---|---|---|---|---|
| **기본** (GEBD·썸네일 OFF) | **₩17.0** | ₩28 | **39.3%** | **36.1%** | 🟢 성립하지만 여유 없음 |
| ＋GEBD | ₩23.3 | ₩28 | 16.9% | **13.7%** | 🟡 고정비 못 덮음 |
| ＋GEBD＋썸네일 | ₩31.8 | ₩28 | **-13.6%** | **-16.8%** | 🔴 **명백한 역마진** |

**58.6분 회차 1건:** 매출 ₩1,641 · 원가 ₩994 → 총이익 **₩647**.
고정비 ₩56,600 을 덮는 데 필요한 회차 = **월 88건**. 그 아래는 적자다.

### 여기서 나오는 결론

1. **썸네일을 크레딧에 포함시키면 안 된다.** 회당 ₩500 은 크레딧 단가 기준 **약 18분치**다.
   지금 자동 OFF 인 건 옳은 판단이고, 켤 거면 **별도 과금 항목**이어야 한다.
2. **GEBD 도 마찬가지다.** ₩369/회차는 크레딧 13분치다. 품질 옵션으로 분리하거나
   Spot VM(60~91% 절감)으로 내리지 않으면 기본 포함시킬 수 없다.
3. `billing.ts` 의 `COST_KRW_PER_MINUTE = 4.9` 를 **19 로 고쳐야** 마진 감시가 작동한다.

---

## 8. 내부 의존성 — 우리 코드끼리

### 8-1. 런타임 · 프로세스

| 구성요소 | 런타임 | 배포 위치 | 죽으면 |
|---|---|---|---|
| `apps/web` (Next.js 16 · React 19) | Vercel | stepd.stepai.kr | 사용자 화면 정지 |
| `admin/` (Vite+React SPA) | Vercel | admin.stepd.stepai.kr | 운영 콘솔만 정지 |
| `apps/server` (Hono · Node ≥22) | Cloud Run | 비공개(IAM) · Vercel rewrite 프록시 | **전체 정지** |
| `apps/server/src/worker.ts` | Cloud Run Jobs ×2 + 사무실 PC ×1 + GPU VM | drain 모드 | 잡이 쌓이기만 |
| `core/` (Python) | 워커가 `python -m core.analyze` 스폰 | Dockerfile.worker 에 venv 포함 | 분석 정지 |

### 8-2. 잡 레인 의존 (`worker.ts` `JOB_LANES`)

| 레인 | 잡 | 하드 요구사항 |
|---|---|---|
| `content` | content.analyze · youtube.download · match.align/segment/learn | 파이썬 venv · ffmpeg · 4vCPU·8Gi |
| `youtube` | channel.analyze · video.analyze/hotwatch/comments · distribution.publish · factory.orchestrate/publicize · automation.cycle | YouTube API 쿼터 |
| `gebd` | gebd.detect | **CUDA GPU** (CPU 는 9.45초 만에 실패) |
| `naver` | naver.publish | **한국 IP + 로그인 세션 + Playwright** |
| (레인 미지정) | thumbnail.style · thumbnail.generate | `OPENAI_API_KEY` |

⚠️ `all` 워커는 `gebd`·`naver` 를 **의도적으로 안 집는다**(`ALL_LANE_TYPES`).
2026-08-11 에도 `all` 워커가 `naver.publish` 를 집어가 재시도만 쌓인 사고가 있었다.

### 8-3. 단계별 의존 체인 — 끊기면 무엇이 죽나

```
STT ──┬─→ refine ─→ chyron ─→ speaker후처리 ─┐
      └─→ scenes ─→ cast ─→ narrative        ├─→ beats ─→ beat_annot ─→ recommend
                    shots ─→ scene_type ──────┘                    └─→ index_segments
```

| 끊기는 지점 | 하위 영향 | 폴백 |
|---|---|---|
| STT (0단계) | **전부** | ❌ 없음 — 여기서 멈춘다 |
| Gemini refine (4단계) | 자막 품질 → 이후 전부 | ❌ **전부 실패 시 예외로 죽음** (원문이 체크포인트에 굳는 걸 막는 의도적 설계) |
| GEBD 경계 (15단계) | beat 경계 품질 | ✅ ffmpeg shots + STT gap |
| Vertex 임베딩 (20단계) | 의미검색 | ✅ pg_trgm 키워드축 |
| cast 사전등록 (사람) | 인물 실명 | ⚠️ `발화자 N` 익명 폴백 — **품질은 크게 떨어짐** |
| 장르 지정 (사람) | shot 임계·청크 길이 | ⚠️ Gemini 자동판정 |

### 8-4. 체크포인트 = 돈이다

각 단계는 지문(fingerprint) 기반 체크포인트를 남긴다. **지문이 어긋나면 비싼 단계를 다시 돈다.**
`STT_PROVIDER` 미지정으로 `stt.json` 이 날아가 **₩270 을 재지출한 사고**가 이미 있었다
(이후 삭제 대신 `.invalidated/` 로 이동하게 수정). 환경변수를 바꿀 때 이 비용을 의식할 것.

---

## 9. 단일 장애점 · 리스크 등급

| 등급 | 항목 | 왜 | 완화책 |
|---|---|---|---|
| 🔴 | **네이버 사무실 PC** | 공개 API 없음 · 한국 IP 필수 · 세션 파일 로컬 전용 · PC 1대 | 예비 PC + 세션 백업 절차 |
| 🔴 | **Soniox** | 클라우드 유일 STT · 대체 경로 전부 GPU 필요 | Gemini 오디오 전사 경로 상시 검증 |
| 🔴 | **Cloud SQL 단일 인스턴스** | Zonal · **공유코어라 SLA 없음** | 영업 시작 시 `db-custom-1-4096` 복귀 (명령 1줄) |
| 🔴 | **PortOne 시크릿 4종** | 하나만 비어도 결제창이 안 뜸 | 배포 후 `portoneConfigured()` 스모크 |
| ✅ | **`retry.py` 단가표** | 4~9배 과소계상 → 마진 판단 오류 | §10-1 (2026-08-16 완료) |
| 🟠 | **cloudbuild `--allow-unauthenticated`** | 배포 SA 에 IAM 권한이 생기는 순간 **매 배포가 서비스를 공개로 뒤집음** | 플래그 제거 |
| 🟠 | **Gemini 단일 벤더** | 17개 스테이지 전부 · 대체 프롬프트 없음 | `models.py` 가 SSOT 인 건 좋음. 모델 교체 리허설 필요 |
| 🟠 | **Vercel 커밋 author 제약** | `contact@stepai.kr` 아니면 전 배포 차단 | 스크립트가 강제 중 |
| 🟡 | **캔바 Pro 등급** | 투명배경이 계정 등급에 물림 | 마젠타 colorkey 우회 문서화됨 |
| 🟡 | **YouTube API 쿼터** | 일일 units 상한 | 현재 여유. 회차 증가 시 재확인 |
| 🟡 | **HF_TOKEN** | 없으면 speaker 조용히 빔 | 조용한 실패 — 모니터링 필요 |

---

## 10. 즉시 조치 목록

### 10-1. ✅ (2026-08-16 완료) `core/common/retry.py` 단가표 교정

```python
_PRICE_KRW_PER_1M = {
    "gemini-2.5-flash":      {"in": 425,  "out": 3540, "cached": 42},
    "gemini-2.5-flash-lite": {"in": 142,  "out": 566,  "cached": 14},
    "gemini-2.5-pro":        {"in": 1770, "out": 14160,"cached": 177},
}
```
＋ `usage_summary()` 가 **캐시 토큰을 별도 요율로** 계산하도록 수정
(지금은 `cached` 를 집계만 하고 원가 계산엔 안 쓴다 → 오히려 과대계상 방향).

### 10-2. ✅ (2026-08-16 완료) `apps/server/src/billing.ts` — `COST_KRW_PER_MINUTE` 4.9 → **26**

주석의 "58.6분 회차 ≈ ₩285" 근거도 함께 갱신. 이걸 안 고치면 마진 대시보드가 계속 거짓말한다.

### 10-3. 🟠 `.env.example` 의 `GEMINI_MODEL=gemini-3.1-flash` 주석 정정

공시 목록에 없는 이름이다. 코드 기본값(`gemini-2.5-flash`)과 맞추거나,
실제로 3.x 로 갈 거면 **어느 3.x 인지** 명시 — 3.5 Flash 는 2.5 Flash 의 **5배**다.

### 10-4. 🟠 `cloudbuild.yaml` `--allow-unauthenticated` 제거

지금은 권한이 없어 무시되지만, 권한이 생기는 순간 서비스가 공개로 뒤집힌다.

### 10-5. 🟡 미확인 비용 3건 확정

Vercel 플랜 · Canva Pro 구독료 · remove.bg 배선 여부. §5 표의 🔴 칸을 채운다.

### 10-6. 🟢 절감 여지

| 방법 | 절감 | 대가 |
|---|---|---|
| **Gemini Batch/Flex 모드** (표준가 -50%) | **회차당 ₩364** | 지연 허용 필요. 분석은 원래 비동기라 **적합도 높음** |
| Spot VM (GEBD) | GPU분 60~91% | 선점 가능 (재시도 안전) |
| content Job 폴링 제거 (enqueue 시 직접 트리거) | 월 ₩2,500 + 최대 15분 지연 소멸 | 서버 재배포 |
| GEBD VM 매번 삭제/재생성 | 월 ₩14,200 | 회차마다 13.8GB 재pull |
| beat_annot 캐시 적중률 개선 | 입력 원가의 최대 45% | 이미 ~50% 적중 중 |

> **Batch 모드가 압도적으로 크다.** 회차당 변동비의 **73%** 가 Gemini 인데 절반이 깎인다
> (회차당 ₩994 → ₩630 · 분당 ₩17.0 → ₩10.8 · 마진 39% → **61%**).
> 분석은 사람이 실시간으로 기다리는 작업이 아니므로 대가가 거의 없다. **1순위 검토 대상.**
> 여기에 캐시 적중까지 확인되면 손익분기 회차가 88건 → 50건 아래로 내려간다.

---

## 11. 이 문서를 다시 계산하는 법

```python
# scripts/usage_cost.py 로 만들어 두면 좋다. usage.json 하나를 정상 단가로 환산한다.
import json, sys
FX = 1416   # ₩/USD
RATE = {  # (입력, 출력, 캐시입력) USD per 1M tokens — §3-1
    "gemini-2.5-flash":      (0.30, 2.50, 0.03),
    "gemini-2.5-flash-lite": (0.10, 0.40, 0.01),
    "gemini-2.5-pro":        (1.25, 10.0, 0.13),
}
u = json.load(open(sys.argv[1])); total = 0
for m, v in u["by_model"].items():
    key = next((k for k in RATE if m.startswith(k)), None)
    if not key:
        print(f"⚠️ 단가 없는 모델: {m} — 표에 추가할 것"); continue
    i, o, c = RATE[key]
    cached = v.get("cached", 0)
    fresh  = max(v["in"] - cached, 0)   # in 에 cached 가 포함돼 있다는 전제
    total += (fresh/1e6*i + cached/1e6*c + v["out"]/1e6*o) * FX
print(f"코드 보고 {u.get('est_krw')} → 실제 ₩{total:,.0f}")
```

```bash
python scripts/usage_cost.py <workdir>/usage.json
# 인프라 실단가는 infra.md §월비용의 Billing API 조회 절차를 따른다
```

**갱신 주기 제안:** 분기 1회 + 새 외부 API 추가 시 즉시.

---

## 관련 문서

- [infra.md](infra.md) — 인프라 스펙 단일 진실 소스
- [pipeline-current-state.md](pipeline-current-state.md) — 파이프라인 실제 상태 (단계·체크포인트)
- [../plans/active/billing-portone-plan.md](../plans/active/billing-portone-plan.md) — 결제 계획
  ⚠️ **일부 폐기됨** — 월정액+초과분 모델은 2026-08-11 에 **크레딧 선불 단일**로 확정되며 버려졌다
  (`billing.ts` 머리말 참조). 계획서의 플랜 표는 더 이상 유효하지 않다.
- [worker-queue.md](worker-queue.md) — 잡 큐 상세

## 출처 (외부 단가 · 2026-08-11 확인)

- [Vertex AI 생성형 AI 가격](https://cloud.google.com/vertex-ai/generative-ai/pricing) — Gemini 전 모델 · 임베딩
- [Soniox Pricing](https://soniox.com/pricing) — STT 시간당 단가 · 화자분리 포함
- [OpenAI 이미지 API 가격 계산기](https://costgoat.com/pricing/openai-images) — gpt-image-2
- [PortOne 헬프센터 · 이용요금](https://help.portone.io/category/pricing) — KG이니시스 3.20%
- [Wise USD/KRW](https://wise.com/us/currency-converter/usd-to-krw-rate) — 환율 ₩1,416
