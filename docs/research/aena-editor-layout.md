# AENA 에디터 레이아웃 이식 계획 (copy-this)

> 2026-08-19 · read-only 조사. 코드 변경 없음. 목적: **STEP-D 에디터 레이아웃을 AENA 에디터에
> 최대한 충실히 베낀다** ("aena 레이아웃 잘 베껴봐"). **레이아웃/배치/시각 구조**만 다룬다 —
> 기능(undo·타임라인·트랜스크립트 등)은 이미 STEP-D 가 더 풍부하므로 **회귀시키지 않는다**.

관련 문서: [aena-feature-adoption.md](aena-feature-adoption.md) · [editor-ux-audit.md](editor-ux-audit.md)

---

## 0. 무엇을 베끼나 — AENA 에디터는 둘이다

| | 경로 | 상태 | 성격 |
|---|---|---|---|
| **v1** | `aena/src/app/(editor)/studio/editor/[id]/page.tsx` (1500줄) | **완성·프로덕션** | 3열 리사이즈 + 하단 풀너비(트랜스포트+타임라인+트랙) |
| v2 | `aena/src/app/(editor)/studio/editor-v2/[id]/page.tsx` (389줄) | 스켈레톤(2026-07-27, "다음 단계" 자리표시자) | 프리미어식 3열 고정 그리드 + 하단 타임라인 |

**정본은 v1이다** (완성도·폴리시가 있는 쪽). v2는 "프리미어 3-panel + 하단 풀너비 타임라인"이라는
*방향*만 참고한다(고정 grid). 아래 계획은 v1을 기준으로 하고, v2의 헤더/그리드 아이디어는 보조로만 쓴다.

---

## 1. 레이아웃 다이어그램 — AENA v1 vs STEP-D 현재

