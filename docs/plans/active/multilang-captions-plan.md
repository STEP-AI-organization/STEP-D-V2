# 다국어 자막·메타 — 실측과 구현 (1차 대상: **베트남어**)

> **2026-09-07 구현 완료 · 게이트 기본 OFF.** 켜는 법과 남은 일은 §0.
> 아래 §1~§8 은 그 결정의 근거이고, §9 는 숫자를 다시 재는 방법이다.

---

## 0. 지금 상태 — 무엇이 돌고, 어떻게 켜나

**켜는 데 두 곳이 필요하다.** 하나만 켜면 조용히 한국어가 나간다.

```
① 분석 워커 env          TRANSLATE_OUT_LANGS=vi
     → 회차 분석이 refined.vi.json 을 남기고 서버가 content_analysis.transcriptI18n 에 싣는다
② 자동배포 계획 layout    { "lang": "vi" }
     → 그 계획이 만드는 클립의 자막·제목·메타·글꼴·캡션트랙이 전부 베트남어가 된다
```

**①만 켜면**: 번역 자산만 쌓이고 배포는 한국어 그대로(₩20/회차 낭비).
**②만 켜면**: 번역이 없어 **한국어 자막이 그대로 나간다** — 발행을 막지는 않는다(의도된 degrade).

### 한 값이 바꾸는 것 (`layout.lang`)

| 무엇 | 어디서 |
|---|---|
| 자막 원문 | `resolveTranscript(mediaId, lang)` → `transcriptI18n.vi` (없으면 한국어) |
| 한 화면 글자수 | `captionMaxCharsOf` → 11자 → **16자** |
| 제목 줄바꿈 | `wrapAutoTitle` → 14/16자 → **21/24자** |
| **제목·자막 글꼴** | `snapFont` → 지마켓(1%) → **pretendard** |
| 메타 언어 | `buildMetadataPrompt({lang})` → 제목·설명·태그·해시태그 |
| 유튜브 | `snippet.defaultLanguage=vi` + `captions.insert` 자막 트랙 |
| 썸네일 폰트 | `caption_overlay.py` `LANG_FONT_FALLBACK` |

### 실측 (2026-09-07 · Vertex 실호출 10줄)

- 번역 품질 정상. **고유명사 원문 유지 확인** — `Chị 박나래` · `"나 혼자 산다"`
- **화면 수 10줄 중 9줄 유지** (1줄만 1자 초과로 2줄). 길이 제약이 실제로 먹는다
- `words` 제거 · `text_ko` 보존 · 타임스탬프 승계 · **입력 원본 불변** 전부 확인
- 소요 10줄 18.8초 → 925줄 환산 **약 30초/언어**(배치 60·워커 2)

### 아직 안 한 것

- **UI 가 없다.** 자동배포 화면에 언어 선택이 없어 지금은 `layout.lang` 을 API 로만 넣는다.
- **회차 전체 번역 스모크 미실시.** 10줄만 실호출했다 — 925줄 원가·소요는 여전히 §5 의 추정이다.
- 네이버·틱톡·인스타는 번인만 된다(트랙 API 가 없다). 유튜브 캡션 트랙만 구현.
- 일본어·중국어는 폰트 번들이 선행이다(§3.5-1 · 베트남어는 필요 없었다).

---

# 근거 — 실측과 도입 계획

> 2026-09-07 작성. 코드를 읽고 쓴 것이며, **비용·시간은 추정(미실측)** 이다.
> 실측하는 법은 §7 에 적었다. 원가를 인용할 땐 그 절차를 먼저 밟을 것.
> **단, §3.5 의 폰트·글자폭은 추정이 아니라 실측이다** — 폰트 cmap/hmtx 를 직접 읽고
> libass 로 실제 렌더까지 확인했다.

---

## 1. 지금 자막이 어떻게 만들어지고 어디에 박히나

한 줄로: **한국어 하나만 만들어서, 영상에 구워 넣는다.** 갈래가 없다.

```
[core] stt/asr.py  language="ko"  (프로덕션 soniox)
   → refined.json  { start, end, text, words[], speaker }
   → [core] stt/translate.py       ← ⚠️ 방향이 반대다: 외국어 → 한국어
   → content_analysis.transcript (JSONB)
        │
        ├─ [server] windowCaptions(transcript, start, end)      index.ts:4915
        │     클립 구간으로 자르고, 경계 걸친 문장은 텍스트도 비율로 자른다
        ├─ [server] chunkCaption / caption-chunk.ts
        │     CAPTION_CHUNK_MAX_CHARS = 11  ← 한 화면 11자 (9:16 한국어 기준)
        ├─ [server] buildEditorAss(...)                          index.ts:5229
        │     ASS 이벤트 생성 · 폰트 = ASS_FONT_BY_ID (index.ts:5525)
        └─ [server] ffmpeg.ts  libass 번인
              assLayers = [decorationAssPath, assPath, captionAssPath]
```

