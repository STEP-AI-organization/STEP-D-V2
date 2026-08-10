---
name: shorts-template
description: 쇼츠 템플릿 — 캔바 폴더에서 프레임 PNG 를 가져오고(canva:sync), meta.json 좌표로 클립에 합성한다. 템플릿/캔바/쇼츠 프레임/띠·자막 레이아웃 작업 시 사용.
---

# 쇼츠 템플릿

캔바에서 **프레임(띠·테두리·로고)** 만 가져오고, **텍스트는 우리가 ffmpeg 으로 그린다.**

캔바 텍스트를 그대로 쓰면 회차마다 제목이 바뀌는 걸 감당 못 한다 — export 된 PNG 에
글자가 픽셀로 구워지기 때문이다. 그래서 글자 영역은 `bands` 로 덮고 `drawtext` 로 다시 쓴다.

## 저장 형식

```
assets/shorts-template/<이름>/
  overlay.png   캔바 export (1080x1920, rgba)
  meta.json     좌표 — 이게 템플릿의 본체다
```

```json
{
  "canva_design_id": "DAHR3WfZbxQ",     // 동기화 시 디렉토리 매칭 키
  "size": [1080, 1920],
  "video":  { "x": 0, "y": 410, "w": 1080, "h": 1090 },
  "bands":  [ { "x": 0, "y": 0, "w": 1080, "h": 410, "color": "black" } ],
  "text":   [ { "slot": "title1", "y": 150, "size": 76, "color": "#ffffff" } ],
  "overlay_regions": []
}
```

| 키 | 뜻 |
|---|---|
| `video` | 영상이 들어갈 사각형. 남는 세로는 blur 배경이 채운다 |
| `bands` | 단색으로 덮을 영역 — 캔바에 구워진 글자를 지우는 용도 |
| `text` | 텍스트 슬롯. `slot` 이 CLI 인자 이름이 된다. `x` 생략 시 가운데 정렬 |
| `overlay_regions` | overlay.png 에서 **실제로 쓸 사각형만**. 비우면 PNG 픽셀을 안 쓴다 |

> ⚠️ `overlay_regions` 를 비우지 않고 PNG 를 통째로 얹으면 **템플릿 자체 배경사진이 영상을
> 전부 덮는다.** 캔바 템플릿은 대개 완성된 디자인이지 투명 프레임이 아니다. 테두리·로고가
> 있는 템플릿만 그 사각형을 지정할 것.

## 1. 캔바에서 가져오기

템플릿은 캔바 폴더 **"유튜브 쇼츠 템플릿"** 에만 넣는다. 전체 디자인 목록에는 pptx·작업문서가
섞여 있어서 이름으로 거르는 건 못 믿는다 — 폴더가 유일한 기준이다.

```bash
pnpm --filter @stepd/server canva:sync
```

- 폴더 안 디자인만 export → `assets/shorts-template/`
- 디렉토리는 `meta.json` 의 `canva_design_id` 로 매칭 — `canva-DAHR…` 를 의미 있는 이름으로
  rename 해도 다음 동기화가 찾아간다
- **기존 `meta.json` 은 덮어쓰지 않는다** (좌표 작업 보호). `overlay.png` 만 갱신
- 새 디자인은 `_todo` 가 붙은 초안 meta.json 이 생긴다 — 좌표는 사람이 채운다

폴더 이름을 바꾸려면 `CANVA_TEMPLATE_FOLDER` 환경변수.

## 1-b. 캔바로 올리기 (반대 방향)

우리가 만든 프레임을 캔바에도 보관·편집하고 싶을 때만. 파이프라인엔 필요 없다.

```bash
pnpm --filter @stepd/server canva:push sns-card
```

`meta.json` 의 `canva_design_id` 를 자동으로 갱신하므로, 캔바에서 그 디자인을
"유튜브 쇼츠 템플릿" 폴더로 옮겨두면 이후 `canva:sync` 가 같은 디렉토리로 찾아온다.

> ⚠️ 올라가는 건 **납작한 이미지 한 장**이다. 캔바가 PNG 를 레이어로 되돌리지 못한다.
> 헤더 함정: `Asset-Upload-Metadata` 는 **JSON 문자열 그대로** — 통째로 base64 하면
> `Invalid upload metadata header`. 안쪽 `name_base64` 만 base64url 이다.