### AENA v1 (`editor/[id]/page.tsx:836-1346`)

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER  h-12  (editor-toolbar.tsx:27)                                  │
│  ← 목록  제목        [현재 0:12 / 3:40  IN 0:05  OUT 0:20]   저장됨✓ ? │  ← 3-zone justify-between, 시간은 중앙
├───────────────┬──────────────────────────────┬───────────────────────┤
│ LEFT  30%     ║          CENTER 50%          ║   RIGHT 20%            │  ← ResizablePanels(드래그 핸들 6px)
│ min15 max40   ║   min30   bg-BLACK  p-2      ║   min12 max30         │
│ bg-zinc-900   ║                              ║   bg-zinc-900         │
│               ║   ┌────────────────────┐     ║  [편집(3)][인코딩(2)] │  ← 세그먼트 pill 탭
│ [분석|클립|쇼츠]│   │   PreviewFrame     │     ║  ┌──────────────────┐ │
│  underline 탭  ║   │  (고정 target px + │     ║  │☑ 쇼츠 제목 …   삭제│ │  ← 클립 리스트+체크박스
│  ┌──────────┐ ║   │   scale transform) │     ║  │  2구간 · 0:48    │ │
│  │0:05~0:20 │ ║   │   video+overlay    │     ║  └──────────────────┘ │
│  │장면 설명 │ ║   └────────────────────┘     ║  ┌──────────────────┐ │
│  │[인물칩]  │ ║                              ║  │ 선택 인코딩(2개) │ │  ← 하단 CTA
│  └──────────┘ ║   (오버레이 선택 시 →         ║  └──────────────────┘ │
│   카드 스크롤  ║    fixed 드래그 속성패널      ║                       │
│               ║    w-72 가 여기 떠 있음)      ║                       │
├───────────────┴──────────────────────────────┴───────────────────────┤
│ BOTTOM  (고정, 풀너비)  border-t  bg-zinc-900  px-[5%] py-3            │
│  ▶ [I][O] Esc +구간 T이미지 ▶구간재생  속도0.5/1/1.5/2  비율…   [Space재생 I/O마크 …]│ ← 트랜스포트 + kbd 범례(ml-auto)
│  ─── zoom −/x/+/fit ───  [═══ 64px 타임라인 트랙: 눈금·세그먼트·IN/OUT·플레이헤드▲ ═══] │
│  ┌ 트랙 카드 (max-h-30vh 스크롤): 라벨 · 세그먼트 칩[1.48초][2.12초] · ✕ ┐          │
└──────────────────────────────────────────────────────────────────────┘
```

### STEP-D 현재 (`editor-shell.tsx:753-983`)

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER  h-14  (editor-shell.tsx:755)                                   │
│  ← 나가기   제목(flex-1 truncate) ……………   메타데이터 저장 확정(렌더) [배포]│ ← 시간 표시 없음, 액션 우측 몰림
├──────────────┬───────────────────────────────┬────────────────────────┤
│ LEFT aside   │        CENTER  flex-1          │  RIGHT aside           │  ← 고정폭 w-72(xl:w-80), 접기만 가능
│ w-72 xl:w-80 │   bg-ZINC-900  p-4 sm:p-6     │  w-72 xl:w-80          │    (리사이즈 드래그 없음)
│ (접힘→w-10)  │                               │  (접힘→w-10)           │
│ [자막][AI]   │   ┌─────────────────────┐     │  속성                  │
│ h-8 pill     │   │  EditorPreview      │     │  [텍스트·채널·레이아웃 │  ← 6개 아이콘 탭(flex-col)
│ ┌──────────┐ │   │  (% 스테이지 + cqh, │     │   ·자막·요소·필터]     │
│ │Transcript│ │   │   canonicalStageH)  │     │  ┌──────────────────┐ │
│ │ or AI패널│ │   │  min(72vh,640px)    │     │  │ 탭 내용          │ │
│ └──────────┘ │   └─────────────────────┘     │  │ overflow-y p-3   │ │
│              │   (넉넉한 회색 여백)           │  └──────────────────┘ │
├──────────────┴───────────────────────────────┴────────────────────────┤
│ FOOTER  border-t  p-3  (editor-shell.tsx:952)                          │
│  [Space재생 I/O구간 Ctrl+Z Ctrl+S …] kbd 범례  (editor-timeline.tsx:476)│ ← 이미 이식됨
│  ⚪재생  0:12 / 3:40  컷길이 0:48  …………  속도1× [훅][무음]            │ ← 트랜스포트(타임라인 안)
│  [w-28 레인라벨] [멀티레인: 파형 + 필름스트립 + 트림핸들 + rec밴드]      │ ← STEP-D 강점(AENA보다 풍부)
│  + 트랙 추가(비활성)                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

**핵심**: 두 에디터는 골격이 이미 비슷하다(3열 + 하단). STEP-D는 사실상 AENA **v2**(고정 그리드
3열) 배치에 가깝다. 남은 차이는 **골격이 아니라 폴리시/비율/발견성**이다.

---

## 2. 존별 비교표

| 존 | AENA v1 | STEP-D 현재 | 레이아웃 격차 |
|---|---|---|---|
| **컬럼 폭** | 리사이즈 가능(드래그 6px, 30/50/20% min·max) `page.tsx:911,913,984,1102` | 고정 w-72/w-80, **접기만** `editor-shell.tsx:812,904` | 드래그 리사이즈 없음 · 좌우 동일폭 |
| **중앙 배경** | `bg-black … p-2` `page.tsx:984` | `bg-zinc-900 … p-4 sm:p-6` `editor-shell.tsx:879` | 회색+과여백 → 영상이 "폼필드"처럼 |
| **중앙 스테이지** | PreviewFrame = **고정 target px + scale** `preview-frame.tsx:54` | % 스테이지 + cqh + canonicalStageH `editor-preview.tsx:312,88` | 좌표계 리팩터 진행 중(§5) |
| **헤더** | h-12, **중앙에 타임코드**(현재/전체/IN/OUT) `editor-toolbar.tsx:40` | h-14, 제목만 · 시간은 타임라인에 `editor-shell.tsx:764` | 글랜스 타임코드 없음(저우선) |
| **좌 패널 탭** | underline 활성(border-b-2 cyan) `page.tsx:917` | h-8 pill(자막/AI) `editor-shell.tsx:816` | 스타일 차이(경미) |
| **우 패널 성격** | **클립/인코딩 매니저 리스트** `page.tsx:1102` | **속성 편집기**(단일 클립) `editor-panel.tsx:114` | 제품이 달라 매핑 불가 — 베끼지 말 것(§4) |
| **속성 UI** | fixed **드래그 플로팅** 패널 `overlay-panel.tsx:107` | 우측 **상시** 사이드 패널 `editor-shell.tsx:904` | STEP-D가 더 나음 — 유지 |
| **하단 트랜스포트** | 풀너비 전용 바(▶ I O +구간 텍스트 이미지 속도 비율 + 범례) `page.tsx:1222` | 타임라인 안 트랜스포트(▶ 시간 컷길이 속도 훅) `editor-timeline.tsx:486` | 배치는 유사 · 컨트롤 밀도/그룹핑 차이 |
| **타임라인 트랙** | 단일 64px 트랙 `editor-timeline.tsx:110` | 멀티레인+파형+필름스트립+트림+rec밴드 | **STEP-D 압승 — 유지** |
| **악센트 색** | 단일 cyan(탭·플레이헤드·세그먼트·IN) | 흰색/에메랄드/앰버/바이올렛 혼재 | 통일감 차이(폴리시) |

---

## 3. 우선순위 변경 목록 (구현 가능 · 효과순)

각 항목: **AENA가 하는 것 (file:line) → STEP-D 현재 (file:line) → 정확한 변경 → 효과(S/M/L)**

### P1 — 중앙 스테이지를 "검은 플레이어"로 (가장 싼 큰 승) · **S**
- **AENA**: 중앙 패널 `min-w-0 bg-black flex items-center justify-center p-2` — 순수 검정 위에
  영상이 뜨고 여백이 타이트. `editor/[id]/page.tsx:984`
- **STEP-D**: `flex min-w-0 flex-1 items-center justify-center overflow-auto bg-zinc-900 p-4 sm:p-6`
  — 회색 배경 + 큰 패딩. `editor-shell.tsx:879`
- **변경**: `editor-shell.tsx:879` 의 중앙 wrapper 를
  `className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-black p-2 sm:p-3"`
  로. `bg-zinc-900→bg-black`, `p-4 sm:p-6→p-2 sm:p-3`. (스테이지 자체는 `editor-preview.tsx:316`
  이미 `rounded-lg shadow-2xl` 라 검정 위에서 카드처럼 뜬다.)
