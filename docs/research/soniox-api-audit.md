# Soniox API 감사 — STEPD 파이프라인 결정용

> 감사일 2026-07-31 · 대상 https://soniox.com/docs · 관점: 한국 예능 5분 clip · WhisperX+PyAnnote 3.1 대체 가능성

## TL;DR (3-5줄)

1. **한국어 정확도는 Soniox가 우세하다.** 자체 벤치(YouTube 실환경)에서 Korean 4.3% WER vs OpenAI Whisper 10.8% WER — 2.5x 격차. v5 async는 "underserved 언어 (Korean/Turkish/Arabic)" 개선을 명시적으로 홍보한다.
2. **Diarization 접근이 우리 use case에 유리.** "acoustic + 대화 문맥 + 의미 흐름" 결합, "웃음/BGM/overlap/interruption 강화" 명시. PyAnnote (embedding+clustering 순수 acoustic) 대비 예능(짧은 발화·크로스톡·웃음)에 강할 근거 있음. **단** min/max_speakers 파라미터가 없고, 최대 15명 상한, 공개된 DER 수치는 없음.
3. **가격 매우 저렴.** async $1.50/1M audio tokens ≈ **$0.10/hour** → 5분 clip 1회 ≈ **$0.0083 (약 11원)**. Real-time $0.12/hr. Diarization/language ID/context 모두 요금 포함, 별도 청구 없음.
4. **배선은 이미 우리 것과 정확히 일치.** 응답 shape가 `tokens[]: {text, start_ms, end_ms, speaker, language, confidence}` — speaker는 **문자열** (`"1"`, `"2"`), segment 옵션 없음(토큰만). 최대 5시간 오디오·10GB 저장·대기 100건/총 2000건 상한. 데이터 재학습 X, GDPR/SOC2/ISO27001/HIPAA, region은 US/EU/JP만 (한국 없음).
5. **권고: 예능 clip에 PoC 진행 가치 충분.** 다만 (a) 최대 15명·min/max_speakers 없음·엔터테인먼트 DER 미공개는 자체 A/B 필수, (b) Korean region 없음(JP 최근접) 방송사 컴플라이언스 사전 확인, (c) prompt caching 없이 5분당 11원은 비용 이슈 아님 — WhisperX GPU 자가호스팅 대비 운영 부담 완화 이득이 큼.

---

## 1. 모델 종류

**현재 활성 모델은 v5 2종 (2026-06 릴리스)**

| 모델 ID | 용도 | 릴리스 | 언어 | 특징 |
|---------|------|--------|------|------|
| `stt-async-v5` | 배치·녹음 파일 | 2026-06-11 | 60+ | "completely reengineered speaker separation", 언어 ID·alphanumeric 개선 |
| `stt-rt-v5` | 실시간 스트림 | 2026-06-16 | 60+ | v5 real-time, "reinvented speaker separation", 대화 흐름 기반 diarization |

**Deprecation timeline**
- `stt-rt-v4`, `stt-async-v4`: **2026-06-30 retire** → v5로 자동 라우팅
- `stt-rt-preview-v2`, `stt-async-preview-v1`: 이미 v3로 alias 처리됨

**우리가 현재 쓰는 `stt-async-preview`**: preview 시리즈는 이미 alias 종료. v5로 명시 전환 권고.

**Real-time vs Async 실질 차이**
- Async는 전체 오디오 context 접근 → 문서 명시 "significantly higher diarization accuracy"
- Real-time은 endpoint detection·수동 finalization으로 diarization 정확도가 낮아진다는 명시적 disclaimer 존재
- **우리 use case(5분 완결 clip 배치)는 async가 정답**

출처:
- https://soniox.com/docs/stt/models
- https://soniox.com/blog/soniox-v5-async
- https://soniox.com/blog/soniox-v5-real-time

---

## 2. Diarization 옵션

**단일 파라미터 · min/max_speakers 없음**
```json
{ "enable_speaker_diarization": true }
```
- `min_speakers` / `max_speakers` / `num_speakers` 파라미터는 **문서에 없음** (Deepgram·AssemblyAI는 있음)
- **최대 화자 수 상한: 15명**
- speaker 필드 형식: **문자열** — `"speaker": "1"`, `"speaker": "2"` (int 아님)