배포는 그 구워진 파일 하나를 그대로 올린다 — `uploadVideoResumable`(youtube.ts:481)이
`part=snippet,status` 로 제목·설명·태그만 실어 보낸다.

### 이미 있는 것 (재사용 가능)

| 것 | 위치 | 다국어에 쓸 수 있나 |
|---|---|---|
| 번역 배치 골격 | `core/stt/translate.py` (187줄) | **그대로** — 배치 80줄·워커 2·재실행 안전 플래그·실패 시 원문 유지 |
| 스테이지 배선 | `core/analyze_stages.py:286` `run_translate` · env `RUN_TRANSLATE_KO` | **그대로** — 같은 자리에 언어별 스테이지를 붙인다 |
| 단어 타이밍 없을 때 메꾸기 | `synthesizeWords` (index.ts:4973) | **그대로** — 번역줄엔 `words` 가 없는데 이게 균등분배로 채운다 |
| 자막 구간 자르기 | `windowCaptions` | 언어 무관 — 타임코드만 쓴다 |

### 없는 것

- 언어 축이 **아예 없다.** transcript 는 배열 하나고, 어느 컬럼에도 `lang` 이 없다.
- `captions.insert`(유튜브 캡션 트랙 업로드) 호출부가 없다.
- 다국어 제목·설명(`localizations`)을 실어 보내는 자리가 없다.
- TTS 는 `ko-KR-Neural2-A` 하드코딩(`media/tts.ts`) — 더빙까지 갈 거면 별건.

---

## 2. 결정적 사실 — 유튜브는 **재동의가 필요 없다**

현재 발행 스코프는 `youtube.upload` + `youtube.force-ssl` 이다
(`youtube-scopes.test.ts:45` 가 이 둘로 고정).

**`captions.insert` 와 `videos.update(localizations)` 가 요구하는 스코프가 정확히
`youtube.force-ssl` 이다.** 즉 유튜브 다국어 자막 트랙과 다국어 제목·설명은
**지금 토큰으로 바로 된다** — 고객사 재연동 없이.

2026-08-25 에 동의 스코프를 `youtube.upload` 로 좁힌 게 여기서 손해를 안 냈다.

---

## 3. 갈림길 — 하드섭이냐 소프트섭이냐 (둘 다 필요하다)

| | 소프트섭 (캡션 트랙) | 하드섭 (언어별 번인) |
|---|---|---|
| 렌더 | **0회 추가** | 언어당 1회 |
| 유튜브 롱폼·편집본 | ✅ 시청자가 언어 고름 | 불필요 |
| 유튜브 쇼츠 | △ 기본 노출이 아님 | ✅ **이것 말곤 방법 없음** |
| 네이버 | ❌ 공개 API 없음(Playwright) | ✅ |
| 틱톡·인스타 | ❌ 우리 경로에 트랙 API 없음 | ✅ |
| 추가 원가 | 번역비만 | 번역비 + 렌더 + 저장 |

**우리 제품의 목적물은 숏폼이다.** 소리 끄고 스크롤하는 면에서 캡션 트랙은 사실상 안 읽힌다.
그래서 **둘 다 한다** — 다만 순서가 있다. 소프트섭이 훨씬 싸고 빨리 나가므로 먼저.

---

## 3.5. 베트남어 실측 (2026-09-07 · 추정 아님)

1차 대상이 베트남어로 정해졌다. 베트남어는 라틴이지만 성조가 **이중으로 쌓이는**
Latin Extended Additional(U+1EA0–U+1EF9) 90자를 쓴다 — 한글 폰트 대부분이 안 덮는 구간이다.
그래서 짐작하지 않고 폰트 파일의 cmap 을 직접 읽고, libass 로 실제 렌더까지 했다.

### (1) 폰트 커버리지 — 번들 11개 파일 cmap 실측

검사 문자 134자(Latin-1 보충·확장A/B 44자 + U+1EA0–1EF9 90자):

| 폰트 | 커버 | 판정 |
|---|---|---|
| **Pretendard** (Black·Bold·ExtraBold) | **100%** | ✅ **기본 자막 폰트가 이미 완전 지원** |
| **GothicA1** (Black·Bold) | **100%** | ✅ 대안 |
| Paperlogy-8ExtraBold | 25% | ❌ 100자 없음 |
| Recipekorea · GangwonEduModu | 1% | ❌ 133자 없음 |
| BlackHanSans · DoHyeon · Jua | **0%** | ❌ 134자 전부 없음 |

