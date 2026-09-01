# 라이브 종료 즉시 쇼츠화 파이프라인 계획

작성 2026-07-30 · 상태: **다음 과제 / 실제 구현 계획** · 기준 제품: `apps/server` + `apps/web` + `core/`

---

## 0. 목표

방송/라이브가 끝나자마자 해당 라이브 VOD를 자동으로 수집하고, 기존 STEP-D AI 파이프라인에 태워 쇼츠·클립 후보가 추천 보드에 쏟아지게 만든다.

한 줄로는:

> **Live off → VOD ready 감지 → 자동 다운로드 → AI 분석 → 쇼츠 추천 보드 생성**

이 과제는 더미 데이터나 임의 계산이 아니라, 연결된 YouTube 채널의 실제 라이브 상태와 실제 VOD를 기반으로 한다.

---

## 1. v1 범위

v1은 **라이브 중 실시간 편집**이 아니라 **라이브 종료 직후 자동 편집 준비**다.

| 구분 | v1에서 함 | v1에서 안 함 |
|---|---|---|
| 라이브 감지 | 연결된 YouTube 채널의 active/upcoming/completed broadcast 조회 | 외부 채널 무단 감시 |
| 종료 판단 | `lifeCycleStatus=complete` 및 실제 종료 시각 확인 | 채팅/시청자 반응 기반 실시간 장면 선택 |
| VOD 준비 판단 | `recordingStatus=recorded` 또는 다운로드 가능 재시도 성공 | YouTube 처리 전 VOD를 억지로 받기 |
| 수집 | 기존 `youtube.download` 경로로 실제 VOD 다운로드 | 더미 미디어 생성 |
| 분석 | 기존 `content.analyze`로 STT·장면·비전·추천 생성 | 라이브 중 ffmpeg 실시간 인코딩 |
| 배포 | 추천 보드까지 자동 생성, 이후 운영자 채택/편집 | 무승인 자동 실업로드 |

v2에서야 YouTube DVR/HLS를 이용한 **라이브 중 롤링 버퍼 분석**을 검토한다. 지금은 현재 인프라와 가장 잘 맞는 v1부터 친다.

---

## 2. 현재 스택에서 재사용 가능한 것

| 현재 자산 | 재사용 방식 |
|---|---|
| YouTube OAuth / 연결 채널 | 라이브 목록 조회 권한으로 사용 |
| `youtube.ts` 토큰 리프레시 | liveBroadcasts API 호출도 같은 `withAccessToken` 경로 사용 |
| `youtube.download` 워커 잡 | 종료된 라이브 VOD를 기존 YouTube URL 임포트처럼 다운로드 |
| `content.analyze` 워커 잡 | 다운로드 완료 후 기존 AI 분석 파이프라인 그대로 사용 |
| `episode.pipeline` 진행률 | 라이브 VOD 분석 진행률을 기존 회차 화면에 표시 |
| 추천 보드 / 채택 / 편집기 | 라이브에서 나온 쇼츠 후보도 같은 추천/클립 모델 사용 |

핵심은 새 AI 파이프라인을 만들지 않는 것이다. 새로 필요한 것은 **라이브 종료 감지와 자동 임포트 연결부**다.

---

## 3. 근거 API

YouTube Live Streaming API의 `liveBroadcasts.list`는 인증된 사용자의 방송을 조회할 수 있고, `broadcastStatus`로 `active`, `upcoming`, `completed`를 필터링할 수 있다. 공식 문서상 이 요청은 `youtube.readonly`, `youtube`, `youtube.force-ssl` 중 하나의 scope로 가능하다.

라이브 방송 리소스에는 `snippet.actualStartTime`, `snippet.actualEndTime`, `status.lifeCycleStatus`, `status.recordingStatus`, `contentDetails.recordFromStart`, `contentDetails.enableDvr` 등이 있다. 문서상 live broadcast는 하나의 YouTube video에 대응한다.

