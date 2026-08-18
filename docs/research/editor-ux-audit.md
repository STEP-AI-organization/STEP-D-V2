# STEP-D 편집기 UX 감사 (읽기 전용)

> 2026-08-18 · `apps/web/src/components/editor/*` + `src/lib/editor/*` 실측.
> 비교 레퍼런스: AENA 쇼츠 편집기 `C:\Users\STEPAI05\aena\src\app\(editor)\studio\editor` (읽기 전용).
> **코드 변경 없음.** 사용자가 말한 "불편한 부분들"을 코드 근거로 특정하고 우선순위 + 구체 수정안을 붙인다.

파일 약칭:
- `shell` = `apps/web/src/components/editor/editor-shell.tsx`
- `panel` = `apps/web/src/components/editor/editor-panel.tsx`
- `preview` = `apps/web/src/components/editor/editor-preview.tsx`
- `timeline` = `apps/web/src/components/editor/editor-timeline.tsx`
- `overlay` = `apps/web/src/components/editor/editor-overlay.tsx`
- `history` = `apps/web/src/lib/editor/useEditorHistory.ts`
- `presets` = `apps/web/src/lib/editor/presets.ts`
- `aena/page` = `aena/src/app/(editor)/studio/editor/[id]/page.tsx`
- `aena/vp` = `aena/src/app/(editor)/studio/editor/_components/editor-video-player.tsx`
- `aena/toolbar` = `aena/src/app/(editor)/studio/editor/_components/editor-toolbar.tsx`

---

## 우선순위 요약 (가장 아픈 것부터)