**접근 방식 (블로그 서술, 논문 없음)**
> "acoustic information, conversational context, and the flow of dialogue to produce speaker-aware output"
> "both the sound of each speaker's voice and the semantic flow of the conversation"

즉 순수 acoustic embedding+clustering(PyAnnote 3.1)이 아니라 **음향 + 의미 문맥** 결합. v5 async는 "meetings, interviews, calls, **interruptions**, **speaker changes**, **laughter**, background noise, and **overlapping speech**"를 명시 강화 대상으로 나열 — **한국 예능(BGM·웃음·cross-talk)이 이 케이스에 정확히 맞음**.

**한계 (문서 명시)**
- Real-time: "Higher speaker attribution errors compared to async mode", "Temporary speaker switches that stabilize as more context is available"
- 공통: "Accuracy may decrease when many speakers have **similar voice characteristics**"
- 언어 무관: "Speaker diarization is available for all supported languages"

**PyAnnote 대비 벤치 수치 없음** — 자체 DER 발표 없고 pyannote 언급도 없음. **A/B 필수**.

출처:
- https://soniox.com/docs/stt/concepts/speaker-diarization
- https://soniox.com/blog/soniox-v5-async

---

## 3. 한국어 지원

**공식 지원 확인**
- ISO code `ko` 지원 언어 목록에 포함
- v5 async 릴리스 노트: "breakthrough accuracy across more than 60 languages" + "underserved languages like **Korean**, Turkish, and Arabic" 개선 명시

**자체 벤치 수치 (Soniox 공개, 2025)**
- **Korean 4.3% WER (Soniox) vs 10.8% WER (OpenAI Whisper)** — 2.5x 격차
- 데이터셋: "real-world YouTube audio"
- 방법: Gemini 정답 생성 + 사람 리뷰
- 커버리지: 60개 언어 전반

**단 broadcast/entertainment 오디오 세부 breakdown 없음**
- 60개 언어 종합 문서만. 예능·뉴스·인터뷰별 세분 벤치 미공개.
- 2023-03 옛 벤치 PDF에는 "news reporting/broadcasting에서 81.41% 리드" 표현 있으나 방법론 노후

**Diarization × Korean**
- "Speaker diarization is available for all supported languages" — Korean 포함 명시
- Korean에서 diarization 정확도 개별 수치 **없음**

출처:
- https://soniox.com/docs/stt/concepts/supported-languages
- https://soniox.com/compare/soniox-vs-openai/korean (검색 스니펫으로 확인, 직접 fetch는 404)
- https://soniox.com/blog/soniox-v5-async

---

## 4. 부가 기능

| 기능 | 지원 | 파라미터 / 형식 |
|------|------|----------------|
| **Language identification** | ✅ per-token | `enable_language_identification: true` → 토큰별 `language` 필드. Real-time은 "language tags being revised as context arrives" |
| **Translation** | ✅ 3,600+ pair | Request body에 `translation: { type: "one_way"|"two_way", target_language, ... }` |
| **Timestamps** | ✅ 기본 | `start_ms`, `end_ms` per token |
| **Custom vocabulary** | ✅ `context` 파라미터 | 4 section: `general[key,value]`, `text` (긴 배경), `terms[]` (단어 리스트), `translation_terms[]`. 최대 **8,000 tokens (~10,000자)** 전체. terms 개수 상한은 문서 없음 |
| **Webhooks** | ✅ | `webhook_url` + auth header 파라미터 |
| **Client reference ID** | ✅ | `client_reference_id` |
| **Summarization** | ❌ | 별도 기능 없음 (LLM으로 후처리 필요) |
| **Content moderation / profanity filter** | ❌ | 문서에 없음 |
| **Smart formatting (alphanumeric)** | ✅ 자동 | v5 async에서 "phone numbers, emails, codes, dates" 정형화 강화 명시. 요금 별도 없음 |

**우리에게 유용한 것**
- `context.terms`로 예능 등장인물 이름·프로그램명·유행어 사전 주입 가능 (PyAnnote에는 없는 기능)
- per-token `language`로 한/영 코드스위칭 대응 (예능 인터뷰에서 유용)