**→ 베트남어 폰트 작업은 0이다.** 기본 스타일이 `Pretendard ExtraBold`(index.ts:5458)라
그대로 나간다. Noto 번들도, Dockerfile 수정도, fc-cache 도 필요 없다.

**⚠️ 대신 가드가 필요하다.** `ASS_FONT_BY_ID` 9종 중 **7종이 베트남어에서 두부(□)** 다.
사용자가 편집기에서 글꼴을 "블랙한산스"나 "주아"로 바꾸면 베트남어 자막이 통째로 깨진다.
libass 는 **말없이 대체하거나 두부를 찍는다** — 오류가 안 난다. 언어별 허용 글꼴을
`pretendard`·`gothica1` 로 제한하고, 나머지를 고르면 화면에서 막거나 경고할 것.

### (2) 실제 렌더 검증 — libass 통과

1080×1920 에 프로덕션과 같은 스타일(`Pretendard ExtraBold` · Outline 4 · ScaledBorderAndShadow)로
구워 확인했다:

- 이중 성조 `ẫ ẵ ỗ ỡ ữ ẩ ẳ ổ ở ử` — **위쪽 잘림 없음**
- 아래점+모자 `ậ ệ ộ ợ ự ặ ạ ọ ụ ị` — **아래쪽 잘림 없음**
- 대문자 `ẪẴỖÕỮ ẬỆỘỢỰ ĐĂÂÊÔƠƯ` — 정상 (다만 폭이 커서 화면을 꽉 채운다)
- 검은 외곽선이 **성조 부호에도 제대로 붙는다**
- 한국어와 같은 줄에 섞여도 같은 폰트라 **글꼴이 안 튄다**
- 두부(□) **0개**

→ 렌더 파이프라인은 손댈 게 없다. ASS·libass·외곽선 전부 그대로 통과.

### (3) 글자 폭 — 여기에 실제 버그가 있다

Pretendard-ExtraBold hmtx 실측 advance:

| 문자 부류 | 평균 advance |
|---|---|
| 베트남어 소문자(성조) | **0.585em** |
| 베트남어 대문자(성조) | 0.712em |
| 베트남어 기본자 `ăâđêôơư` | 0.675em |
| (비교) 라틴 소문자 | 0.552em |
| (비교) 한글 | 0.864em |

**`charWidthEm()`(index.ts:4779)이 베트남어를 `0.9em` 으로 준다.** 모든 분기를 빠져나가
마지막 `return 0.9` 로 떨어지기 때문이다. 실제 0.585em 대비 **1.54배 과대평가** —
줄이 있지도 않은 곳에서 접힌다.

**`CAPTION_CHUNK_MAX_CHARS = 11` 은 한국어 폭 기준이다.** 11자 × 0.864em = 9.5em.
베트남어를 같은 9.5em 폭에 채우려면 **약 16~18자**다. 11자 그대로 쓰면
**화면 폭의 44% 만 쓰고** 자막이 쓸데없이 여러 줄로 쪼개진다.

### (4) 번역문 길이 팽창

같은 뜻 한 문장 실측:

```
한국어   "그건 진짜 말도 안 되는 상황이었어"                    19자 · 13.2em
베트남어 "Đó thực sự là một tình huống không thể tin được"   47자 · 23.1em
         글자 수 2.5배 · 실제 폭 1.75배
```

노출 시간은 같은데 폭이 1.75배다. **번역 프롬프트의 길이 제약이 선택이 아니라 필수**인 이유다.
"원문 표시폭을 넘기지 말 것 · 넘치면 뜻을 줄여서라도 짧게" 를 못 박고,
넘친 줄은 후처리에서 잡는다.

### (4.5) ⚠️ 자막은 안전한데 **제목과 썸네일이 깨진다**

"메타데이터까지 싹 다 언어 변경"이면 표면이 자막 하나가 아니다. 한국어가 나가는 자리를
전부 훑고 각 자리의 폰트를 실측했다:

| 표면 | 기본 글꼴 | 베트남어 커버 | 판정 |
|---|---|---|---|
| 영상 **자막** | `Pretendard ExtraBold` | **100%** | ✅ 안전 |
| 영상 **제목 줄**(`titleLines`) | **`gmarket`** (factory.ts:786) | **1%** | ❌ **깨짐** |
| **썸네일 자막** | **`BlackHanSans`** (caption_overlay.py:17) | **0%** | ❌ **두부 □** |
| 채널명·부가줄·요소·훅 자막 | 스타일 상속 | — | 제목과 같은 위험 |

