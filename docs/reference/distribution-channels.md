# 공식 채널별 배포 — 레퍼런스

> 2026-08-13 실측. 다중 배포에서 **예약(스케줄) 처리 방식**이 채널마다 다르다.
> 이 문서는 "채널마다 실제로 어떻게 나가고, 예약을 누가 잡는가"를 한 장에 고정한다.
> 코드 정본: `apps/server/src/publish-dispatch.ts`(관문) · `publish-guard.ts`(모드) ·
> `worker.ts`(실행) · `youtube.ts`·`naver-tv.ts`(플랫폼 어댑터).

---

## 0. 예약(스케줄)은 두 종류다 — 이걸 먼저 구별한다

| 유형 | 뜻 | 지금 한 번 쏘면 | 예 |
|------|----|----------------|----|
| **A. 네이티브 예약** | 예약 시각을 **플랫폼 API에 실어** 보내면 플랫폼이 그 시각에 공개한다 | 끝. 워커 잡은 **즉시** 돌고, 예약은 플랫폼이 홀드 | YouTube, 네이버(스튜디오 예약), Facebook Page(예정) |
| **B. 우리쪽 발사** | 플랫폼에 예약 기능이 **없다**. 그 시각에 **우리가 직접 게시 API를 쏴야** 한다 | 안 됨. **그 시각까지 잡을 지연**시켰다가 워커가 발사 | Instagram |

**핵심**: A는 `publishAt`을 페이로드에 담아 잡을 **즉시** 큐잉하고 어댑터가 플랫폼에 넘긴다.
B는 잡을 `delayMs = 예약시각 − now` 로 **지연 큐잉**해서 워커가 그 시각에 깨어나 게시 API를 쏜다.
큐는 `delayMs`(= `runAfter`)를 이미 지원한다(재시도·폴링에 사용 · `queue.ts`). B는 그 위에 얹으면 된다.

---

## 1. 채널별 현황

| 채널 | 모드 | 실업로드 | 예약 유형 | 잡 · 레인 | 계정 지정 |
|------|------|----------|-----------|-----------|-----------|
| **YouTube** | upload | ✅ | **A 네이티브** — private 업로드 + `publishAt` → 유튜브가 그 시각 공개 | `distribution.publish` · youtube | `youtubeChannelId` (추론 금지) |
| **네이버 클립** | upload | ✅ (Playwright) | **A 네이티브** — 업로드 시 스튜디오 **예약발행 시각** 설정 | `naver.publish` · **naver(사무실 PC)** | `naverAccountId` (추론 금지) |
| **네이버 TV** | upload | ✅ (Playwright) | A 네이티브 (클립과 동일) · *신규 계정은 클립 전용* | `naver.publish` · naver | `naverAccountId` |
| **TikTok** | upload*(게이트 ON+계정)* / record | 받은함 **초안** | 예약 없음 — 사용자가 틱톡 앱에서 마무리·게시 | `distribution.publish` · youtube | `tiktokOpenId` (추론 금지) |
| **Instagram** | **record (스텁)** | ❌ 미구현 | **B 우리쪽 발사가 필요** — 그런데 실업로드 자체가 아직 없음 | — | (IG 비즈니스 OAuth 연결만 됨) |
| **Facebook** | **record (스텁)** | ❌ 미구현 | (A 가능 — Page는 `scheduled_publish_time` 지원. 구현 시) | — | (Meta OAuth 연결만 됨) |

\* TikTok은 `TIKTOK_UPLOAD_ENABLED` 게이트 ON **그리고** `tiktokOpenId`가 있을 때만 upload,
그 외에는 record. (`publish-guard.ts:channelPublishMode`)

`channelPublishMode`(정본): youtube·naver → `upload` · tiktok → 조건부 `upload` ·
**그 외(instagram·facebook·모르는 값) → `record`**. record는 파일이 안 올라가고 **상태만** 남는다
(`distributionStatusFor`: record→`recorded`, upload+예약→`scheduled`, upload→`pending`).

---

## 2. 유형 A — 네이티브 예약 (구현됨)