## 2. 합성

```bash
python scripts/dev/render_with_template.py --template mz-routine --list-slots
#   title1 title2 cta

python scripts/dev/render_with_template.py \
  --template mz-routine --video clip.mp4 --start 2 --end 12 \
  --text 'title1=나는솔로 16기 영수' \
  --text 'title2=고백 직전 3초' \
  --text 'cta=구독 ▶ 좋아요' \
  --out out.mp4
```

없는 슬롯을 주면 사용 가능한 목록과 함께 거부한다.

## 좌표 잡는 법

`overlay.png` 를 Read 로 열어 눈으로 본 뒤:

1. 영상이 들어갈 빈 영역 → `video`
2. 캔바 글자가 박힌 띠 → `bands` (그 띠의 배경색을 `color` 에)
3. 그 띠 안에서 글자를 앉힐 y 좌표 → `text`

캔바 원본의 글자 크기·색을 그대로 따라가면 디자인 의도가 유지된다.

## 함정

- **`-ss` 는 `-i` 앞에.** 뒤에 두면 전량 디코드로 수백 배 느려진다 (실측 558배)
- **한글은 `textfile` 로.** filter 인자에 직접 넣으면 이스케이프가 깨진다
- 기본 폰트 `c:/Windows/Fonts/malgunbd.ttf` — 리눅스 워커로 옮기면 `--font` 를 줘야 한다
- 16:9 소스를 9:16 에 넣으면 위아래 blur 여백이 크게 남는다. `video` 높이를 줄이거나
  크롭을 키워야 하는데 템플릿마다 판단이 달라 자동화하지 않았다

## 캔바 연동

`apps/server/src/canva.ts` — OAuth(PKCE) · 토큰 회전 · export · 폴더 · autofill.

- 스코프는 **캔바 개발자 콘솔 Scopes 탭과 정확히 일치**해야 한다. 콘솔에서 안 켠 스코프는
  동의 시 **에러 없이 조용히 떨어진다** — `POST /rest/v1/oauth/introspect` 로 실제 부여분을
  확인할 것. 스코프를 늘렸으면 `/api/canva/auth` 로 **재동의**해야 한다 (기존 토큰은 안 바뀜)
- `autofillDesign()` 은 구현만 되어 있고 **실호출 검증 안 됨.** 브랜드 템플릿이 있어야 돈다.
  텍스트 교체는 지금 ffmpeg 경로로 충분해서 쓰지 않는다
- 로컬은 `PUBLIC_URL=http://127.0.0.1:4100` — 캔바가 `localhost` 를 리다이렉트로 안 받는다

## 3. 편집기 배합 (2026-08-10)

프레임 템플릿이 편집기 프리셋을 **대체**했다. 구 `TEMPLATE_PRESETS` 5종은 저장된 클립의
하위호환용으로만 남아 있다(`@deprecated`).

```
assets/shorts-template/         ← 진실의 출처 (디스크)
  ↓ apps/server/src/shorts-template.ts   로더 + 픽셀→% 변환
  ├─ GET /api/shorts-templates              편집기 목록 (좌표는 %)
  ├─ GET /api/shorts-templates/:name/overlay.png
  └─ renderShort({ frame })                 export 합성 (좌표는 px)
```

**핵심 설계: 템플릿은 기하만 준다.** 텍스트는 편집기의 titleLines/채널 레이어가 기존 ASS
경로로 굽는다. 렌더러를 둘로 갈라놓으면 "편집기에서 본 것"과 "export 결과"가 어긋난다 —
`render_with_template.py` 는 **템플릿 실험·미리보기 전용**이고 제품 렌더 경로가 아니다.

합성 순서는 세 곳에서 동일해야 한다 (하나만 어긋나도 로고가 지워지거나 캔바 글자가 되살아난다):
```
검정 바탕 → 영상(cover) → bands(over=false) → overlay_regions → bands(over=true) → 텍스트
```
- `apps/web/.../editor-preview.tsx` (CSS div/img)
- `apps/server/src/ffmpeg.ts` `renderShort()` (filtergraph)
- `scripts/dev/render_with_template.py` (실험용)

`editorState.templateId` = 템플릿 디렉토리 이름. 목록에 없으면 프레임 없이 기존 blur/solid
경로로 떨어진다 — 구 클립이 깨지지 않는다.