- **효과**: 영상이 "진짜 플레이어"처럼 보이고 스테이지가 커진다. **좌표계와 무관**(스테이지 안쪽
  cqh 는 컨테이너 크기로 재계산 — §5) → 지금 바로 안전.

### P2 — 컬럼 리사이즈(드래그) 도입 · **M**
- **AENA**: `react-resizable-panels` 로 좌30%/중50%/우20% + min·max, 6px 드래그 핸들
  (`background:#27272a`). `page.tsx:911-1102`
- **STEP-D**: 고정 `w-72 shrink-0` (xl:`w-80`) 좌우 aside, 접기 토글만. `editor-shell.tsx:812,904`
- **변경**: `editor-shell.tsx:809` 의 body `<div className="flex min-h-0 flex-1">` 를
  `react-resizable-panels` 의 `PanelGroup direction="horizontal"` 로 감싸고, 좌/중/우를 `Panel`
  (좌 `defaultSize={22} minSize={14} maxSize={34}` · 중 `defaultSize={56} minSize={40}` ·
  우 `defaultSize={22} minSize={16} maxSize={32}`)로, 사이에 `PanelResizeHandle`(폭 1.5px,
  `bg-zinc-800 hover:bg-cyan-600 transition-colors`)로 교체. **접기 토글은 유지** — 접힘 시 해당
  Panel 을 `w-10` 아이콘바로 렌더(현행 조건부 그대로), 펼침 시 Panel 로.
