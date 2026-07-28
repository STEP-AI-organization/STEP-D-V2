# 객체인식 기술 조사 (2026-07)

> 최종 검토: 2026-07-16
>
> **⚠️ 기술 조사·선정 근거 문서 — 여기 나온 기술 다수는 미구현이다.** 본문의 현재형 표현("유지"/"제공")은
> 현행 사용이 아니라 **후보 선정** 의미다. 코드에 이미 있는 것/없는 것은 바로 아래 「구현 현황」 참조.
>
> STEP-D 관점 조사: PPL 상품·브랜드 식별(H), 화자 추적 리프레이밍(F), 썸네일 스코어링(G), 트렌드 역분석(T)에 쓸 기술 선정 근거.
> 전제: GPU 자체 호스팅 없음(관리형 API 위주) — [../plans/pipeline-plan.md](../plans/pipeline-plan.md) 참조.

## 구현 현황 (2026-07-16 코드 실측)

현행 프로덕션 파이프라인(`core/analyze.py`)은 **STT → 자막정제 → 장면분할 → 시각채점 → 이름자막 → 쇼츠추천**
6단계이며 전부 Gemini/Vertex(서울) + ffmpeg + scenedetect다. **얼굴 검출·추적·임베딩 단계는 아직 없다.**

| 상태 | 항목 |
|------|------|
| ✅ 가동 중 | **Gemini 비전 채점** (`core/vision.py`) — 장면 대표 프레임의 숏폼 가치를 Gemini Vision으로 채점. H 1차안이 전제하는 "E 비전 평가 인프라 공유"의 실체 |
| ✅ 가동 중 | **이름자막 OCR** (`core/names.py`) — Gemini로 번인 이름자막 추출. CX 신호 ③의 커버리지 검증이 이미 코드로 존재 (PaddleOCR은 미채택) |
| ✅ 가동 중 | **STT = Gemini** (`core/asr.py`, `STT_PROVIDER` 기본 gemini, Vertex asia-northeast3). 단 **화자 분리(diarization) 없음** — `{start, end, text}`만 반환 |
| ❌ 미구현 | 얼굴 검출(MediaPipe), 추적(ByteTrack), 얼굴/의상 임베딩(OpenCLIP·InsightFace·pgvector), Video Intelligence, Grounding DINO, RF-DETR — 레포 전체에 코드·의존성 0건(`core/requirements.txt`에도 없음) |
| ❌ 미구현 | **F 리프레이밍** — 현재 렌더는 단순 트림뿐(`apps/server/src/ffmpeg.ts`의 `trimEncode`: `-ss`/`-t` 구간 재인코딩, 크롭·리프레이밍 없음) |

## 2026 기술 지형 요약

**1) 지도학습 실시간 검출기** — 트랜스포머 계열이 YOLO를 따라잡음

| 모델 | 라이선스 | 특징 |
|------|---------|------|
| RF-DETR | **Apache-2.0** | 2026 SOTA급 (COCO mAP 54.7%, <5ms). 가림·도메인 변화에 강함 |
| YOLO26 / YOLO11 (Ultralytics) | **AGPL-3.0 ⚠️** | 엣지·실시간 최강이지만 SaaS 사용 시 전체 코드 공개 또는 상용 라이선스 필요 → **우리 B2B SaaS에 부적합** |
| YOLOX / RT-DETR / D-FINE | Apache-2.0 | 허용적 라이선스 YOLO 대안 |

**2) 오픈 보캐뷸러리(제로샷) 검출** — 텍스트 프롬프트로 임의 객체 검출, 학습 데이터 불필요

| 모델 | 라이선스 | 특징 |
|------|---------|------|
| Grounding DINO | Apache-2.0 | "라면 봉지", "파란 모자 쓴 사람" 같은 문장 프롬프트로 박스 검출. 정확도 우선 |
| YOLO-World | GPL-3.0 **[미결 — 라이선스 확인 필요]** | 속도 우선 제로샷. 라이선스 재확인 전까지 사용 판단 보류 |
| Grounded SAM 2 | Apache-2.0 (SAM2) | 검출→분할→**비디오 추적**까지 연결하는 파이프라인 |

**3) 관리형 API**