출처:
- https://soniox.com/docs/stt/async/async-transcription
- https://soniox.com/docs/stt/concepts/language-hints
- https://soniox.com/docs/stt/concepts/language-identification
- https://soniox.com/docs/stt/concepts/context
- https://soniox.com/docs/translation/get-started

---

## 5. 가격

**공식 pricing (2026-07 기준)**

| 서비스 | 요율 | 시간당 환산 |
|--------|------|------------|
| **STT async (input audio)** | $1.50 / 1M tokens | **~$0.10/hour** |
| **STT real-time (input audio)** | $2.00 / 1M tokens | **~$0.12/hour** |
| Input text | $3.50 (async) / $4.00 (RT) / 1M tokens | — |
| Output text | $3.50 (async) / $4.00 (RT) / 1M tokens | — |
| TTS output audio | $21.50 / 1M tokens | ~$0.70/hour |

**Translation, diarization, language ID, smart formatting, context: 전부 위 요율에 포함 (별도 청구 없음).**

**5분 clip 1회 비용**
- Async: $0.10/hr × 5/60 = **$0.0083 ≈ 11원**
- Real-time: $0.12/hr × 5/60 = $0.010 ≈ 13원

**Free trial / discount**
- 공식 페이지: 트라이얼 크레딧 액수 명시 없음 · "Enterprise discounts and committed-use contracts may differ" 문구만
- 3rd party 리뷰(SoftwareWorld 등): "Free plan $0/mo + 10 free credits weekly"라는 표현이 있으나 이는 **Soniox App(엔드유저 앱)** 요금이며 API 크레딧과 다를 가능성 있음. 콘솔 확인 필요.

**볼륨 할인**: 명시 문서 없음. Enterprise 계약으로만.

**비교 참고 (Soniox 자체 벤치 표에서)**
- Deepgram nova-3: $0.55/hr, AssemblyAI u3-rt-pro: $0.57/hr, Google: $0.96/hr, Azure: $1.00/hr → **Soniox async가 최저가**

출처:
- https://soniox.com/pricing
- https://soniox.com/benchmarks

---

## 6. 제약

**Async 상한**

| 항목 | 값 |
|------|-----|
| 파일 최대 길이 | **300분 (5시간)** — 증액 불가 |
| 총 파일 저장 | 10 GB |
| 저장 파일 개수 | 최대 1,000개 |
| 대기(pending) 트랜스크립션 | 100건 |
| 총 트랜스크립션 (pending+completed+failed) | 2,000건 (수동 삭제 필요) |
| 파일 최대 용량 (MB/GB) | **문서 명시 없음** (300분 제한이 사실상 상한) |
| 지원 오디오 포맷 | aac, aiff, amr, asf, flac, mp3, ogg, wav, webm, m4a, mp4 (자동 감지) |

**Real-time 상한**
- 동시 WebSocket 세션 (`transcribe_concurrent`) 상한 · TTS 별도 (`tts_concurrent`)
- 기본 숫자 문서 미공개 · 콘솔에서 확인·증액 요청
- 429 응답으로 organization vs project 어느 계층에서 걸렸는지 알림

**공통**
- 동시 요청 증액: 콘솔 요청 → 1-3영업일 검토
- 파일은 트랜스크립션 후 **자동 삭제 안 됨** — DELETE 명시 호출 필요 (우리 배선에 추가 필요)

**우리 5분 clip 관점**
- 300분 상한 여유 충분
- 100 pending / 2000 total 상한은 배치 재분석 시 주의 (일괄 처리 시 rate control 필요)
- 파일 DELETE 안 하면 10GB / 1000개에서 막힘

출처:
- https://soniox.com/docs/stt/async/limits-and-quotas
- https://soniox.com/docs/guides/concurrency-limits
- https://soniox.com/docs/stt/async/async-transcription (formats)

---

## 7. 결과 shape

**우리 배선 가정과 정확히 일치**

