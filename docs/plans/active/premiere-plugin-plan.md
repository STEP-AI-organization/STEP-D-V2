# STEP-D Premiere 플러그인 추진안

> 2026-08-27 접수(사용자 원문 유지) + 같은 날 코드 대조 부록(§부록) 추가.
> 방향: 프리미어를 대체하지 않는다. **STEP-D를 프리미어 안의 AI 조연출·배포 패널로 넣는다.**

## 요약

- 추진 가치가 높다. "프리미어를 대체"하지 않고 STEP-D를 프리미어 안의 AI 조연출·배포 패널로 넣는다.
- 실무 흐름은 다음으로 고정한다.

  STEP-D 추천 확인 → Premiere에서 MXF/MP4 편집 → MP4 완성본 렌더 → STEP-D 업로드 → 채널 게시·상태 확인

- Premiere 25.6부터 UXP가 정식 지원되며 미디어 가져오기, 마커, 타임라인 삽입, MOGRT, AME 내보내기를 제어할 수 있다.
  [Adobe UXP 변경 내역](https://developer.adobe.com/premiere-pro/uxp/changelog/) ·
  [SequenceEditor API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequenceeditor)
- 범용 AI 검색은 Premiere 자체 기능과 겹친다. Adobe 검색은 현재 영어 시각 검색 중심이므로, STEP-D는 한국어 방송 문맥·출연자·장면·채널별 하이라이트·성과 환류에 집중한다.
  [Premiere AI 미디어 검색](https://helpx.adobe.com/in/premiere/desktop/organize-media/file-organization/search-for-media-using-ai-powered-media-intelligence.html)
- STEP-D에는 이미 완성 영상의 대용량 업로드→배포용 클립 생성 경로가 있다. `apps/web/src/lib/data/api.ts` · `apps/server/src/index.ts`
- `packages/premiere`에 Manifest v5, Premiere 25.6+ 대상 UXP 패널을 추가한다. 네이티브 C++나 코덱 플러그인은 사용하지 않는다.
- 패널 UI는 `stepd.stepai.kr/premiere` 전용 웹 화면을 WebView로 표시한다. 로그인·워크스페이스·추천·배포채널 UI는 기존 STEP-D 세션을 재사용하고, Premiere 프로젝트 조작만 메시지 브리지로 실행한다.
  [UXP WebView API](https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-js/global-members/html-elements/html-web-view-element)
- 메시지 브리지는 허용된 STEP-D origin만 받고, 명시된 작업만 지원한다: 프로젝트 조회, 미디어 연결, 재생 위치 이동, 추천 마커 생성, 완성본 내보내기, 업로드 진행 보고. 임의 파일 경로나 임의 URL 실행은 금지한다.
- 편집자는 STEP-D 회차와 Premiere의 ProjectItem을 한 번 연결한다. 연결 정보는 Premiere 프로젝트의 persistent property에 mediaId, projectItemId, FPS, 시작 타임코드, 시간 오프셋으로 저장한다.
- 추천 후보는 우선 비파괴적으로 제공한다.
  - 결과 클릭: Source Monitor 또는 플레이헤드를 해당 구간으로 이동
  - 후보 일괄 적용: 이름·점수·추천 이유·STEP-D ID가 포함된 시퀀스 마커 생성
  - Premiere 26.3+: 후보별 서브클립과 러프컷 시퀀스 생성
  - 25.6~26.2: 서브클립 API가 없으므로 마커·IN/OUT 이동까지만 제공
- 완성본 업로드는 두 방식을 제공한다.
  - 활성 시퀀스 내보내고 업로드: Premiere/AME가 지정된 H.264/AAC MP4 프리셋으로 렌더
  - 이미 렌더한 MP4 선택: 기존 완성 파일을 바로 업로드
- WebView가 기존 `/api/media/upload-init`에서 GCS resumable 세션을 발급받고, UXP 호스트가 파일을 청크 단위로 읽어 업로드한다. 완료 후 WebView가 `/api/media/clip-finalize`를 호출해 배포 가능한 클립을 만든다.
- 게시 전 프로그램·회차·영상 유형·채널·공개범위·예약시간을 확인한다. 기본 공개범위는 unlisted로 명시 전송하고, 실제 게시는 사용자의 최종 확인 후 기존 `/api/distributions/publish`로 실행한다. 실패·재시도 상태도 패널에서 폴링한다.
- 계정 연결과 결제 관리는 기존 STEP-D 웹에서 유지한다. 플러그인은 연결 완료된 채널만 표시한다.
- STEP-D 자막은 SRT 파일을 Premiere 프로젝트 Bin까지 가져온다. 현재 UXP는 자막 트랙 생성·수정 API가 완성되지 않았으므로 타임라인 자막 자동 배치는 약속하지 않는다.
  [Adobe 직원의 Caption API 답변](https://community.adobe.com/questions-729/add-editing-delete-subtitle-with-api-jsx-1621921)
- MXF 분석 경로는 선행 보강한다.
  - 현재 media.prepare가 512MB 이하 모든 파일을 MP4로 리먹스하려는 동작을 MP4 계열에만 제한해 MXF 원본 덮어쓰기를 막는다.
  - 서버에 FPS, 시작 타임코드, 오디오 스트림 수를 저장해 Premiere 원본과 1프레임 단위로 검증한다.
  - MXF는 로컬/NAS 편집 원본으로 유지하고, STEP-D에 올라가는 최종 게시본은 MP4로 제한한다.

## 인터페이스와 배포

- WebView↔UXP 메시지는 버전이 있는 discriminated union으로 고정한다: `PROJECT_CONTEXT`, `LINK_MEDIA`, `SEEK`, `ADD_MARKERS`, `EXPORT_REQUEST`, `UPLOAD_SESSION`, `PROGRESS`, `COMPLETE`, `ERROR`.
- 기존 서버 공개 API는 복제하지 않는다. 로그인 세션과 현재 업로드·클립·배포 API를 재사용한다.
- 파일 접근 권한은 request, 네트워크는 STEP-D와 GCS 도메인만 허용한다. API 키를 플러그인에 저장하지 않는다.
- 파일럿은 서명된 `.ccx` 직접 배포로 시작한다. 검증 후 Adobe Admin Console 배포, 이후 Marketplace 등록을 검토한다.
  [Adobe 배포 안내](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/overview/)

## 테스트 계획

- Windows/macOS, Premiere 25.6와 26.3에서 패널 설치·로그인·프로젝트 재오픈 후 연결 복원.
- 23.976, 25, 29.97 DF, 30fps와 시작 타임코드가 다른 MXF/MP4에서 추천 위치 오차가 1프레임 이내인지 검증.
- 1시간 이상 MXF 원본을 Premiere에서 편집한 뒤 H.264 MP4 렌더→중단·재개 업로드→클립 생성→게시까지 완주.
- 같은 업로드·finalize·게시 요청을 재전송해도 중복 클립이나 중복 게시가 생기지 않는지 확인.
- 세션 만료, AME 미설치, 렌더 실패, 디스크 부족, GCS 업로드 중단, 채널 권한 만료, 게시 게이트 OFF를 각각 명시적 복구 안내로 표시.
- 파일럿 성공 기준은 완성본 업로드·게시 성공률 95% 이상, 타임코드 오차 1프레임 이하, Premiere 밖 STEP-D 화면 왕복 0회로 둔다.

## 가정

- 첫 버전은 Premiere 25.6 이상만 지원한다.
- 원본 MXF/MP4의 기존 STEP-D 분석 진입 방식은 바꾸지 않으며, 플러그인은 분석 결과를 Premiere로 가져오고 Premiere에서 만든 최종 MP4를 STEP-D로 되돌리는 역할을 맡는다.
- 편집·색보정·오디오·자막 최종 판단은 Premiere가 담당하고, STEP-D는 추천·메타데이터·업로드·배포·성과 추적을 담당한다.

---

## 부록 — 코드 대조 (2026-08-27 실사)

### 선행 보강: 무엇이 끝났고 무엇이 남았나

| 추진안 항목 | 상태 | 근거 |
|---|---|---|
| MXF 원본 덮어쓰기 방지 | **완료**(2026-08-27 `204975d`) | `media.prepare` 가 프로브 → `needsMp4Normalize` → 변환본을 **새 경로(.mp4)** 에 올린다. remux(`-c copy`)는 이미 mp4/h264/aac 인 파일만 탄다 — MXF 는 그 분기에 들어가지 않으므로 원본이 덮이지 않는다 |
| FPS·시작 타임코드·오디오 트랙 수 저장 | **완료**(마이그레이션 0046) | `probe()` 가 `fps`·`startTimecode`·`audioStreams` 를 반환하고, `media` 테이블에 `fps`·`start_timecode`·`audio_streams` 컬럼 추가. 저장은 **정규화 후 값** — 편집·재생·렌더가 전부 그 파일을 보므로 그게 정본이다 |
| 최종 게시본은 MP4로 제한 | **이미 그렇다** | 렌더 산출물은 항상 libx264/aac mp4(`ffmpeg.ts renderShort`·`trimEncode`). 업로드된 MXF 도 정규화되어 mp4 로 게시된다 |

### 플러그인이 기대는 기존 경로 (복제 금지 — 그대로 쓴다)

| 용도 | 경로 |
|---|---|
| 대용량 업로드 세션 | `POST /api/media/upload-init` → GCS resumable |
| 완성본 → 배포 클립 | `POST /api/media/clip-finalize` |
| 게시 | `POST /api/distributions/publish` (게이트·크레딧·기록이 전부 이 문 하나) |
| 상태 폴링 | `GET /api/state` · 배포 행(`distributions[]`) |
| 추천·자막 | `GET /api/media/:id/analysis` · `/transcript` |

### 프레임 정합의 실제 근거

STEP-D 내부 시각은 **파일 0초 기준**으로 일관된다(모든 `-ss`·구간·plan 이 그렇다).
Premiere·EDL 은 **소스 타임코드 기준**이라, 둘을 잇는 값이 `media.start_timecode` 와 `media.fps` 다.
플러그인은 이 둘로 환산한다: `premiereTC = startTimecode + (stepdSec × fps)` (drop-frame 은 fps 29.97 표기를 그대로 쓰되 프레임 번호 계산에서 DF 규칙 적용).

⚠️ 0046 이전에 업로드된 미디어는 값이 0/"" 다 — 플러그인이 연결할 때 **재프로브로 채우는 경로**가 필요하다(미구현 · 다음 단계).

### 다음 단계 (착수 순서)

1. ~~선행 보강 — MXF 정규화 · 프레임 메타 저장~~ **완료**
2. `packages/premiere` 스캐폴드 — UXP manifest v5 · WebView 패널 골격 · 메시지 브리지 타입(discriminated union)
3. `stepd.stepai.kr/premiere` 전용 웹 화면 — 로그인·회차 선택·추천 목록(기존 세션 재사용)
4. 브리지 동작 배선 — `PROJECT_CONTEXT` → `LINK_MEDIA` → `SEEK`/`ADD_MARKERS`
5. 업로드·게시 — `EXPORT_REQUEST` → `UPLOAD_SESSION` → clip-finalize → publish
6. 파일럿 배포(.ccx 서명) · 테스트 계획 실행