| 서비스 | 용도 적합성 |
|--------|------------|
| **Google Video Intelligence — Logo Recognition** | 10만+ 브랜드 로고를 영상에서 검출·추적하고 **구간 타임스탬프 반환** — PPL 구간화(H)와 정확히 일치. 2026년 Vertex AI Vision으로 통합, Gemini 백본 |
| **Gemini 멀티모달** | 프레임 이미지 + 브랜드 사전을 프롬프트로 넣는 "관리형 오픈 보캐뷸러리". 로고 없는 상품(음식·의류 등 형태 기반)도 식별 가능 — Logo Recognition의 사각지대 보완. 인프라는 `core/vision.py`로 이미 가동 중 |
| MediaPipe (Apache-2.0, 로컬 실행) | 얼굴·포즈 검출. API 아님에도 CPU로 충분히 빨라 서버 내 실행 가능 |

**4) 추적(tracking)** — ByteTrack(MIT)이 표준. 프레임별 검출 결과를 시간축으로 연결할 때 사용.

## STEP-D 용도별 권장

### H — PPL 상품·브랜드 식별 (미착수)

- **1차 (계획대로): Gemini 멀티모달.** 광고주 브랜드 사전을 프롬프트에 넣어 샘플 프레임 평가. 로고 없는 상품(협찬 음식, 의류)까지 커버. E 비전 평가(`core/vision.py` — 가동 중)와 인프라 공유로 추가 구축 비용 0.
- **보강 (물량·정밀도 필요 시): Video Intelligence Logo Recognition.** 로고 노출 구간 타임스탬프를 API가 직접 반환 → 프레임 샘플링 방식보다 구간 경계가 정밀. 관리형이라 운영 부담 없음. 회차당 비용 산정 후 병행 여부 결정.
- **장기 (비용 역전 시): Grounding DINO 자체 호스팅.** 브랜드 사전 → 텍스트 프롬프트 그대로 이식 가능. Apache-2.0.
- 음성 언급(STT 텍스트 매칭)과의 이중 신호 교차는 어떤 선택이든 동일하게 자체 구현 (핵심 IP).

### F — 화자 추적 리프레이밍 (전체 미구현 — 현 렌더는 단순 트림)

- **MediaPipe face detection (Apache-2.0) 후보(미도입).** 현 파이프라인(`core/analyze.py`)에 얼굴 검출 단계 자체가 없다. 예능·드라마는 얼굴 중심이라 충분하다는 선정 판단은 유지. 크롭 경로 스무딩(9:16)은 자체 구현 예정 — 현재 클립 렌더는 `trimEncode`의 구간 트림뿐이라 리프레이밍 자체가 신규 빌드다.
- 얼굴이 안 잡히는 장면(뒷모습·원경) 대비가 필요해지면 RF-DETR(Apache) person 검출 + ByteTrack(MIT) 추가.
- "말하는 사람" 판별 — **전제 정정:** 원안은 "STT 화자 분리(Clova 제공) × 얼굴 입 움직임" 교차였으나, 실제 채택된 STT는 Clova가 아니라 **Gemini**(`core/asr.py`)이고 Gemini 경로는 화자 라벨을 생성하지 않는다(`{start,end,text}`만 반환). 즉 "화자 분리를 이미 확보했다"는 지름길 전제가 현행 스택에 성립하지 않는다. 발화 귀속을 하려면 (a) diarization 단계를 별도 추가하거나 (b) 얼굴 입 움직임 단독 판별로 재설계해야 한다.

### G — 썸네일 / T — 트렌드 역분석

- G: MediaPipe 얼굴 + 라플라시안 선명도 — 후보(미착수, MediaPipe 미도입은 F와 동일).
- T: Gemini 태깅으로 충분. 별도 검출기 불필요.

## CX 인물 확정 식별 스택 (핵심 — [../plans/context-engine-plan.md](../plans/context-engine-plan.md)의 기반 기술)

CX 트랙의 성립 조건은 "샷 단위로 등장인물이 확정되는가"다. 단일 모델이 아니라 **다중 신호 융합**으로 설계한다. 방송 콘텐츠라서 생기는 지름길이 많다. **아래 표에서 실제 코드가 존재하는 신호는 ③(Gemini OCR)뿐이다.**

**파이프라인: 샷 분할 → 신호 추출 → 샷 단위 인물 투표**

