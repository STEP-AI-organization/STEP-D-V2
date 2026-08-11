# DB 정규화 — 미디어 중심 재설계

> 2026-08-11 결정. `entities` JSONB 블롭을 걷어내고 도메인을 정규 테이블로 옮긴다.
> 최상위 단위는 **미디어**다 — 영상을 올리면 거기서 모든 게 파생된다.

## 왜 지금인가

- 데이터가 거의 없다(program 2 · episode 2 · clip 1 · recommendation 20). **지금이 제일 싸다.**
- 프론트를 재설계하는 중이라 계약을 한 번에 맞출 수 있다.
- 오늘 겪은 실제 비용: 네이버 워커에서 작업 폴더를 만들 때 `program?.tenantName ??
  program?.broadcaster` 로 **필드를 추측해서** 짰다. FK 도 타입도 없어서 확인할 방법이 없었다.

## 현재 (문제)

```
entities(id, kind, data jsonb, ord, tenant_id)      ← program·episode·clip·recommendation 4종이 한 테이블
media(id, episode_id, role, path, …)                 ← 파일은 이미 정규 테이블
```

**같은 것이 두 군데로 쪼개져 있다.** 렌더된 클립은 `media(role='clip')` 행 + `entities(kind='clip')`
행 두 개이고, 둘을 잇는 건 JSONB 안의 `mediaId` 문자열뿐이다. FK 가 없으니 한쪽만 지워도 조용하다.

`clip.distributions` 는 JSONB 배열이라 채널별 조회·집계가 안 된다. 발행할 때마다 배열을 통째로
읽어 수정해 다시 쓴다(오늘 네이버 발행이 그렇게 동작한다).

## 목표 스키마

```
program ──< episode ──< media ──< media_edit ──< distribution
                          │  ▲        (파생물 공통 편집·렌더 메타 · PK=media_id)
                          │  └── source_media_id (파생물 → 원본)
                          └──< recommendation
```

**media 가 최상위다.** 종류(`kind`)로 갈린다:

| kind | 뜻 |
|---|---|
| `master` | 업로드한 원본 회차 영상 |
| `clip` | 잘라낸 클립 |
| `shorts` | 숏폼(9:16) |
| `highlight` | 하이라이트 |

`clip`·`shorts`·`highlight` 는 **모두 파생물**이고 성질이 같다 — 제목·구간·편집상태·렌더
결과·배포 이력을 갖는다. 그래서 종류마다 테이블을 만들지 않고 **`media_edit` 하나**로
받는다. 종류가 늘어도(예: `teaser`) 스키마가 안 바뀐다.

### program
| 컬럼 | 비고 |
|---|---|
| id, tenant_id | |
| title, section, target_age, status | status: planned/airing/ended (구값 active/archived 정규화) |
| owner, ended_date, rights_until, rights_note | 권리·담당 |
| pipeline_genre, moods jsonb, profile jsonb, smr jsonb | 파이프라인 분기·채널 설정 |
| episode_count | **저장하지 않는다** — episode 카운트로 뽑는다(지금은 손으로 갱신해 어긋난다) |

`cast`·`cast_photos` 는 이미 `program_cast` 테이블이 있다 → JSONB 사본을 지운다.

### episode
| 컬럼 | 비고 |
|---|---|
| id, tenant_id, program_id FK | |
| episode_number, broad_date, target_age | |
| source_channel_id, source_video_id | 유튜브에서 가져온 회차 |
| pipeline jsonb | stage·progress·note — **화면 표시용 상태**라 JSONB 유지가 맞다 |

`program_title` 은 **지운다** — program 조인으로 얻는다(지금은 프로그램명 바꾸면 회차가 옛 이름을 붙든다).

### media  ← 최상위
| 컬럼 | 비고 |
|---|---|
| id, tenant_id, episode_id FK(NULL 허용) | 회차 미배정 소재도 있다 |
| kind | `master` \| `clip` \| `shorts` \| `highlight` (기존 `role` 개명) |
| source_media_id FK | 파생물이 어느 마스터에서 나왔나 (master 는 NULL) |
| title, filename, path, mime, size | |
| duration_sec, width, height, codec, has_audio, thumb_path, created_at | |

### media_edit — 파생물(clip·shorts·highlight) 공통 확장
| 컬럼 | 비고 |
|---|---|
| **media_id PK/FK** | 파생물은 미디어다. 별도 id 를 두지 않는다 |
| episode_id FK | 조회 편의(denormalize · media 를 통해서도 얻을 수 있음) |
| title, title_line1, title_line2, synopsis, tags | |
| status, rendered, render_revision, render_preset, aspect_ratio | |
| start_time, end_time, duration_sec, hook_time_sec, hook_intro_caption | |
| source_recommendation_id FK, target_channel | 어느 추천에서 채택됐나 |
| editor_state jsonb | **편집기 상태는 JSONB 가 맞다** — 스키마가 UI 를 따라 자주 바뀐다 |
| created_at, updated_at | |

### recommendation
현행 21개 필드를 컬럼으로. `channel_scores`·`thumbnail_candidates` 만 JSONB 유지
(가변 배열이고 조회축이 아니다). `adopted_media_id FK` 로 채택 결과물을 가리킨다(클립일 수도 숏폼일 수도 있다).

### distribution ← 신규
| 컬럼 | 비고 |
|---|---|
| id, tenant_id, media_id FK | |
| channel | youtube \| navertv \| naverclip \| instagram \| facebook \| tiktok \| smr |
| status | pending \| published \| failed \| recorded |
| url, published_at, scheduled_at, error, account_id | |
| UNIQUE (media_id, channel) | 같은 채널에 두 번 기록되지 않게 |

**이게 이번 재설계의 실질적 이득이다.** "이번 주 네이버로 나간 클립", "실패한 배포"
같은 질문이 SQL 한 줄이 된다. 지금은 JSONB 배열을 앱에서 펼쳐야 한다.

## 하지 않는 것

- `pipeline`·`editor_state`·`thumbnail_candidates` 는 **JSONB 로 남긴다.** 화면 상태·가변
  배열이라 컬럼으로 쪼개면 변경 때마다 마이그레이션이 붙는다. 조회축이 아니면 JSONB 가 맞다.
- `search_segments` 는 건드리지 않는다 — 이미 정규화돼 있고 제품 목적물이다.

## 실행 순서

1. **마이그레이션**: 새 테이블 생성 + `entities` 에서 백필 + FK·인덱스·RLS
2. **접근 계층**: `db-pg.ts` 에 타입 있는 조회/쓰기 함수 (지금은 `getEntity<any>`)
3. **라우트**: 118개 중 관련분 이관. `entities` 읽기를 새 함수로 교체
4. **프론트 계약**: `apps/web/src/lib/types.ts` 를 새 스키마에 맞춤
5. **`entities` 제거**: 읽는 곳이 0이 된 뒤

각 단계마다 `entities` 를 **남겨둔 채** 새 테이블과 병행한다 — 3번이 끝나기 전에 지우면
되돌릴 수 없다.

## 위험

- **프론트 개편과 동시 진행이다.** 3·4번은 다른 세션이 만지는 파일과 겹친다.
  스키마(1·2)를 먼저 확정하고, 라우트는 프론트 계약이 정해진 뒤 한 번에 옮기는 게 안전하다.
- 프로덕션 데이터 규모를 확인하지 않았다(로컬만 봤다). 백필 전에 프로덕션 건수를 봐야 한다.