**(a) 제목 — 자동배포 기본 글꼴이 지마켓 산스다.**
`factory.ts:786` 이 `font: titleFont || "gmarket"` 으로 굽는다(고객사 지정 2026-08-28).
지마켓 산스는 베트남어 134자 중 **133자가 없다.**

실제로 구워 보면 **두부가 안 나온다 — 그게 더 나쁘다.** libass 가 fontconfig 폴백으로
**말없이 다른 폰트(Noto 계열)로 대체**해서, 얇고 둥근 글씨로 조용히 발행된다.
오류도 경고도 없다. 게다가 자막은 Pretendard 라 정상이므로 **한 영상 안에서 제목만
글꼴이 다르게** 나간다. 발행하고 나서야 안다.

> 이건 코드 주석(index.ts:5522)이 이미 경고하던 그 함정이다 —
> "별칭을 쓰면 libass 가 말없이 Noto 로 대체해 *글꼴을 바꿨는데 결과물은 그대로* 가 된다."
> 베트남어에서는 같은 메커니즘이 **글꼴을 안 바꿨는데 결과물이 달라지는** 쪽으로 터진다.

**대응**: 베트남어 렌더에서는 제목 글꼴을 `pretendard` 또는 `gothica1` 로 **강제 스냅**한다
(둘 다 100% · 굵기도 제목용으로 충분). 지마켓 브랜드 룩을 유지해야 하면 베트남어를 덮는
굵은 폰트(Be Vietnam Pro 등)를 별도 번들해야 하는데, 그건 고객사 브랜드 결정 사항이다.

**(b) 썸네일 — Pillow 는 폴백조차 안 한다.**
`core/thumbnail/caption_overlay.py:17` 의 `DEFAULT_FONT = "BlackHanSans-Regular.ttf"` 는
베트남어 **0%** 다. 프리셋 4종 중 `Pretendard-Bold.otf` 만 안전하고
`BlackHanSans`·`Jua` 는 0% 다. **Pillow 는 libass 와 달리 대체 폰트를 안 찾고 두부(□)를
그대로 그린다** — 이쪽은 눈에 확 띄게 깨진다.

**(c) 제목 줄바꿈도 한국어 기준이다.**
`wrapAutoTitle`(factory.ts:621)의 `text.length <= 14` · `budget = 16` 은 한국어 폭 기준이다
(14자 × 0.864 = 12.1em). 베트남어는 0.585em/자라 같은 폭이 **약 21자**다 —
그대로 두면 제목이 불필요하게 2줄로 접힌다.

**(d) 안전한 것 하나**: `cleanOverlayText`(factory.ts:613)는 `!` `.` `,` 만 지운다.
베트남어 성조는 precomposed 문자(U+1EA0~)라 **안 건드린다.** 확인 완료.

### (4.55) 그래서 어떤 글꼴을 쓸 것인가 — 후보 실측

지마켓이 못 쓰게 됐으니 대체가 필요하다. 후보를 받아 **베트남어와 한글을 같이** 쟀다.
한글을 같이 재는 이유: **베트남어 영상에도 한국어가 남는 자리가 있다** —
프로그램명·등록 캐스트 인물명·채널명은 고유명사라 번역하지 않는 게 보통이다.

| 폰트 | 베트남어 | 한글 | ASS Fontname | 비고 |
|---|---|---|---|---|
| **Pretendard ExtraBold** | **100%** | **100%** | `Pretendard ExtraBold` | **이미 번들** · 현재 자막 글꼴 |
| **Gothic A1 Black** | **100%** | **100%** | `Gothic A1` | **이미 번들** |
| Be Vietnam Pro Black (OFL) | 100% | **0%** | `Be Vietnam Pro Black` | 새로 받아야 함 |
| Montserrat (OFL) | 100% | **0%** | `Montserrat Thin` ⚠️ | **variable font — 쓰지 말 것** |
| 지마켓 산스 Bold | **1%** | 100% | `G마켓 산스 TTF Bold` | 현재 제목 기본 |
| Black Han Sans | **0%** | 100% | `검은고딕` | 현재 썸네일 기본 |

**혼합 줄을 실제로 구워 확인했다.** `박나래 nói thế này` 를 Be Vietnam Pro 로 구우면
베트남어는 Black(900) 굵기인데 **한글만 얇은 폴백 폰트로 튄다** — 한 줄 안에서 굵기가
달라 보기 흉하다. Pretendard·Gothic A1 은 한 줄이 균일하다.