| 신호 | 기술 | 상태 | 비고 |
|------|------|------|------|
| ① 얼굴 검출 | MediaPipe (Apache-2.0, CPU) | 미구현 | 얼굴 있는 프레임만 후단 호출 — 비용 필터 |
| ② 얼굴 매칭 | 1차: Gemini 폐쇄 후보군 매칭 ("등록된 15명 중 누구") / 2차: 임베딩+pgvector | 미구현 | ⚠️ **[미결]** 자체 임베딩 전환 시 함정: 코드가 MIT여도 **가중치·학습 데이터셋이 연구용 한정**인 경우 다수(InsightFace 계열). 상업 사용 가능 가중치 또는 관리형(AWS Rekognition 등)으로 — 판단 보류 중 |
| ③ 네임 자막 OCR | **Gemini (채택 — `core/names.py` 가동 중)**. PaddleOCR(Apache-2.0)은 미채택 | 부분 구현 | **방송 특화 최강 신호** — 나는솔로류 예능은 인물 등장 시 이름 자막이 번인되어 있음. 커버리지 검증 실험이 이미 파이프라인에서 돌고 있음(인물 확정 융합은 미구현) |
| ④ 의상 re-ID | CLIP 계열 임베딩 (OpenCLIP, MIT) | 미구현 | 같은 회차 내 의상 고정 → 얼굴로 1회 확정된 인물의 의상 벡터로 뒷모습·원경·측면 샷 커버 |
| ⑤ 발화 귀속 | 화자 분리 × 얼굴 입 움직임 교차 | 미구현 + **전제 갭** | 원안의 "Clova 화자 분리" 전제는 무효 — 현 STT(Gemini, `core/asr.py`)는 화자 라벨이 없다. 전사(발화 단위 타임스탬프)만 확보된 상태라 diarization을 새로 붙여야 이 신호가 성립 |
| ⑥ 샷 내 전파 | ByteTrack (MIT) | 미구현 | 샷 안에서 한 프레임만 확정되면 트랙 전체에 ID 전파 → 호출 수 절감 |

- 샷의 최종 인물 태그 = ①~⑤ 신호의 가중 투표. 신호 간 충돌 시(얼굴≠자막) 저신뢰 마킹 → 운영자 검수 큐.
- 이 "얼굴+네임자막+의상+화자 다중 신호에 의한 샷 단위 인물 확정" 구조 자체가 특허 확장 후보 ([../plans/context-engine-plan.md](../plans/context-engine-plan.md)의 청구 후보 1을 구체화).

**검증 PoC (CX1 착수 전 필수)**

- 나는솔로 1회분(또는 보유 콘텐츠)으로 샷 단위 인물 태깅 정확도 측정: Gemini 폐쇄군 매칭 단독 vs +OCR vs +의상. (OCR 쪽 재료는 `core/names.py`로 이미 뽑을 수 있음)
- 합격선 예시: 주요 인물 샷 태깅 정확도 90%+ (미달 시 CX-2 장면 요약 품질이 연쇄 붕괴하므로 여기가 게이트).
- 회차당 비용 실측 → 신호별 온/오프 구성 결정 (OCR이 충분히 강하면 얼굴 호출을 더 줄일 수 있음).

## 결정 요지

1. **Ultralytics YOLO(v8~26)는 쓰지 않는다** — AGPL. 자체 검출기가 필요해지는 시점엔 RF-DETR·YOLOX·Grounding DINO 등 Apache 계열로.
2. 현 단계 기본값은 **Gemini(범용) + 필요 시 Video Intelligence Logo Recognition(로고 특화)** — GPU 없이 시작, 어댑터로 감싸 자체 모델 전환 여지 확보. Gemini 쪽은 STT·비전 채점·이름자막 OCR(`core/asr.py`·`vision.py`·`names.py`)로 이미 검증됐고, Video Intelligence는 미도입.
3. MediaPipe·ByteTrack 같은 경량 로컬 도구는 API 비용 없이 서버 CPU에서 처리 — 얼굴/추적은 이 조합이 후보(둘 다 미도입).
4. **미결 라이선스 2건**: YOLO-World GPL-3.0 여부 확인, InsightFace 계열 가중치의 상업 사용 가능 여부 — 각 도입 시점 전에 결론 필요.
