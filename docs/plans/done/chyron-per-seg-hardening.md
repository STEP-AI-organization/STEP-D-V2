# chyron per-seg 견고화 · 3단 계획

2026-08-06. 로컬 실측 도중 chyron per-seg 스텝이 662 세그 × Vision 1콜 = 662 API 호출을 조용히 돌리다가
워커 워치독의 "stdout 60분 무응답 = kill" 룰에 두 번 연속 죽음. 근본 fix 3단.

## 배경 (bug 재현)

- `content.analyze` 큐에 잡 넣음 → refined 까지 잘 감 → `[chyron-seg] 662 세그 · Vision 병렬(workers=6)` 한 줄
  찍고 그대로 조용. 60분 넘게 stdout 무언 → 워치독 kill.
- 두 번째 재시도도 동일. 재시도 시 PPL 이 5배 느려짐 (Vertex quota throttling 의심 · 첫 실행 252s → 재실행 3355s).
- 결과: `search_segments` 0건 · 자연어 검색 실측 불가.

우회 = `RUN_CHYRON_PER_SEG=0`. 실측·개발엔 유효하지만 프로덕션 품질엔 필요 (speaker 실명 부여가
검색·추천·썸네일 다 물려있음).

## Fix 1 · 진행률 로그 + 콜당 timeout **[완료 · 2026-08-06]**

`core/chyron_scan.py::scan_per_seg` 를 `ex.map` → `submit` + `as_completed` 로 교체.

- **PROGRESS_EVERY=50** 세그마다 `[chyron-seg] N/M · elapsed=… · eta=… · timeouts=…` 한 줄.
- **CALL_TIMEOUT_SEC=60.0** 초과 콜은 미부여로 처리 · 전체 스텝이 무한 대기 빠지지 않게.
- 워치독 stall 오판을 즉시 없앰 · 실제 hang 인지 그냥 느린지 눈으로 판정 가능.

효과: 로컬·프로덕션 둘 다 워치독 kill 회피. hang 근본 원인 (Vertex 무한 대기?) 은 timeouts 카운트로 관측 후 별건 대응.

## Fix 1.5 · **ffmpeg 시킹 방향 (진짜 병목이었다)** **[완료 · 2026-08-06]**

Fix 2(배치화)를 하기 전에 **원인이 API 가 아니라 ffmpeg 였다**는 게 실측으로 드러났다.

`_extract_at` 이 `-ss` 를 `-i` **뒤**에 두고 있었다 = **출력 시킹**. ffmpeg 가 0초부터 전 프레임을
디코드해서 t 까지 간 뒤 1장을 뽑는다. 세그마다 부르는 코드라 뒤쪽 세그일수록 선형으로 느려진다.

```
-i video -ss 1800 …   (기존 · 출력 시킹)   →  83.2초
-ss 1800 -i video …   (수정 · 입력 시킹)   →   0.149초      ← 558배
```

추출된 프레임은 **바이트 단위로 동일**(md5 일치) — 정확도 손실 없음. 최신 ffmpeg 의 입력 시킹은
키프레임으로 점프한 뒤 t 까지 디코드해 버리므로 정확하다.

**실측 (m_981d7c08 · 32분 · 662 세그 · workers=6)**

| | 20 세그 샘플 | 662 세그 외삽 |
|---|---|---|
| 수정 전 | **10분 초과 (타임아웃)** | 시간 측정 불가 |
| 수정 후 | **11.2초** (1.78콜/초) | **약 6.2분** |

> 이 문서가 위(§로컬 실측 재개)에서 "첫 실행 30~50분 예상"이라 한 것도 같은 원인이었다.
> 워치독이 "60분 stdout 무응답"으로 두 번 죽인 것 역시 API hang 이 아니라 **디코드 대기**였을
> 가능성이 높다.

`core/beat_annot.py:71` 은 원래 맞게 돼 있었고(도크스트링에 "`-ss` 는 `-i` 앞 (fast seek)"이라고
명시), `scene_type.py`·`scenes.py`·`segment.py`·`shots.py` 도 정상. **`chyron_scan.py` 하나만 틀렸다.**

### Fix 2 의 전제가 바뀐다

배치화의 근거는 "호출수 662 → 40~80, **지연 시간·비용 대략 1/10**"이었다. 시간 쪽 근거는
Fix 1.5 로 이미 회수됐다(6.2분이면 파이프라인 병목이 아니다). 남는 건 **비용 ₩150 → ₩50** 뿐이고,
정확도 저하 리스크는 그대로다. **Fix 2 는 우선순위를 낮추고, 비용이 실제로 문제가 될 때 A/B 로 판단.**

## Fix 2 · 배치화 (호출수 감소) **[미완 · 우선순위 하향 — Fix 1.5 참고]**

지금은 세그당 Vision 1콜 (프레임 1장 + 짧은 프롬프트). Gemini flash 는 멀티모달 배치 요청이 되므로:

- **세그 8~16개를 한 콜에 묶기** — 프레임 여러 장을 한 Content 에 넣고 · "각 프레임의 이름 태그를 배열로"
  라는 프롬프트로 · response_schema 를 `{names: STRING[]}` 로.
- **호출수 662 → 40~80** (배치 크기 8~16 기준). 지연 시간·비용 대략 1/10.
- 리스크: 배치 크면 프레임당 정확도 떨어질 수 있음 · A/B 필요.