| # | 무엇이 불편한가 (근거) | 왜 아픈가 | 심각도 | 공수 | 구체 수정 |
|---|---|---|---|---|---|
| 1 | **Undo/Redo 배칭이 배선 안 됨.** `shell:469` 의 로컬 `update` 가 `history` 의 `setState` 를 **mergeSig 없이** 호출한다. `history:78-100` 의 `update`/`beginBatch`/`endBatch`(연속 조작 접기)는 shell 이 destructure 하지도 않는다(`shell:147-159`). | 슬라이더·드래그 한 번이 mousemove/input 마다 히스토리 항목을 쌓아 `MAX_HISTORY=50`(`history:6`)을 순식간에 넘긴다 → **그 이전 편집 undo 기록이 통째로 밀려 사라지고**, Ctrl+Z 는 1픽셀씩 되돌아간다. `history` 주석(20-34)이 "고쳤다"고 적은 바로 그 버그가 실제로는 살아 있다. | 높음 | S | shell 이 `history.update`(mergeSig 자동 배칭)를 쓰거나, 드래그 시작/끝에 `beginBatch`/`endBatch` 를 호출. `setSaved(false)` 는 래퍼에 그대로 유지. |
| 2 | **자동 저장 없음 + 미저장 이탈 가드 없음.** 저장은 수동 버튼/Ctrl+S 뿐(`shell:266-286`). 헤더의 `배포`·`나가기` 는 맨 `<Link>`(`shell:703-708, 768-773`)라 클릭·새로고침 시 미저장 편집이 사라진다. `saved` 는 저장 후 `true` 지만 이후 편집 없이 유지되면 거짓일 수 있다. | 편집자가 크게 손본 뒤 눈에 띄는 흰색 `배포` 버튼을 누르면 작업이 날아간다. AENA 는 2초 디바운스 자동 저장(`aena/page:694-703`) + 정직한 `저장 중…/저장됨 ✓`(`aena/toolbar:63-64`). | 높음 | M | `saveClipEditor` 로 2초 디바운스 자동 저장 추가. `!saved` 일 때 `beforeunload` + 라우터 이탈 확인. 저장 상태를 `saving/saved/dirty` 3값으로. |
| 3 | **동작하지 않는 컨트롤이 화면을 가득 채움.** 속도 램핑(`timeline:497-504`)·무음 제거(`timeline:517-524`)·트랙 추가(`shell:957-965`)·분할(`timeline:36 SPLIT_ENABLED=false`)·전환/크로스페이드(`timeline:790-835`)·부가 줄(`panel:540-543`)·싱크 offsetMs(`timeline:918-961`)·이미지 배경(`panel:849-859`)·메타데이터 저장(`shell:1083`)이 전부 비활성/미리보기 전용. | 정직하게 라벨은 붙였지만, 편집자는 "이 토글 중 뭐가 진짜 되나"를 매번 학습해야 한다. 화면이 능력을 과장한다. AENA 는 백엔드 없는 버튼을 아예 안 만든다(원칙). | 높음(체감 품질) | M | 렌더 미지원 컨트롤을 feature flag 뒤로 **숨기거나** 접힌 "준비 중" 섹션으로 격리. 현재 배선된 것만 기본 노출. |
| 4 | **키보드 단축키가 안 보인다.** Space/I/O/Ctrl+Z/Ctrl+S 구현됨(`shell:475-497, 654-694`)인데 화면 어디에도 안내가 없다(타임라인 줌 힌트 한 줄만 `timeline:483-485`). | 강력한 단축키가 발견 불가 → 편집자가 느린 마우스 경로만 쓴다. AENA 는 트랜스포트에 `kbd` 범례(`aena/page:1248-1254`) + 도움말 드로어(`aena/toolbar:65`). | 중 | S | 트랜스포트 바에 `kbd` 범례 한 줄 추가(Space·I/O·Ctrl+Z·Ctrl+S). 저장/확정/재생 버튼에 단축키 `title`. |
| 5 | **선택된 오버레이 키보드 이동/삭제 없음.** 오버레이는 마우스 드래그(`overlay:63-84`)나 키프레임 숫자필드로만 옮긴다. | 정밀 배치가 고통스럽다(1px 단위 마우스 드래그). AENA 는 방향키 10px·Shift 50px 이동, Delete 삭제, Esc 해제(`aena/page:588-614`). | 중 | S | preview 선택 상태(`selected`)에 keydown 핸들러: 방향키 nudge titleX/Y·element x/y, Delete 삭제, Esc 해제. |
| 6 | **렌더가 동기·수 분·진행률 0.** `confirmExport`(`shell:429-467`)는 await 로 수 분을 블록하고 버튼은 "진행 중" 텍스트만(스피너·단계 없음, 아이콘 그대로 `shell:763-767`). 탭 닫으면 유실. | 편집자가 멈춘 건지 도는 건지 모른다. AENA 는 비동기 인코딩 + 상태 리스트(완료/인코딩 중/실패/대기 `aena/page:1200-1205`) + 품질 선택 모달(`aena/page:842-909`). | 중~높음 | M/L | 최소: 스피너 + "수 분 소요될 수 있습니다" 안내. 이상적: 잡 큐 + 상태 폴링(AENA 인코딩 탭 패턴). |
| 7 | **클립 미로딩 시 유령 편집기.** 스토어에 clip 이 없으면(서버 미연결·하드 새로고침 중) shell 이 플레이스홀더로 렌더 — 제목 "새 클립", 40초, "영상" 회색(`shell:54,68-70`), 그리고 `save()` 는 조용히 `setSaved(true)`(`shell:266-270`). | 존재하지 않는 클립을 "저장됨"이라 속인다. AENA 는 loading/error 화면으로 게이트(`aena/page:827-828`). | 중 | S | `!clip` 이면 로딩/찾을 수 없음 상태를 렌더(스토어 로딩 여부로 구분). |
| 8 | **종횡비를 3개의 겹치는 컨트롤이 지배.** 헤더 배포처 드롭다운(aspect+길이상한 시드, 모바일에선 숨김 `shell:714-739`), 레이아웃 탭 종횡비 5버튼(`panel:795-810`), 레이아웃 탭 화면 구성 basic/ai_multi(ai면 종횡비 버튼 비활성 `panel:799`). 결합이 불투명(`shell:199-241` aspectOverrideRef/presetEnum force-sync). | 배포처를 고르면 종횡비 버튼이 말없이 바뀌고, AI 다중이면 죽는다. 편집자가 인과를 못 읽는다. | 중 | M | "출력·종횡비"를 한 섹션으로 통합, 우선순위(editorState > preset > clip)를 문구로 노출. 현재 유효 종횡비 + 길이 상한을 인라인 표시. |
| 9 | **메타데이터 편집이 업로드에 반영 안 됨.** 헤더 "메타데이터" 팝오버(`shell:974-1091`)는 제목·설명·태그를 편집·저장하지만 실제 업로드는 clip.title/synopsis/tags 를 쓴다(`shell:1083` 스스로 고지). | 눈에 띄는 헤더 기능이 통째로 no-op. "outputs-dont-reach-consumers" 최빈 실패모드. | 중 | M | 워커 업로드 페이로드가 `uploadMeta` 를 읽게 배선하거나, 배선 전까지 버튼을 숨김/비활성. |
| 10 | **CSS↔서버 PNG 스왑 깜빡임.** `useOverlayPng`(`use-overlay-png.ts:49-64`)가 정적 필드 변경마다 hash=null(CSS 폴백) → 350ms 후 PNG 스왑. 선택/편집 진입 시에도 CSS↔PNG 전환(`preview:141-149`). | 제목 타이핑·색 변경 때마다 350ms 뒤 글꼴·커닝이 살짝 튄다(CSS≈PNG). 미세하지만 잦다. | 중 | L | 디바운스 후 PNG 를 **크로스페이드**로 교체(즉시 null 대신 이전 PNG 유지). CSS 근사를 PNG 폰트 메트릭에 더 맞춤. |
| 11 | **오버레이 리사이즈가 조악.** `overlay:104-108` 는 코너 핸들 하나로 dx+dy 평균 × 0.4 를 폰트크기에 더한다 — 스테이지 스케일·요소 실제 크기와 무관, 회전 핸들 없음, 제목은 모든 줄을 **한꺼번에** 리사이즈(`preview:416-417`). | 크기 조절이 예측 불가하고 줄별 독립 조정이 안 된다. | 중 | M | 리사이즈 델타를 스테이지 폭 대비 %로 환산. 줄별 리사이즈 옵션. (회전은 별도.) |
| 12 | **오른쪽 속성 패널 기본 탭이 "레이아웃".** `panel:93` `useState("layout")`. 가장 흔한 작업(제목 텍스트)은 "텍스트" 탭. | 편집자가 매번 탭을 바꿔야 첫 작업(제목)을 한다. | 낮음 | S | 기본 탭을 `text` 로. |
| 13 | **제목 줄이 블록으로만 이동.** titleX/titleY 는 제목 전체 블록 하나(`preview:406-418`). 줄 1·줄 2 를 따로 배치하려면 키프레임 오프셋뿐. | 두 줄 훅에서 줄별 위치 조정이 불가. | 낮음 | M | 줄별 x 오프셋 컨트롤(이미 키프레임에 있음)을 정적 필드로 승격. |
| 14 | **인라인 편집 어포던스 약함.** 오버레이 더블클릭 편집(`preview:466-469`)인데 힌트가 없다(선택 시 점선+리사이즈 핸들만 `overlay:132-146`). | 더블클릭 편집을 모르면 패널만 쓴다. | 낮음 | S | 선택 시 "더블클릭해 편집" 툴팁/커서 힌트. |
| 15 | **색은 줄 전체 단위만.** `panel:360` Swatches 는 title line 전체 색만 바꾼다. AENA 는 선택 영역 부분 색(`overlay-panel.tsx:61-80` execCommand foreColor). | 한 줄 안에서 특정 단어만 강조 불가(현재는 줄을 나눠야 함). | 낮음 | L | (선택) 리치텍스트 부분 색. 우선순위 낮음. |