- **주의**: 패널 사이즈가 바뀌면 중앙 폭이 연속 변동 → 스테이지 재플로우. STEP-D 스테이지는
  `container-type:size`+cqh 라 자동 재계산됨(`editor-preview.tsx:326`). AENA PreviewFrame 도
  ResizeObserver 로 scale 재계산(`preview-frame.tsx:33-47`). **둘 다 리플로우 안전** → 리사이즈가
  깨끗이 얹힌다. `maxHeight:72vh`(`editor-preview.tsx:322`)를 유지해 세로 넘침 방지.
- **효과**: 사용자가 트랜스크립트/속성/프리뷰 비중을 직접 조절 → AENA "느낌"의 핵심. dep 추가 필요.

### P3 — 좌/우 폭 비대칭(읽기=좌, 컨트롤=우) · **S**
- **AENA**: 좌 30%(넓게 — 분석/추천 카드 읽기), 우 20%(좁게). `page.tsx:913,1102`
- **STEP-D**: 좌우 동일 `w-72 xl:w-80`. `editor-shell.tsx:812,904`
- **변경**: P2를 하면 defaultSize 로 흡수(좌 22 / 우 22 → 좌를 살짝 넓게 26/우 20 권장, 트랜스크립트가
  긴 문장이라 좌가 넓을수록 유리). P2를 안 한다면 최소한 좌를 `xl:w-96`, 우를 `xl:w-72` 로 비대칭.
- **효과**: 자막 리스트가 덜 접히고 속성 패널은 컴팩트하게. 저비용.

### P4 — 헤더 중앙 타임코드 클러스터 · **S** (선택)
- **AENA**: 헤더 중앙에 `현재 0:12 / 3:40  IN 0:05  OUT 0:20` (cyan/amber 칩). `editor-toolbar.tsx:40-59`
- **STEP-D**: 헤더에 시간 없음(제목만); 시간은 타임라인 트랜스포트에만. `editor-shell.tsx:764`,`editor-timeline.tsx:494`
- **변경**: `editor-shell.tsx:764` 제목 span 뒤(또는 title flex-1 을 좌측 고정폭으로 바꾸고) 중앙에
  `<div className="hidden md:flex items-center gap-3 text-xs tabular-nums text-zinc-400">` 로
  현재/전체(+trimIn/Out) 표시. `state.trimIn/trimOut`, `videoTime` 을 shell 이 이미 들고 있음.
- **효과**: 글랜스 타임코드. **단, STEP-D는 이미 타임라인에 시간을 보여줘 중복 위험** → 저우선.
  넣는다면 IN/OUT(trim) 만 헤더로 올려 "현재 자른 구간"을 상단에 상시 노출하는 게 실이득.

### P5 — 단일 악센트 색으로 수렴 · **S(넓게 퍼짐)** (폴리시)
- **AENA**: 상호작용/활성 상태가 전부 **cyan** 한 색(활성 탭 `border-cyan-500`, 플레이헤드,
  세그먼트 채움, IN 마커, ring). `page.tsx:917,925` · `editor-timeline.tsx:133,161`
- **STEP-D**: 흰 재생버튼·흰 배포버튼(`editor-shell.tsx:490,798`) + 에메랄드/앰버/바이올렛/에메랄드
  혼재(`editor-timeline.tsx` 레인/트림/rec밴드).