**→ 권장: `pretendard` 또는 `gothica1`.**
둘 다 이미 `assets/fonts/` 에 있고 Dockerfile 이 이미 복사한다 —
**폰트 추가 작업·이미지 재빌드가 0이다.** 베트남어 렌더에서 제목 글꼴을 이 둘로 스냅하면 끝.

**Be Vietnam Pro 를 굳이 쓴다면** 조건이 붙는다 — 베트남어 전용 브랜드 룩이 꼭 필요하고,
그 화면에 **한국어 고유명사를 절대 안 쓰는** 경우에만. 그렇지 않으면 위 굵기 불일치가 난다.
(라이선스는 OFL 이라 영상 임베드·상업적 사용 자체는 문제없다.)

⚠️ **variable font 는 쓰지 말 것.** Montserrat 을 받아 보니 `name` 테이블 nameID 1 이
`Montserrat Thin` 으로 잡힌다 — ASS 는 웨이트 축을 지정할 수 없어 **가장 얇은 인스턴스로
그려진다.** 새 폰트를 넣을 땐 반드시 **static 웨이트 파일**을 받고,
`caption-font.test.ts` 방식으로 name 테이블에서 패밀리명을 읽어 `ASS_FONT_BY_ID` 에 적을 것.

### (4.6) 번역하면 안 되는 것

**커머스 대가성 문구는 번역 금지다.**
`commerce/commerce.ts:76` 의 `"이 포스팅은 쿠팡 파트너스 활동의 일환으로..."` 는
같은 파일 주석이 못 박은 대로 **우리가 짓지 않는다 — 제공자가 명시한 원문 그대로**다.
법적 고지라 임의 번역이 곧 규정 위반이 될 수 있다. 쿠팡이 베트남어 문구를 별도로
제공하기 전까지는 **한국어 원문을 그대로 둔다.**

(같은 이유로 검토가 필요한 것: 저작권·출처 표기, 채널 고정 문구.)

### (5) 베트남어라서 안 생기는 문제

- STT 는 그대로 한국어다 — 번역만 추가된다(`asr.py` 무수정).
- RTL 아님 → 정렬·박스 규격 그대로.
- 유튜브 캡션 트랙 언어코드는 `vi` 하나뿐(중국어의 `zh-Hans`/`zh-Hant` 같은 분기 없음).
- 단어 사이 공백이 있어 기존 어절 단위 자르기(`windowCaptions` 의 토큰 비율 절단)가
  **그대로 동작한다** — 일·중이었으면 이게 깨진다.

---

## 4. 3층으로 나눈 계획

### Layer 0 — 번역 자산 (모든 것의 전제)

회차 자막을 언어별로 만들어 저장한다. 이게 있어야 Layer 1·2 가 성립한다.

- `core/stt/translate.py` 를 **방향만 뒤집어** `translate_out.py` 로 (한국어 → 대상 언어).
  기존 파일은 건드리지 않는다 — 외국어→한국어는 지금도 필요한 기능이다.
- 산출: `refined.{lang}.json` → 서버가 `transcript_i18n` (새 JSONB 또는 새 테이블 `transcript_lang`)
- `RUN_TRANSLATE_OUT=en,ja` 처럼 env 로 대상 언어 지정. **미설정 = 아무것도 안 한다**(게이트 기본 OFF).
- 실패는 **그 언어만 빠지고** 나머지·원문은 그대로 (translate.py 의 열화 방식 그대로).

**⚠️ 자막 번역은 문서 번역과 다르다 — 프롬프트에 길이 제약이 필수.**
한국어→영어는 글자 수가 대략 1.5~2배가 된다. 9:16 화면에서 2줄이 3줄로 넘친다.
"원문 표시길이를 넘기지 말 것 · 넘치면 뜻을 줄여서라도 짧게" 를 프롬프트에 못 박는다.
이게 빠지면 Layer 2 의 줄바꿈 규격을 아무리 손봐도 화면이 무너진다.

### Layer 0.5 — 메타데이터 **언어화** (번역이 아니라 생성)

"메타데이터까지 싹 다" 의 본체다. 그리고 여기가 자막과 접근이 다르다.

**제목·설명·해시태그는 번역하지 않는다 — 처음부터 베트남어로 생성한다.**
자막은 원문 발화가 있으니 번역이 맞지만, 어그로 제목은 언어마다 관용이 다르다.
한국어 클릭베이트(`?!·…·경악·인용문` — 2026-07-28 확정 톤)를 직역하면 베트남어에선 안 먹힌다.