### YouTube (`worker.ts` handleDistributionPublish)
```
dispatch: enqueue("distribution.publish", { clipId, channelId, privacy,
                   publishAt: scheduled ? reserveDate : undefined })   // 지연 없음, 즉시
worker:   publishAt = futurePublishAt(payload.publishAt)   // 미래 시각이면 RFC3339, 아니면 null
          privacy   = publishAt ? "private" : (요청 privacy)   // 예약이면 private 로 올린다
          → 유튜브 upload 에 publishAt 전달 → 유튜브가 그 시각 공개 전환
          성공: pending→(예약이면)scheduled / (즉시면)published · 실패: pending→failed(사유)
```
즉 **잡은 즉시** 돌고, "그 시각 공개"는 유튜브가 책임진다.

### 네이버 (`worker.ts` handleNaverPublish → `naver-tv.ts` uploadToNaver)
```
dispatch: enqueue("naver.publish", { clipId, target, naverAccountId, description, category,
                   publishAt: naverPublishAt(scheduled, reserveDate) })  // epoch ms · 지연 없음
worker:   rawAt = Number(payload.publishAt); publishAt = rawAt > now ? rawAt : undefined
          → uploadToNaver({ ..., publishAt })  // Playwright 가 스튜디오 예약발행 시각을 채운다
```
과거·해석불가 시각은 `undefined`(= 즉시 발행)로 떨어뜨린다 — **예약은 못 걸리는 것보다 틀리는 게 나쁘다.**
네이버 잡은 **naver 레인(사무실 PC)** 전용이라 Cloud Run 워커가 집으면 100% 실패한다.

---

## 3. 유형 B — 우리쪽 발사 (Instagram · **미구현**)

Instagram Content Publishing API는 **게시 예약 파라미터가 없다** — 컨테이너를 만들고
`media_publish`를 **호출하는 순간** 게시된다. 그래서 예약하려면 **그 시각에 우리가**
`media_publish`를 쏴야 한다(유형 B).

**현재 상태**: Instagram은 `record` 모드 — 실제 게시 자체가 스텁이라, 예약 이전에 업로드도 안 된다.
IG 비즈니스 OAuth **연결**만 되어 있다(`/api/instagram/*`, 2026-08-13 분리).

**구현할 때의 패턴** (아키텍처는 이미 준비됨):
```
dispatch: const delayMs = scheduled ? Math.max(0, Date.parse(reserveDate) - Date.now()) : 0;
          enqueue("distribution.publish", { clipId, channel: "instagram", igUserId },
                  { dedupeKey: `distribution.publish:${clipId}:instagram:${igUserId}`, delayMs });
worker:   handleDistributionPublish 의 channel==="instagram" 분기 —
          큐가 delayMs 만큼 잡을 안 준다 → 예약 시각에 claim 되면 그때 media→media_publish 발사
```
- 즉시 발행이면 `delayMs=0`(지금과 동일), 예약이면 그 시각까지 큐가 홀드한다.
- **재시도 금지 원칙 유지**: 게시 시작 후 던지면 중복 게시 → 실패는 상태에 사유만 남기고 정상 종료.
- Facebook Page를 구현하면 그건 유형 A(`scheduled_publish_time`)로 가는 게 맞다 — IG와 갈린다.

---

## 4. 불변식 (바꾸지 말 것)

- **큐에 넣는 문은 하나** — `publish-dispatch.ts` 밖에서 `enqueue("distribution.publish"...)`
  하면 `publish-guard.test.ts`가 깨진다. 게이트(권리·심의)를 우회하는 새 경로를 막는 장치다.
- **계정은 추론하지 않는다** — youtube/naver/tiktok 모두 대상 계정을 명시로 받는다.
  B2B 다계정에서 A사 클립이 B사 채널로 나가는 사고를 원천 차단(워커가 테넌트를 한 번 더 대조).
- **record는 게시가 아니다** — 파일이 안 올라간 클립을 `published`로 승격하지 않는다(F4).
- **예약 파싱 실패 = 즉시 발행** — 과거·NaN 시각은 예약을 버리고 즉시 나간다. 조용히 사라지지 않는다.