- **변경**: "의미색"(rec=바이올렛, 훅=앰버 등 정보 인코딩)은 그대로 두되, **순수 상호작용 상태**
  (활성 탭·선택 ring·주 CTA hover)를 cyan 계열로 통일. 예: 우 패널 활성 탭 `bg-zinc-800 text-white`
  는 유지하되 밑줄/ring 을 cyan 으로, 좌 패널 자막/AI 활성 탭을 AENA식 `border-b-2 border-cyan-500`.
- **효과**: 통일감("feel good")의 큰 부분. 기능 무관, 광범위 소폭 편집.

### P6 — 하단 트랜스포트 컨트롤 그룹핑 정리 · **S** (선택)
- **AENA**: 트랜스포트 한 줄에 재생/마크/구간/오버레이 좌측, **속도·비율은 우측 그룹**, 맨 오른쪽
  `ml-auto` 로 kbd 범례. 시각적 3구획. `page.tsx:1222-1255`
- **STEP-D**: 재생/시간/컷길이 좌측, `ml-auto` 로 속도/훅/무음 우측. kbd 범례는 트랜스포트 **위** 별줄.
  `editor-timeline.tsx:476,486,504`
- **변경**: 이미 거의 동형. STEP-D 는 kbd 범례가 위 별줄(`:477 hidden md:flex`)이라 오히려 깔끔.
  손댈 필요 적음 — **현행 유지 권장**. (AENA는 범례를 같은 줄 우측에 욱여넣어 좁으면 줄바꿈됨.)
- **효과**: 거의 없음 — 넣지 말 것 리스트에 가깝다.

---

## 4. STEP-D 강점 — 절대 회귀 금지

AENA v1을 "베끼다"가 아래를 **깎으면 역행**이다. 레이아웃만 맞추고 이건 그대로 둔다.

1. **멀티레인 타임라인** — 파형 + 필름스트립 파노라마 + 트림 핸들 + rec-window 하이라이트 밴드 +
   속도램핑 레인. AENA v1 은 단일 64px 트랙뿐(`editor-timeline.tsx:110`). STEP-D 가 압도적.
   `editor-shell.tsx:952` / `editor-timeline.tsx:546+`.
2. **트랜스크립트 뷰**(Opus식 자막 읽으며 편집) — AENA v1 엔 없음. `editor-shell.tsx:836`.
3. **Undo/Redo(배치 히스토리) + 자동저장 + beforeunload 가드** — `editor-shell.tsx:486,410,422`.
4. **kbd 단축키 범례** — 이미 이식됨. `editor-timeline.tsx:476`.
5. **상시 우측 속성 패널**(6탭: 텍스트/채널/레이아웃/자막/요소/필터) — AENA 의 플로팅 오버레이
   패널보다 발견성이 높다. `editor-panel.tsx:59,114`. **AENA의 플로팅 방식으로 되돌리지 말 것.**
6. **패널 접기/펼치기** — AENA v1 엔 없음. P2(리사이즈) 위에 **얹어서** 둘 다 제공.
7. **종횡비 단일 소스 = 레이아웃 탭** (2026-08-19 사용자 확정, `editor-shell.tsx:175-186`).
   AENA v1 은 비율을 하단 트랜스포트에, v2 는 헤더 select 에 둔다. **STEP-D는 레이아웃 탭에 두기로
   확정** → 헤더/트랜스포트에 비율 픽커를 **다시 넣지 말 것**(중복 소스가 예전 버그의 원인).

> 우측 패널 성격 차이(§2)를 재확인: AENA v1 우측은 "여러 클립/인코딩 매니저"(프로젝트=다클립 모델).
> STEP-D 는 "단일 클립 속성 편집"(클립 하나). 제품 모델이 달라 AENA 우측 리스트는 **베끼지 않는다.**

---

## 5. output-px 스테이지 리팩터와의 정합 (지금 진행 중)