착수 조건: Fix 1 배포 후 실측 데이터로 "현재 소요·정확도" 기준선 확보 → 배치 8·16 실측 비교.

## Fix 3 · 별도 잡 분리 (UX 최선) **[미완]**

지금 chyron 은 `content.analyze` 안 필수 스텝. 이걸 뽑아 별도 잡으로:

```
content.analyze  (chyron 스킵 default)
  → refined.json · beats · shorts · search_segments 인덱싱  → 완료 통지
chyron.enhance  (별도 잡)
  → chyron per-seg → speaker rewrite → search_segments 재인덱싱 (speaker 필드만 update)
```

이점:
- **검색이 즉시 가능** (chyron 없이도 STT 텍스트로 인덱싱).
- chyron 이 죽거나 느려도 사용자 waiting flow 안 막힘.
- chyron 은 회당 몇 분~십수 분 걸리는 무거운 잡 · 별도 잡으로 격리하면 워커 리소스 관리 쉬움.

배선 지점:
- `apps/server/src/queue.ts` 잡 타입에 `chyron.enhance` 추가.
- `apps/server/src/worker.ts` handle 스위치 추가 · workdir 재활용 (`stepd-content/{mediaId}/refined.json` 존재 전제).
- `content.analyze` 완료 시 자동으로 `chyron.enhance` 큐잉 (dedupeKey `chyron:{mediaId}`).
- speaker 재작성 후 `search_segments` 의 해당 mediaId row 만 UPDATE (speaker_name 필드).

착수 조건: Fix 1 (관측), Fix 2 (성능) 완료 후. 잡 큐 구조 변경이라 신중.

## 비용 · 60분 회차 기준

Gemini 2.5 flash (asia-northeast3) 요율 대략 · **정확한 실측치는 관측 후 갱신 필요**.
아래는 60분 회차 · 세그 ~1000개 가정 · 원화 환산 대략.

| 스테이지 | 콜수 | in 토큰/콜 | out 토큰/콜 | 회당 대략 | 비고 |
|---|---|---|---|---|---|
| **STT (Soniox)** | 1 | (duration billed) | — | **₩270** | ~$0.20/hour · Gemini audio 아님 (2026-08-06 정정) |
| refine (batch=80) | ~13 | ~15k | ~5k | ₩30 | 텍스트 정제 |
| PPL (프레임 페어) | 389 | ~2k | ~30 | ₩30 | flash-lite 사용 가능하면 더 낮음 |
| **chyron per-seg (현재)** | **~1000** | **~800** | **~50** | **₩150** | 세그 1개 = 콜 1개 |
| **chyron per-seg (배치 16)** | **~62** | **~8.5k** | **~200** | **₩50** | Fix 2 · 1/3 |
| beats | ~20 | ~10k | ~2k | ₩30 | |
| shorts propose+select | ~10 | ~30k | ~5k | ₩100 | Phase A/B |
| 썸네일 (nano banana) | ~10 | 이미지 gen | — | ₩500 | 별건 · imagen 요율 |
| **합계 (chyron 배치화 전)** | | | | **~₩1000** | |
| **합계 (chyron 배치화 후)** | | | | **~₩900** | 큰 절감은 아니지만 시간 1/10 |

**주의**
- 위는 셀프 추정 · 실제 청구서와 다를 수 있음. 실측 후 [[pipeline-optimization-findings]] 에 갱신 반영.
- 60분 회차 하루 100건 처리 → 월 300만원 근처. 방송사·MCN 다수 계약 시 비용이 매출을 갉아먹는 지점 옴.
- **가장 큰 지출은 썸네일 gen (₩500/회) · 다음이 chyron+STT.** 절감 우선순위도 이 순서.

비용 관리 원칙:
- **재시도 폭탄 방지 필수** — 이번 실측에서 자동 재시도로 PPL 이 두 번 돌음 (₩60). 잡 실패 시
  attempts 상한을 낮추고 (기본 5 → 2), dead-letter 로 사람 개입 유도.
- **체크포인트 재활용 유효** — refined.json 재사용은 확인됨. 다른 산출물(ppl_frames, faces, beats)
  도 workdir 잔존 시 스킵되도록 각 스텝 첫줄에서 존재 확인 → skip 필수.
- **프롬프트 캐싱** — [Round 3 D3](../research/pipeline-optimization-findings.md) 미완. shorts propose 처럼
  같은 컨텍스트 여러 번 도는 스텝은 캐싱하면 in 토큰 30~50% 절감.
- **배치화 우선순위**: chyron 배치는 시간 절감이 크지 비용 절감은 작음. **thumbnail gen 을 variant
  4개 → 2개** 로 줄이는 게 회당 ₩250 절감 · 가장 크다.

## 로컬 실측 재개

Fix 1 이 완료된 지금 · `RUN_CHYRON_PER_SEG=1` 로 다시 큐잉하면 워치독에 안 죽고 진행률이 실시간 보임.
단, 로컬 GPU/네트워크로 662 콜은 여전히 오래 걸릴 것 (첫 실행 fitted 30~50분 예상). 검색 실측만
급하면 `RUN_CHYRON_PER_SEG=0` 유지 후 나머지 스테이지 (beats·shorts·search 인덱싱) 완주가 최단.