다행히 **생성이 한 곳으로 모여 있다** — `pipeline/clip-metadata.ts:258 buildMetadataPrompt()`.
`generate-metadata` 라우트(index.ts:9285)와 `regenerate-titles`(9056)가 둘 다 이걸 쓴다.
여기에 `lang` 을 받아 출력 언어 지시만 붙이면 `title` · `description` · `tags` · `hashtags` 가
전부 베트남어로 나온다. **추가 호출이 없어서 원가도 그대로다**(커머스 상품 쿼리를 같은
호출에서 뽑는 것과 같은 구조).

프롬프트에 같이 넣어야 하는 것:
- 제목 **표시폭 상한** (§3.5-3 — 베트남어는 폭이 다르다)
- 고유명사 처리 규칙 — 프로그램명·등록 캐스트 이름은 **번역하지 않고 원문 유지**
  (`cast-registry-primary` 원칙: 인물 라벨링의 정본은 등록 캐스트다)
- `#Shorts` 보장은 그대로

### Layer 1 — 유튜브 소프트섭 (재동의 0 · 렌더 0)

1. `youtube.ts` 에 `insertCaptionTrack(accessToken, videoId, lang, srt)` 추가
   → `POST https://www.googleapis.com/upload/youtube/v3/captions?part=snippet`
2. `uploadVideoResumable` 의 `part` 를 `snippet,status,localizations` 로 넓히고
   `meta.localizations` 를 실어 보낸다 (제목·설명 다국어).
3. 발행 성공 직후 언어 수만큼 캡션 트랙을 올린다. **업로드 게이트 안쪽**에 둘 것 —
   `assertUploadEnabled()` 를 통과한 경로에서만.
4. 실패해도 **영상 발행은 성공으로 둔다**(캡션은 나중에 재시도 가능). 별도 잡으로 빼는 게 안전.

### Layer 2 — 숏폼 하드섭 (언어당 렌더 1회)

여기가 진짜 일이다. 세 가지가 언어마다 달라야 한다.

**(a) 한 화면 글자 수.** `CAPTION_CHUNK_MAX_CHARS = 11` 은 **한국어 폭 기준 상수**다
(11 × 0.864em = 9.5em). 베트남어는 0.585em/자라 같은 폭이면 **16~18자**다 — 11자로 두면
화면의 44%만 쓴다(§3.5-3). 언어별 폭 표를 두고, 겸사겸사 `charWidthEm()` 의
베트남어 폴백 0.9em → 0.585em 도 고친다(**이건 언어 기능과 별개인 기존 버그**다).
⚠️ **이 함수는 쌍둥이다** — `apps/server/src/media/caption-chunk.ts` 와
`apps/web/.../presets.ts::chunkCaption` 이 같은 규칙을 두 벌 갖고 있고
`overlay-parity.test.ts` 가 둘을 묶어놨다. **한쪽만 고치면 테스트가 빨개진다. 같이 고칠 것.**

**(b) 폰트.** **베트남어는 §3.5 실측대로 작업 0이다** — 기본 Pretendard 가 100% 덮고
렌더도 통과했다. 할 일은 **추가**가 아니라 **제한**이다: 9종 중 7종이 두부라
언어별 허용 글꼴을 `pretendard`·`gothica1` 로 묶는 가드를 넣는다.
(뒤에 일·중을 하면 그때는 Noto Sans JP/SC 번들 + Dockerfile fc-cache +
`caption-font.test.ts` 대조 추가가 선행 작업으로 붙는다. 아랍어·히브리어는 우리 정렬·박스
규격이 LTR 전제라 범위 밖.)

**(c) 렌더 산출물의 갈래.** 지금 클립 1개 = 파일 1개다. 언어별 파일을 어디에 매달지
정해야 한다 — `clip.render` 잡에 `lang` 을 받고 `clips.renders[lang]` 로 두는 게 가장 작다.
⚠️ **원본은 한 번만 받아 N개를 굽는다.** 언어마다 잡을 따로 던지면 GCS egress 가 N배 난다(§5).

**(d) 제목 글꼴 스냅.** §4.5-(a)·§4.55 대로, 베트남어면 `titleFont` 를 `pretendard`/`gothica1`
로 강제한다. `factory.ts:786` 의 `titleFont || "gmarket"` 폴백이 그대로 흐르면 제목이
조용히 다른 폰트로 나간다. **여기가 이 기능에서 가장 조용히 터지는 자리다.**

**(e) 썸네일.** `core/thumbnail/caption_overlay.py:17` 의 `DEFAULT_FONT` 가 BlackHanSans(0%)라
베트남어면 두부가 찍힌다. 프리셋 4종 중 `Pretendard-Bold.otf` 만 안전 — 언어별 프리셋 제한이 필요하다.
**Pillow 는 libass 와 달리 폴백을 안 한다** — 실패가 눈에 확 보이는 건 그나마 다행이다.