참고:
- [YouTube LiveBroadcasts: list](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list)
- [YouTube liveBroadcast resource](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts)
- [YouTube LiveBroadcasts: transition](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition)

---

## 4. 시스템 흐름

```
연결 채널
  ↓
live.detect 잡
  - liveBroadcasts.list?mine=true&broadcastStatus=active
  - liveBroadcasts.list?mine=true&broadcastStatus=completed
  ↓
live_broadcasts 기록/갱신
  ↓
완료된 방송 중 아직 import 안 된 항목 선별
  - lifeCycleStatus = complete
  - actualEndTime 존재
  - recordingStatus = recorded 우선
  ↓
live.import 또는 기존 youtube.download 큐잉
  ↓
YouTube VOD 다운로드
  ↓
content.analyze 큐잉
  ↓
추천 보드에 AI 추천 생성
  ↓
운영자 채택/편집/최종 렌더/배포
```

---

## 5. 데이터 모델 초안

신규 런타임 생성 테이블 후보: `live_broadcasts`

| 컬럼 | 용도 |
|---|---|
| `id` | 내부 ID |
| `channelId` | 연결 YouTube 채널 ID |
| `broadcastId` | YouTube liveBroadcast ID |
| `videoId` | 대응 YouTube video ID. v1에서는 `broadcastId`와 같을 수 있으나 `videos.list` 또는 다운로드 성공으로 검증 |
| `title` | 방송 제목 |
| `description` | 방송 설명 |
| `thumbnail` | 방송 썸네일 |
| `scheduledStartTime` | 예약 시작 시각 |
| `actualStartTime` | 실제 시작 시각 |
| `actualEndTime` | 실제 종료 시각 |
| `lifeCycleStatus` | `live`, `complete` 등 |
| `recordingStatus` | `recording`, `recorded`, `notRecording` |
| `privacyStatus` | `public`, `unlisted`, `private` |
| `recordFromStart` | 처음부터 녹화 여부 |
| `enableDvr` | DVR 가능 여부 |
| `importStatus` | `none`, `waiting_vod`, `queued`, `downloading`, `analyzing`, `ready`, `failed` |
| `mediaId` | 생성된 media ID |
| `episodeId` | 생성된 episode ID |
| `lastCheckedAt` | 마지막 API 확인 시각 |
| `error` | 마지막 실패 메시지 |

중복 방지는 `UNIQUE(channelId, broadcastId)`와 `job_queue.dedupeKey`를 같이 쓴다.

---

## 6. 잡 설계

| 잡 | 역할 | 주기/트리거 |
|---|---|---|
| `live.detect` | 연결 채널의 active/completed 라이브 상태 조회, `live_broadcasts` 갱신 | 워커 1~5분 주기 또는 채널별 수동 실행 |
| `live.import` | 완료된 라이브 VOD를 기존 YouTube 임포트 경로로 넘김 | `live.detect`가 조건 충족 시 큐잉 |
| `youtube.download` | 실제 VOD 다운로드 및 GCS 저장 | 기존 잡 재사용 |
| `content.analyze` | AI 분석 및 추천 생성 | 기존 잡 재사용 |

`live.import`는 새 다운로드 로직을 만들지 않는다. 기존 `/api/media/from-youtube`가 하는 “episode/media placeholder 생성 + youtube.download 큐잉”을 서버 내부 함수로 빼서 재사용한다.

---

## 7. 프로그램 매핑

라이브 VOD를 어느 프로그램/회차에 붙일지 자동화해야 한다.

v1 매핑 우선순위:

1. 채널별 기본 프로그램 설정
2. 방송 제목 정규식 매핑: 예) `[라디오스타]`, `나는 SOLO`, `뉴스특보`, `라이브 커머스`
3. 편성표/스케줄 기반 매핑: 예) 수요일 22:30 방송은 특정 프로그램
4. 매핑 실패 시 `라이브 수집함` 프로그램에 임시 적재 후 운영자 확인

매핑 실패 때문에 다운로드/분석을 막으면 안 된다. 단, 외부 배포는 프로그램 확정 전 차단한다.