**진행 중 작업**: STEP-D 프리뷰 스테이지가 재구성되는 중이다. 현재는 % 좌표 + `cqh`/`cqw` +
`canonicalStageH(aspect)` 미러(`editor-preview.tsx:67-90,144`)를 쓰고, 서버는 에디터가 안 보내는
실측 `stagePx` 대신 canonical 값으로 scale 을 잡는다(`use-overlay-png.ts:34` 주석: "에디터가 안 보낸다").

**AENA의 PreviewFrame 이 그 리팩터의 종착점 모델이다** — 고정 target 해상도(예 1080×1920) 위에
자식을 **절대 px** 로 배치하고, 뷰포트 변화는 `transform: scale()` 로만 흡수(ResizeObserver 로
scale 재계산). `preview-frame.tsx:27-79`. 즉 "output-px 스테이지" = AENA PreviewFrame 패턴.

**레이어링 규칙 — 레이아웃 작업이 리팩터를 방해하지 않게:**

1. **§3 의 P1(bg-black·패딩)·P2(리사이즈)·P3(폭)·P4(헤더)·P5(악센트)는 전부 "스테이지가 사는 상자"만
   바꾼다 — 스테이지 내부 좌표계와 무관하다.** 지금 바로 안전하게 진행 가능.
2. **P2 리사이즈의 유일한 주의점**: 중앙 폭이 연속 변동 → 스테이지가 매 프레임 재플로우.
   - 현행(cqh): `container-type:size` 라 자동. `editor-preview.tsx:326`.
   - 리팩터 후(PreviewFrame): ResizeObserver 가 scale 재계산. `preview-frame.tsx:33-47`.
   - **둘 다 리플로우-세이프** → 리사이즈는 어느 모델에서도 깨끗이 얹힌다. `maxHeight:72vh` 만 유지.
3. **하지 말 것**: 레이아웃 작업 중에 스테이지 **내부** 오버레이 좌표(cqh↔px, canonicalStageH,
   overlay PNG 파리티)를 건드리지 말 것 — 그건 리팩터의 몫이고 서버 렌더 파리티(overlay-parity
   테스트)가 걸려 있다. 레이아웃 PR 은 `editor-preview.tsx:308-328`의 **바깥 wrapper/스테이지
   박스 스타일**까지만 손대고, 그 아래 오버레이 렌더 트리는 건드리지 않는다.
4. **권장 순서**: (a) P1 먼저 병합(무위험, 즉효) → (b) 스테이지 좌표 리팩터가 PreviewFrame 로
   안착 → (c) 그 위에 P2 리사이즈 + P3~P5 폴리시. P1 을 리팩터와 독립적으로 먼저 내보내면
   리팩터 브랜치와 충돌 표면이 거의 없다(둘이 만지는 줄이 겹치지 않음).

---

## 6. 구현 체크리스트 (요약)

| # | 변경 | 파일 | 효과 | 리팩터 의존 |
|---|---|---|---|---|
| P1 | 중앙 wrapper `bg-black p-2 sm:p-3` | `editor-shell.tsx:879` | S | 독립(먼저) |
| P2 | 3열 `react-resizable-panels` + 접기 유지 | `editor-shell.tsx:809-948` | M | 리플로우-세이프 |
| P3 | 좌 넓게/우 좁게(비대칭 폭) | `editor-shell.tsx:812,904` | S | 독립 |
| P4 | 헤더 중앙 IN/OUT(trim) 타임코드 | `editor-shell.tsx:764` | S(선택) | 독립 |
| P5 | 상호작용 활성색 cyan 수렴 | `editor-shell.tsx`,`editor-panel.tsx`,`editor-timeline.tsx` | S(광범위) | 독립 |
| P6 | (트랜스포트 그룹핑) — **현행 유지 권장** | — | — | — |

**절대 유지**: 멀티레인 타임라인 · 트랜스크립트 · undo/자동저장 · kbd 범례 · 상시 속성패널 ·
접기 토글 · **비율=레이아웃 탭 단일 소스**. AENA 우측 클립/인코딩 리스트는 베끼지 않는다(제품 모델 상이).