**(f) 그 밖에 한국어가 굽히는 자리** — 채널명·부가줄(`channelExtraLines`, index.ts:5080),
자유 요소(`el.text`, 5353), 훅 자막(`buildHookCaptionAss`, 5475), 시간박스(BoxLabel).
전부 같은 글꼴 위험을 공유한다. 번역 여부는 자리마다 사람이 정해야 한다
(채널명은 보통 안 바꾸고, 훅 자막은 바꾼다).

---

## 5. 추정 비용·시간 (⚠️ 미실측)

기준: 58.6분 회차 · 자막 925줄 (CLAUDE.md 실측치) · gemini-2.5-flash-lite · ₩1,400/USD

### 번역 (Layer 0)

| 항목 | 값 |
|---|---|
| 입력 토큰 | 925줄 × ~25자 ÷ 1.2 + 배치 프롬프트 12회 ≈ **22,000** |
| 출력 토큰 | ≈ **25,000** (영어는 토큰이 더 나온다) |
| 단가 | in $0.10/M · out $0.40/M |
| **언어당 · 회차당** | **≈ ₩20** |
| 3개 언어 | **≈ ₩60** — 회차 원가 ₩800 대비 **+7.5%** |
| 소요 | 12배치 ÷ 워커2 × ~4초 ≈ **언어당 30초** · 3개 병렬 ≈ **+1분** |

**번역은 사실상 공짜다.** 이게 이 계획의 핵심 근거다.

### 렌더 (Layer 2)

| 항목 | 값 |
|---|---|
| 렌더 1건 | 50~90초 (기존 실측) |
| Cloud Run `stepd-render` 기준 | 4vCPU×70s + 8GiB×70s ≈ **₩11/건** |
| 윈도우2 기준 | **₩0** (CPU만 쓰는 잡 · 원본을 GCS 에서 안 받아오는 경우) |
| 회차당 쇼츠 20개 × 추가 2개 언어 | 40건 ≈ **₩440** 또는 윈도우2 직렬 **~47분** |
| 저장 | 40개 × 15MB = 600MB ≈ **₩17/월** |

**⚠️ 원본을 GCS 에서 받아와야 하면 윈도우2 는 공짜가 아니다** — egress ₩165/GB 가 새로 붙는다
(CLAUDE.md: 270MB 원본 기준 WIN2 ₩45 vs Cloud Run ₩14). 언어별 렌더는 **같은 원본을 N번**
쓰므로 한 번 받아 N개를 굽는 배치 형태여야 한다. 언어마다 잡을 따로 던지면 egress 가 N배 난다.

### 결정이 필요한 것 — 크레딧

배포 1건 = 3크레딧(₩180 공급가)이다. 같은 클립의 3개 언어 변형을 **3건으로 셀 것인가.**
비용이 아니라 **가격 정책**이라 사람이 정해야 한다. (분석 크레딧은 안 늘어난다 — 번역은
같은 회차 안이고 ₩20 이라 분당 단가에 안 잡힌다.)

---

## 6. 권하는 순서

| 단계 | 내용 | 추가 원가 | 재동의 | 규모 |
|---|---|---|---|---|
| **1** | Layer 0 — 한국어→**베트남어** 자막 번역 자산 | ₩20/회차 | 불필요 | core 1파일 + 서버 저장 |
| **1.5** | Layer 0.5 — 메타 **생성 언어화**(`buildMetadataPrompt` 에 lang) | **₩0** | 불필요 | 프롬프트 1곳 |
| **2** | Layer 1 — 유튜브 `vi` 캡션 트랙 + 베트남어 제목·설명 | ₩0 | **불필요** | youtube.ts + 발행 경로 |
| **3** | Layer 2 — 하드섭 (자막·제목·**글꼴 스냅**·썸네일) | ₩11/렌더 | 불필요 | chunk 폭 쌍둥이 + 글꼴 가드 + 렌더 갈래 |
| **4** | (뒤에) 언어 확장 일·중 | ₩20/언어 | 불필요 | **Noto 폰트 번들 선행** |

**언어를 어디서 고르나 (설계 결정)**: 자동배포 계획(`automation_rule`)에 언어 필드를 두는 게
가장 자연스럽다 — 템플릿·종횡비·슬롯을 이미 거기서 고르고 있고, `factory.ts` 가 그 값을 받아
`editorState` 를 만드는 경로가 이미 있다. 워크스페이스 기본값 → 계획별 덮어쓰기 순.

**1→2 만 해도 유튜브에선 베트남어 자막이 실제로 붙는다.** 렌더를 하나도 안 늘리고,
고객사 재연동도 없고, 회차당 ₩20 이다. 여기서 반응을 보고 3 으로 가는 게 맞다.