`GET /v1/transcriptions/{id}/transcript` 응답:
```json
{
  "tokens": [
    {
      "text": "안녕",
      "start_ms": 1240,
      "end_ms": 1580,
      "speaker": "1",
      "language": "ko",
      "translation_status": "original",
      "confidence": 0.94
    }
  ]
}
```

**주의사항**
- `speaker` 필드는 **string** (`"1"`, `"2"`), int 아님 — 우리 코드에서 캐스팅 필요
- 응답은 **토큰 단위만** — segment/utterance 단위 옵션은 async에 없음 (segment는 real-time에서만 `is_final` 플래그로 구분)
- 우리는 예능 발화 세그멘테이션을 토큰 stream에서 자체 grouping해야 함 (whisper처럼 word-level → sentence-level rebuild)
- `translation_status`: `"original"` 또는 `"translation"` — 번역 활성화 시 원문/번역 토큰이 스트림에 섞임
- `language` 필드는 `enable_language_identification: true`일 때만 채워짐

**Transcription status 폴링**
- `GET /v1/transcriptions/{id}` → `status: "pending"|"completed"|"error"` + `error_message`
- 공식 예제 폴링 간격 **1초** (webhook 대안 있음)

출처:
- https://soniox.com/docs/stt/async/async-transcription

---

## 8. 비교 자료

**Soniox 공식 벤치 (2025-2026)**

| 언어 | 데이터셋 | Soniox | 경쟁 |
|------|---------|--------|------|
| Korean | Real-world YouTube | **4.3% WER** | OpenAI Whisper 10.8% WER |
| English (real-time) | pipecat smart-turn-data-v3.1 (1000 sample, Gemini+human GT) | **1.25% semantic WER** | Azure 1.21%, Deepgram nova-3 1.71%, AssemblyAI u3 1.74%, Google 2.84%, OpenAI gpt-4o-transcribe 3.24% |
| 60 languages 종합 | YouTube | Soniox 1위 (자체 발표) | — |

**Real-time latency (자체 벤치)**
- Soniox: 249ms median TTF (P95/P99 281ms)
- 경쟁사 수치 미공개

**Diarization DER**: **공개 수치 없음** — v5 blog에서 "reinvented"만 언급하고 벤치 미제시

**3rd party 벤치 (2026-07, coval.ai)**
- Speechmatics Melia-1: 6.4% WER (선두)
- AssemblyAI U-3.5: 7.0%
- GPT-4o: 43.8% (earnings calls에서 붕괴)
- Soniox 순위는 이 리스트에 별도 표기 없음

**우리 관점 리스크**
- Soniox 자체 벤치만 존재 → self-reported bias 가능성
- 예능/드라마·다중 화자 crosstalk 벤치 없음 (뉴스·YouTube 일반)
- Korean diarization DER 무공개

출처:
- https://soniox.com/benchmarks
- https://soniox.com/compare/soniox-vs-openai/korean (검색 스니펫)
- https://soniox.com/blog/soniox-v5-async
- https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/

---

## 9. 한국 서비스 / 데이터 정책

**Region**
- 3개 region 지원: **US, EU, Japan**
- **한국 region 없음** — Japan이 최근접 (지연·컴플라이언스 관점)
- Project별로 region 지정 · region 전용 API key 발급
- 활성화는 support@soniox.com 요청

**데이터 재학습·저장**
> "No retention – Soniox does not store your audio or transcript data unless explicitly requested"
> "your audio and transcripts are never used to improve Soniox models or services"

- 기본 무보존 (async는 명시 저장 요청 시에만 보관)
- 로그는 metadata·usage stats만 — "Logs never contain raw audio or transcript content"

**컴플라이언스 인증**
- SOC 2 Type 2
- ISO/IEC 27001:2022
- GDPR
- HIPAA
- TLS 1.2+ in transit · 표준 암호화 at rest

**Data residency 예외**
- account/project metadata, usage stats, billing data는 region 밖에서 처리될 수 있음
- Business/Enterprise 계약 시 컴플라이언스 문서 별도 제공