---

## 퀵윈 (공수 S, 가치 높음 — 먼저 이것부터)

1. **#1 히스토리 배칭 배선** — `shell` 이 `history.update`(또는 beginBatch/endBatch)를 쓰게. 한 줄~수 줄. undo 를 실제로 쓸 수 있게 만든다. **가장 임팩트 큰 퀵윈.**
2. **#4 단축키 범례** — 트랜스포트에 `kbd` 한 줄(AENA `aena/page:1248-1254` 패턴 그대로).
3. **#5 오버레이 방향키 nudge/Delete/Esc** — preview 선택 상태에 keydown 하나(AENA `aena/page:588-614` 이식).
4. **#7 유령 편집기 가드** — `!clip` 로딩/찾을 수 없음 상태 렌더.
5. **#12 속성 패널 기본 탭 → 텍스트** — 상수 한 개.
6. **#6 최소분** — 확정 버튼에 스피너 + "수 분 소요" 툴팁(전체 비동기화 전에라도).
7. **#14 더블클릭 편집 힌트** — 선택 오버레이에 툴팁.

## 더 큰 작업 (M/L — 계획 필요)

- **#2 자동 저장 + 이탈 가드** (M): 디바운스 저장 + beforeunload/라우터 가드 + 3값 저장 상태.
- **#3 죽은 컨트롤 격리** (M): feature flag 로 렌더 미지원 컨트롤 숨김/접힘. 화면 밀도·신뢰도 개선.
- **#6 비동기 렌더 + 상태** (M/L): 잡 큐 + 인코딩 상태 리스트(AENA 인코딩 탭).
- **#8 종횡비 컨트롤 통합** (M): 3개 컨트롤 → 한 섹션 + 유효값/상한 인라인.
- **#9 메타데이터 배선** (M) 또는 숨김.
- **#10 PNG 스왑 크로스페이드** (L), **#11 리사이즈 정밀화** (M).