**베트남어가 1차로 좋은 이유(실측 근거):** 폰트가 이미 100% 덮고(§3.5-1) 렌더가 통과했고
(§3.5-2) RTL 이 아니며 어절 공백이 있어 기존 자르기 로직이 그대로 산다(§3.5-5).
일본어·중국어로 시작했으면 폰트 번들·Dockerfile·테스트 대조가 선행 작업으로 붙었을 것이다.

사람 몫 / 자동 몫 (원칙: `human-vs-auto-boundary`)
- **사람**: 번역문 검수 여부 · 크레딧 정책 · 예능 말맛(어그로 톤)을 베트남어로 어디까지 옮길지
- **자동**: 번역·청킹·ASS 생성·트랙 업로드 전부

---

## 7. 이 숫자를 실측하는 법

§5 는 전부 **계산이지 실측이 아니다.** 인용하기 전에:

1. Layer 0 를 한 회차에 돌리고 `usage.json` 의 토큰 실측을 본다
   (core 가 회차마다 남기고 서버가 `usage_events.cost_krw` 에 넣는다 · `cost_source='measured'`).
2. `GET /api/superadmin/usage` → `totals.costPer60minKrw` 가 번역 전후로 얼마나 움직이는지 본다.
3. 렌더는 `clip.render` 잡의 실제 소요를 큐에서 읽는다.

⚠️ 이 리포는 원가를 네 번 틀렸고 뿌리가 매번 같았다 — **안 돈 스테이지를 0 으로 셌거나
프로덕션이 그걸 켰다고 짐작했다.** 번역은 게이트 기본 OFF 로 들어가므로,
"다국어 켠 원가"를 말할 땐 `RUN_TRANSLATE_OUT` 이 실제로 켜져 있었는지부터 확인할 것.

---

## 8. 손대는 파일

```
core/stt/translate_out.py            (신규 · translate.py 골격 복제 · 방향 반대)
core/analyze_stages.py               run_translate_out 추가 (기존 run_translate 옆)
core/analyze.py                      스테이지 호출 (196~198 근처)
apps/server/src/db-pg.ts             transcript_i18n 저장·조회
apps/server/src/youtube.ts           insertCaptionTrack 신규 · uploadVideoResumable part 확장
apps/server/src/publish/*            발행 후 캡션 트랙 잡 큐잉 (게이트 안쪽)
apps/server/src/pipeline/clip-metadata.ts  buildMetadataPrompt(lang) — 제목·설명·태그·해시태그
apps/server/src/pipeline/factory.ts        titleFont 글꼴 스냅(gmarket 금지) · wrapAutoTitle 폭
apps/server/src/media/caption-chunk.ts   언어별 폭 표
apps/web/src/.../presets.ts          ↑ 쌍둥이 — 반드시 같이
core/thumbnail/caption_overlay.py    DEFAULT_FONT 언어별 (BlackHanSans 는 베트남어 0%)
apps/server/src/commerce/commerce.ts **건드리지 말 것** — 대가성 문구는 원문 유지
apps/server/src/index.ts             buildEditorAss 에 lang 전달
                                     charWidthEm() 베트남어 0.9→0.585em (기존 버그)
                                     ASS_FONT_BY_ID 언어별 허용 글꼴 가드
apps/server/src/tests/               overlay-parity · caption-font 갱신
assets/fonts/                        (4단계 일·중에만) Noto Sans JP/SC + Dockerfile fc-cache
                                     ← **베트남어에는 필요 없다**
```

## 9. 실측에 쓴 도구

`charWidthEm` 이나 폰트 커버리지를 다시 재야 하면 스크립트를 새로 짜지 말고 이 방법을 쓴다:

- **폰트 커버리지**: sfnt 테이블에서 `cmap`(format 4/12)을 읽어 코드포인트 Set 을 만든다.
  `caption-font.test.ts` 에 이미 같은 방식의 `name` 테이블 파서가 있으니 그 옆에 붙이면 된다.
- **글자 폭**: `head`(upem) + `hhea`(numberOfHMetrics) + `hmtx` + cmap 의 char→gid.
  advance = `hmtx[gid] / upem`. **.otf(CFF)도 이 테이블들은 같다.**
- **렌더 확인**: `ffmpeg -f lavfi -i color=...:s=1080x1920 -vf "ass=x.ass:fontsdir=fonts" -frames:v 1 out.png`
  ⚠️ Git Bash 에서는 `fontsdir` 절대경로가 MSYS 변환에 깨진다 — 폰트를 작업 폴더에 복사하고
  **상대경로**로 주거나 PowerShell 에서 실행할 것.