**방송사·MCN 관점**
- 방송사 내부 오디오 처리 시 Japan region으로 pinning + no-retention 계약 활용 가능
- 다만 국내 "국외이전 동의" 조항 필요 여부는 방송사 컴플라이언스팀 사전 확인 필수
- Korea region 없는 점이 사후에 걸릴 가능성 있음 (컴플라이언스 이유로 국내 사업자 요구 방송사 존재)

출처:
- https://soniox.com/docs/security-and-privacy
- https://soniox.com/docs/data-residency

---

## 권고

**우리 use case (한국 예능 5분 clip · 다중 화자 · BGM · 웃음 · cross-talk)** 관점에서:

### 유리한 점 (Soniox 승)

1. **Korean WER 우세** — 자체 벤치 기준 Whisper 대비 2.5x. WhisperX가 사용하는 faster-whisper-large-v3도 결국 OpenAI 계열 → Soniox 우위 근거 있음
2. **Diarization 접근이 예능에 맞음** — v5 async가 "interruptions, speaker changes, laughter, overlapping speech" 명시 강화. PyAnnote 3.1의 순수 acoustic clustering 접근 대비 문맥 결합이 짧은 발화·크로스톡에 강할 근거
3. **운영 부담 완화** — WhisperX+PyAnnote 자가호스팅 (GPU VM · cuDNN · PIL 함정 · 3.1 모델 라이선스) 제거. Managed API로 전환
4. **비용 아님** — 5분에 11원. GPU VM 비용 대비 오히려 저렴할 가능성
5. **부가 기능** — `context.terms`로 프로그램 등장인물 사전 주입, per-token 언어 ID로 한/영 코드스위칭 자동 태깅 — 우리 cast_registry 파이프라인과 궁합 좋음
6. **응답 shape 일치** — 이미 배선 완료. 파라미터·model_id만 v5로 교체하면 됨

### 불리·리스크

1. **min/max_speakers 파라미터 없음** — 예능에 6명 고정이더라도 힌트 못 줌. 15명 상한은 예능에 충분하지만 유연성 부족
2. **Korean × Diarization DER 무공개** — 자체 A/B 필수. 우리 데이터셋(런닝맨·연애전쟁 등) 5-10개로 speaker error rate 실측 필요
3. **Korea region 없음** — Japan 최근접. 방송사 컴플라이언스 사전 확인 필수 (특히 KBS/MBC 같은 공영·지상파)
4. **Segment 응답 없음** — 토큰 단위만. sentence rebuild를 우리가 해야 함 (WhisperX는 이미 word→segment 병합 제공)
5. **자체 벤치 편향 가능성** — 3rd party Korean 벤치 없음. 신뢰 확보에 자체 실측 필요
6. **preview 모델 alias 종료** — 우리 `stt-async-preview` 배선은 즉시 `stt-async-v5`로 명시 전환 권고
7. **파일 자동삭제 없음** — DELETE 배선 필수 (10GB/1000개 상한 관리)
8. **`speaker` 필드 문자열** — 우리 코드가 int 가정하면 캐스팅 버그 나옴 — 확인 필요

### 결정 판단

**PoC 진행 가치 충분.** 다음 순서 권고:

1. `stt-async-preview` → `stt-async-v5`로 model_id 교체 후 우리 예능 골든셋 5개 재분석
2. 산출물의 (a) 텍스트 WER, (b) speaker error rate — WhisperX+PyAnnote 결과와 side-by-side diff 리포트 생성
3. Diarization 승부 시 채택 결정 → 방송사 컴플라이언스팀에 Japan region + no-retention 조항 확인
4. 채택 후 배선 정리: 파일 DELETE · speaker string 캐스팅 · segment rebuild 헬퍼 · 300분 초과 청크 분할

**채택 조건**: Korean speaker error rate가 PyAnnote 3.1 대비 2배 이상 개선 (같은 화자를 여러 SPEAKER로 오해하는 문제 완화) — 이게 우리가 Soniox로 이동하는 유일한 이유이므로 이 조건 미달 시 잔류.

**잔류 조건**: WER은 유사한데 diarization 개선 미미하거나, Korea region 부재로 방송사 컴플라이언스 반려 시 — WhisperX+PyAnnote 유지하며 hybrid STT (Gemini text + whisper timestamp) 노선으로 계속.