---

## STEP-D 가 이미 더 나은 곳 (회귀시키지 말 것)

이번 개편에서 지켜야 할 강점 — AENA 대비 STEP-D 가 앞선다.

- **Undo/Redo 존재.** AENA 리듀서엔 undo/redo 액션이 아예 없다(`aena/page:128-536`). STEP-D 는 `history` 로 undo/redo + 키보드(Ctrl+Z/Y)를 갖췄다. **#1 만 고치면** STEP-D 의 undo 가 AENA 보다 확실히 낫다.
- **드래그 트림 핸들.** 타임라인 레인 위 IN/OUT 핸들 직접 드래그(`timeline:755-781`) + 슬라이더 + 타임코드 입력(`timeline:871-916`). AENA 는 타임라인에서 드래그 트림이 없다(I/O 키/버튼만).
- **타임라인 리치니스.** 커서 앵커 줌(`timeline:425-458`), 필름스트립(`timeline:625-627`), 파형(`timeline:686-692`), 스마트 눈금(`timeline:598-623`). AENA 타임라인은 눈금+세그먼트 바 수준(`aena/editor-timeline.tsx`).
- **트랜스크립트 편집 뷰.** 자막 읽으며 클릭 시크·활성 문장 하이라이트·pause 배지·장면 설명(`transcript-view.tsx`). AENA 엔 없음.
- **정직한 상태 분리.** scenes 로딩/실패/미분석/정상 4상태(`shell:113-114`, `editor-ai-panel.tsx:112-126`), 스트림 실패 토스트(`shell:91-99`). 이 정직함은 유지하되, #3 처럼 "죽은 컨트롤 노출"까지 정직함으로 정당화하지는 말 것.
- **WYSIWYG PNG 오버레이.** 서버 canvas PNG 로 결과물 픽셀 미리보기(`use-overlay-png.ts`, `preview:388-396`). AENA 도 있지만(`text-overlay-layer.tsx:204-211`) STEP-D 는 제목+채널 통합.

## AENA 가 더 나은 패턴 (도입 검토)

- **자동 저장 + 정직한 저장 상태**: `aena/page:694-703`, `aena/toolbar:63-64` → 본문 #2.
- **화면에 보이는 단축키 범례 + 도움말 드로어**: `aena/page:1248-1254`, `aena/toolbar:65` → #4.
- **선택 오버레이 방향키/Delete/Esc**: `aena/page:588-614` → #5.
- **J/K/L 셔틀 + 프레임 단위 이동(←→, Shift=1초)**: `aena/vp:143-189`. STEP-D 는 프레임 스텝·셔틀이 없다(재생/시크만). 정밀 편집에 유용 — 중간 우선순위로 도입 검토.
- **비동기 인코딩 + 상태 리스트 + 품질 선택**: `aena/page:842-909, 1164-1215` → #6.
- **로딩/에러 게이트 화면**: `aena/page:827-828` → #7.

---

## 부록 — 근거 메모

- **#1 검증**: `shell:147-159` 는 `state,setState,undo,redo,reset,canUndo,canRedo` 만 구조분해한다(`update`/`beginBatch`/`endBatch` 미포함). `shell:469-472` `const update = (patch) => { setState((s)=>({...s,...patch})); setSaved(false); }` — 2번째 인자 `mergeSig` 없음. `history:48-76` `setState` 는 `mergeSig == null` 이면 `autoSig=null` 후 항상 `past` 에 push. 결과: 모든 연속 update 가 개별 히스토리. timeline 트림 드래그(`timeline:274-279`)·Movable 드래그(`preview:412 onMove`)·필터/폰트/채널 슬라이더가 전부 이 경로.
- **#2 검증**: shell 에 `beforeunload`·라우터 이탈 훅 없음. `save()` 만 존재. `confirmExport` 는 렌더 전 저장하지만(`shell:433-436`), 단순 이탈 경로(`나가기`/`배포`)엔 가드 없음.
- **#3 목록 근거**: `SPLIT_ENABLED=false`(`timeline:36`), 램핑/무음 `disabled`(`timeline:503, 522`), 트랙 추가 `disabled`(`shell:959`), 전환 버튼 `disabled`(`timeline:810`), 부가 줄 `PreviewOnly`(`panel:542`), 싱크 "(미리보기 전용)"(`timeline:922`), 이미지 배경 경고(`panel:850-851`), 메타데이터 no-op 고지(`shell:1084`).
</content>
</invoke>