---

## 8. UI v1

새 화면 후보: `/live`

필수 섹션:
- 지금 라이브 중
- 방금 종료됨 / VOD 준비 대기
- 자동 분석 중
- 추천 생성 완료
- 실패/재시도

각 row:
- 채널
- 라이브 제목
- 시작/종료 시각
- 상태: live / ended / waiting VOD / downloading / analyzing / ready / failed
- 연결 프로그램
- 생성된 회차 링크
- 추천 수
- 실패 사유와 재시도 버튼

---

## 9. 성공 기준

| 단계 | 기준 |
|---|---|
| 감지 | 연결된 YouTube 채널의 완료 라이브를 실제 API로 감지 |
| 중복 방지 | 같은 라이브가 1번만 episode/media로 생성 |
| 자동 수집 | 완료 라이브 1건이 `youtube.download`로 자동 큐잉 |
| 분석 완료 | 다운로드 완료 후 `content.analyze`가 자동 실행 |
| 운영자 체감 | 라이브 종료 후 VOD 준비가 끝난 시점부터 추천 보드 도착까지 10~30분 목표 |
| 안전 | 운영자 승인 전 실배포 없음 |

---

## 10. 구현 순서

| 순서 | 작업 | 파일 |
|---|---|---|
| 1 | `youtube.ts`에 `fetchLiveBroadcasts` 추가 | `apps/server/src/youtube.ts` |
| 2 | `live_broadcasts` 런타임 테이블과 CRUD 추가 | `apps/server/src/db-pg.ts` |
| 3 | 기존 YouTube URL 임포트 로직을 내부 함수로 분리 | `apps/server/src/index.ts` 또는 신규 서버 내부 helper |
| 4 | `live.detect` / `live.import` 잡 타입 추가 | `apps/server/src/pipeline/queue.ts`, `apps/server/src/worker.ts` |
| 5 | 수동 트리거 API 추가 | `apps/server/src/index.ts` |
| 6 | `/live` 화면 추가 및 NAV 연결 | `apps/web/src/app/(app)/live/page.tsx`, `apps/web/src/lib/nav.ts` |
| 7 | 운영 문서 갱신 | `docs/reference/api-reference.md`, `docs/reference/data-model.md`, `docs/ops/worker-queue.md` |

서버 라우트는 리포 규칙대로 `apps/server/src/index.ts` 한 파일 안에 유지한다.

---

## 11. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| 라이브 종료 직후 YouTube VOD가 아직 처리 중 | `waiting_vod` 상태로 두고 지수 백오프 재시도 |
| 방송이 녹화되지 않음 | `recordingStatus=notRecording`이면 자동 임포트하지 않고 실패/확인 처리 |
| 제목만으로 프로그램 매핑 실패 | `라이브 수집함` 임시 프로그램으로 분석은 진행, 배포는 차단 |
| 긴 라이브 다운로드 비용/시간 | 기존 `youtube.download` 워커 lane 사용, content lane과 분리 가능 |
| 같은 라이브 중복 생성 | `live_broadcasts` unique + `job_queue.dedupeKey=live.import:{broadcastId}` |
| 실제 배포 사고 | 추천 생성까지만 자동, 최종 렌더/배포는 기존 승인 흐름 유지 |

---

## 12. v2 이후

v1이 안정화된 뒤 검토:

- 라이브 중 DVR/HLS 롤링 버퍼를 5~10분 단위로 분석
- 실시간 채팅/동시시청자 피크를 후보 점수에 반영
- 스포츠/뉴스/홈쇼핑처럼 종료 전 클립이 필요한 포맷 지원
- 라이브 종료 즉시 출연자별 SNS 패키지 자동 생성
- 승인 완료 후 예약 배포까지 자동화

v2의 핵심은 “라이브가 꺼진 뒤”가 아니라 “라이브가 진행되는 동안 이미 후보를 쌓아두는 것”이다. 단, 현재는 v1처럼 종료 후 VOD 기반 자동화가 먼저다.
