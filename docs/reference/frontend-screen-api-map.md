# 화면 × API 매핑 — 이식용 대조표

> 2026-09-03 **코드에서 자동 추출**(전이적 import 추적). 손으로 적지 않았다.
> 재생성: 프론트 개편 중 화면이 바뀌면 다시 뽑아 갱신할 것.
> 짝 문서: [프론트 재개편 이식 규격](../plans/active/frontend-redesign-handoff.md)

## 왜 이 표가 있나

디자이너 산출물은 **목 데이터**로 온다. 이식의 마지막 단계는 그 목을 실제 API 호출로
바꾸는 것인데, 화면마다 `lib/data/api.ts` 의 어느 함수를 쓰는지 매번 찾으면 느리고
빠뜨린다. **빠뜨리면 화면은 그려지는데 데이터가 안 온다** — 이 리포에서 제일 자주 나는
실패 방식이다(`analytics-reach` 테스트가 그래서 있다).

`files` = 그 화면이 전이적으로 닿는 로컬 파일 수(공용 프리미티브 포함). **상대 비교용**이다.
`store` = `useAppData()` 로 전역 상태(`/api/state`)를 함께 읽는다.

## 요약 — 실제 화면 24개

| 화면 | API 함수 | files | store |
|---|---:|---:|:--:|
| `/episodes/[id]` | 36 | 32 | ✔ |
| `/publish-channels` | 33 | 15 |  |
| `/automation` | 31 | 20 | ✔ |
| `/programs/[id]/settings` | 30 | 16 | ✔ |
| `/media` | 29 | 17 | ✔ |
| `/distribution` | 27 | 16 | ✔ |
| `/reframe-lab` | 25 | 11 | ✔ |
| `/search` | 25 | 10 | ✔ |
| `/thumbnails` | 25 | 12 | ✔ |
| `/edits` | 24 | 19 | ✔ |
| `/program-analytics` | 23 | 11 | ✔ |
| `/analyze` | 22 | 15 | ✔ |
| `/dashboard` | 21 | 12 | ✔ |
| `/business` | 20 | 20 | ✔ |
| `/programs/[id]/highlights` | 20 | 14 | ✔ |
| `/programs/[id]` | 20 | 16 | ✔ |
| `/programs` | 20 | 17 | ✔ |
| `/credits` | 10 | 13 |  |
| `/assets` | 8 | 8 |  |
| `/commerce` | 5 | 13 |  |
| `/channel-analytics` | 4 | 7 |  |
| `/ops` | 2 | 12 |  |
| `/performance` | 2 | 9 |  |
| `/trends` | 2 | 13 |  |

### 화면이 **아닌** 것 3개 — 개편 대상에서 뺀다

- `/analytics` — 옛 성과 화면 자리. **바로 리다이렉트하지 않는다** — 쓰던 사람에게는 화면이 말없이
- `/clips` — 옛 클립 화면 자리. **바로 리다이렉트하지 않는다** — 쓰던 사람에게는 화면이 말없이
- `/` — 재설계 라우팅은 대시보드를 `/dashboard` 로 둔다 (README "Interactions & Behavior")

---

## 계약 커버리지 — 어디서도 안 쓰이는 함수 **13개**

`api.ts` 가 내보내는 함수 **155개** 중 화면·레이아웃·스토어·인증 어디에서도 참조되지 않는 것들이다.
전이적 import 추적과 전체 grep **두 방법이 일치**했다(`api.ts` 자신은 제외하고 참조 파일 0개).

```
changePassword        deleteTrackedVideo   errorMessageOf        faceCropUrl
fetchFactoryRun       fetchGateAudit       fetchVideoTrend       generateThumbnail
runFactory            setNaverAccountStatus  syncChannelVideos   triggerChannelAnalysis
uploadContentType
```

**개편 전에 판단할 것** — 셋 중 하나다:

1. **화면이 아직 없다** (`runFactory`·`fetchFactoryRun`·`fetchGateAudit` = 팩토리/게이트 감사,
   `changePassword` = 비밀번호 변경) → 새 UI 에서 만들 기회다. 서버 쪽은 이미 있다.
2. **화면이 사라지며 고아가 됐다** (`syncChannelVideos`·`triggerChannelAnalysis`·
   `deleteTrackedVideo` = 옛 채널 화면 잔재로 보인다) → 지운다.
3. **헬퍼라 원래 안 불릴 수 있다** (`errorMessageOf`·`faceCropUrl`·`uploadContentType`).

⚠️ **지우기 전에 서버 라우트까지 같이 볼 것.** 웹에서만 지우면 서버에 죽은 라우트가 남고,
반대로 서버를 지우면 `web-routes-exist` 테스트가 잡아준다 — 그 테스트를 믿고 순서를 정하면 된다.

---

## 화면별 상세

### `/analyze`

U5 · 영상 분석 (README §4 · FLOWS F2)

- 전이 파일 15 · 전역 상태(`useAppData`) 사용
- **API 함수 22개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe,
  getStreamUrl, importYoutubeVideo, reanalyzeMedia, rejectRec, requestClipReframe, retryDist,
  saveClipEditor, selectRecommendationThumbnail, updateProgram, uploadFinishedClip,
  uploadVideo
  ```

### `/assets`

U10 · 에셋 (README §6 · FLOWS F8)

- 전이 파일 8 · 전역 상태(`useAppData`) 미사용
- **API 함수 8개**
  ```
  assetRawUrl, createAssetFolder, deleteAssetFolder, deleteAssets, fetchAssets,
  moveAssetFolder, moveAssets, uploadAsset
  ```

### `/automation`

U12 · 자동 배포 — 디자인 기준 단일 세로 파이프라인 (Main.dc.html · 2026-08-24)

- 전이 파일 20 · 전역 상태(`useAppData`) 사용
- **API 함수 31개**
  ```
  adoptRec, createProgram, deleteAutomationRule, deleteEpisode, deleteProgram, exportClip,
  fetchAutomation, fetchInstagramAccounts, fetchMetaAccounts, fetchNaverAccounts,
  fetchShortsTemplates, fetchState, fetchTikTokAccounts, fetchYouTubeChannels,
  getClipReframe, getStreamUrl, importYoutubeVideo, rejectAutomationHold, rejectRec,
  releaseAutomationHold, requestClipReframe, retryDist, runAutomationNow, saveAutomationRule,
  saveClipEditor, selectRecommendationThumbnail, setAutomationNotifyEmails,
  setAutomationPaused, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/business`

- 전이 파일 20 · 전역 상태(`useAppData`) 사용
- **API 함수 20개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe,
  importYoutubeVideo, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  selectRecommendationThumbnail, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/channel-analytics`

채널 분석 — **영상 하나를 깊게 본다.**

- 전이 파일 7 · 전역 상태(`useAppData`) 미사용
- **API 함수 4개**
  ```
  fetchChannelVideos, fetchVideoAnalytics, fetchYouTubeChannels, refreshVideoComments
  ```

### `/commerce`

상품 링크 검토 — **찾은 것과 붙는 것을 가르는 화면.**

- 전이 파일 13 · 전역 상태(`useAppData`) 미사용
- **API 함수 5개**
  ```
  fetchClipCommerce, fetchCommerceAccount, fetchCommerceReview, issueCommerceLinks,
  saveCommerceDecisions
  ```

### `/credits`

결제 — 잔액·구매·거래·결제 수단·설정. **크레딧 1개 = 분석 1분.**

- 전이 파일 13 · 전역 상태(`useAppData`) 미사용
- **API 함수 10개**
  ```
  createTopupOrder, deleteSavedCard, fetchAutoTopup, fetchCredits, fetchInvoices,
  fetchSavedCard, prepareCardIssue, saveBillingNotifyEmails, saveCard, topupWithCard
  ```

### `/dashboard`

U13 · 대시보드 (README §1 · FLOWS F3 윈도우 경고 · F9 마스킹)

- 전이 파일 12 · 전역 상태(`useAppData`) 사용
- **API 함수 21개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchChannelAnalytics,
  fetchMetaAccounts, fetchNaverAccounts, fetchState, fetchTikTokAccounts,
  fetchYouTubeChannels, getClipReframe, importYoutubeVideo, rejectRec, requestClipReframe,
  retryDist, saveClipEditor, selectRecommendationThumbnail, updateProgram,
  uploadFinishedClip, uploadVideo
  ```

### `/distribution`

U8 · 배포 (README §7 · FLOWS F4)

- 전이 파일 16 · 전역 상태(`useAppData`) 사용
- **API 함수 27개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchChannelEligibility,
  fetchInstagramAccounts, fetchMetaAccounts, fetchNaverAccounts, fetchNaverCategories,
  fetchState, fetchTikTokAccounts, fetchYouTubeChannels, generateClipMetadata,
  getClipReframe, importYoutubeVideo, publishClips, rejectRec, requestClipReframe, retryDist,
  saveClipEditor, saveClipMetadata, selectRecommendationThumbnail, syncLiveMetadata,
  updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/edits`

편집본 — 외부에서 편집한 완성 영상을 올려 **여러 채널에 배포**하는 곳

- 전이 파일 19 · 전역 상태(`useAppData`) 사용
- **API 함수 24개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchChannelEligibility,
  fetchInstagramAccounts, fetchMetaAccounts, fetchNaverAccounts, fetchNaverCategories,
  fetchState, fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe, importYoutubeVideo,
  publishClips, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  selectRecommendationThumbnail, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/episodes/[id]`

- 전이 파일 32 · 전역 상태(`useAppData`) 사용
- **API 함수 36개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchChannelEligibility,
  fetchEpisodeCast, fetchInstagramAccounts, fetchMetaAccounts, fetchNaverAccounts,
  fetchNaverCategories, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, frameUrl,
  getClipReframe, getMediaAnalysis, getMediaFaces, getMediaPpl, getStreamUrl,
  importYoutubeVideo, mediaUrl, patchMediaFacesMapping, pplFrameUrl, publishClips,
  reanalyzeMedia, registerEpisodeCast, rejectRec, requestClipReframe, retryDist,
  saveClipEditor, selectRecommendationThumbnail, setEpisodeCastStatus, updateProgram,
  uploadFinishedClip, uploadVideo
  ```

### `/media`

U6 · 미디어 (README §5)

- 전이 파일 17 · 전역 상태(`useAppData`) 사용
- **API 함수 29개**
  ```
  adoptRec, createProgram, deleteClip, deleteEpisode, deleteProgram, exportClip,
  fetchChannelEligibility, fetchInstagramAccounts, fetchMetaAccounts, fetchNaverAccounts,
  fetchNaverCategories, fetchState, fetchTikTokAccounts, fetchYouTubeChannels,
  generateClipMetadata, getClipReframe, importYoutubeVideo, openInPremiere, publishClips,
  rejectRec, requestClipReframe, retryDist, saveClipEditor, saveClipMetadata,
  selectRecommendationThumbnail, syncLiveMetadata, updateProgram, uploadFinishedClip,
  uploadVideo
  ```

### `/ops`

- 전이 파일 12 · 전역 상태(`useAppData`) 미사용
- **API 함수 2개**
  ```
  fetchOpsJobs, fetchOpsMediaAnalysis
  ```

### `/performance`

U14 · 성과 (README §8 · FLOWS F9)

- 전이 파일 9 · 전역 상태(`useAppData`) 미사용
- **API 함수 2개**
  ```
  fetchChannelAnalytics, fetchYouTubeChannels
  ```

### `/program-analytics`

프로그램 분석 — 프로그램을 고르면 그 프로그램의 현황과 **스타일 분석**이 보인다

- 전이 파일 11 · 전역 상태(`useAppData`) 사용
- **API 함수 23개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchThumbnailStyle, fetchTikTokAccounts,
  fetchYouTubeChannels, getClipReframe, importYoutubeVideo, rejectRec, requestClipReframe,
  retryDist, saveClipEditor, selectRecommendationThumbnail, thumbnailStyleImageUrl,
  trainThumbnailStyle, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/programs`

U2 · 프로그램 목록 (README §2 · FLOWS F10)

- 전이 파일 17 · 전역 상태(`useAppData`) 사용
- **API 함수 20개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe,
  importYoutubeVideo, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  selectRecommendationThumbnail, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/programs/[id]`

U3 · 프로그램 홈 (README §3 · FLOWS F10)

- 전이 파일 16 · 전역 상태(`useAppData`) 사용
- **API 함수 20개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe,
  importYoutubeVideo, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  selectRecommendationThumbnail, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/programs/[id]/highlights`

- 전이 파일 14 · 전역 상태(`useAppData`) 사용
- **API 함수 20개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe,
  importYoutubeVideo, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  selectRecommendationThumbnail, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/programs/[id]/settings`

썸네일 엔진 준비 — 스타일 학습 + 출연자 등록

- 전이 파일 16 · 전역 상태(`useAppData`) 사용
- **API 함수 30개**
  ```
  adoptRec, autofillProgram, createProgram, deleteCastPhotos, deleteEpisode, deleteProgram,
  exportClip, fetchCastPhotos, fetchMetaAccounts, fetchNaverAccounts, fetchNaverCategories,
  fetchProgram, fetchState, fetchThumbnailStyle, fetchTikTokAccounts, fetchYouTubeChannels,
  getClipReframe, importYoutubeVideo, rejectRec, requestClipReframe, retryDist,
  saveClipEditor, selectRecommendationThumbnail, syncProgramFromAnalysis,
  thumbnailStyleImageUrl, trainThumbnailStyle, updateProgram, uploadCastPhoto,
  uploadFinishedClip, uploadVideo
  ```

### `/publish-channels`

배포채널 — 각 플랫폼 카드. YouTube·Facebook·Instagram·TikTok 은 OAuth 로 붙고,

- 전이 파일 15 · 전역 상태(`useAppData`) 미사용
- **API 함수 33개**
  ```
  clearCommerceSession, clearNaverCredentials, clearNaverSession, createNaverAccount,
  deleteInstagramAccount, deleteMetaAccount, deleteNaverAccount, deleteTikTokAccount,
  deleteYouTubeChannel, disconnectInstagramAccount, disconnectMetaAccount,
  disconnectTikTokAccount, disconnectYouTubeChannel, fetchChannelDaily, fetchChannelRules,
  fetchCommerceAccount, fetchInstagramAccounts, fetchMetaAccounts, fetchNaverAccounts,
  fetchNaverCredentialState, fetchTikTokAccounts, fetchYouTubeChannels, getInstagramAuthUrl,
  getMetaAuthUrl, getTikTokAuthUrl, getYouTubeAuthUrl, reloginNaverAccount, saveChannelRule,
  saveCommerceAccount, saveNaverCredentials, updateNaverAccount, uploadCommerceSession,
  uploadNaverSession
  ```

### `/reframe-lab`

리프레임 랩 — "이 클립엔 어떤 세로 레이아웃?" 클립당 1클릭 정답 수집

- 전이 파일 11 · 전역 상태(`useAppData`) 사용
- **API 함수 25개**
  ```
  adoptRec, createProgram, createReframeCompare, deleteEpisode, deleteProgram, exportClip,
  fetchMetaAccounts, fetchNaverAccounts, fetchReframeCompare, fetchReframeLabels, fetchState,
  fetchTikTokAccounts, fetchYouTubeChannels, getClipReframe, importYoutubeVideo,
  reframeCompareFileUrl, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  saveReframeLabel, selectRecommendationThumbnail, updateProgram, uploadFinishedClip,
  uploadVideo
  ```

### `/search`

U15 · 영상 검색 (README §9 · FLOWS F9)

- 전이 파일 10 · 전역 상태(`useAppData`) 사용
- **API 함수 25개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchTikTokAccounts, fetchYouTubeChannels, frameUrl,
  getClipReframe, getStreamUrl, importYoutubeVideo, logSearchEvent, rejectRec,
  requestClipReframe, retryDist, saveClipEditor, searchSegments, segmentDownloadUrl,
  selectRecommendationThumbnail, updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/thumbnails`

U11 · 썸네일 생성 (README §11 · FLOWS F7)

- 전이 파일 12 · 전역 상태(`useAppData`) 사용
- **API 함수 25개**
  ```
  adoptRec, createProgram, deleteEpisode, deleteProgram, exportClip, fetchMetaAccounts,
  fetchNaverAccounts, fetchState, fetchThumbnailCandidates, fetchThumbnailStyle,
  fetchTikTokAccounts, fetchYouTubeChannels, generateThumbnails, getClipReframe,
  importYoutubeVideo, rejectRec, requestClipReframe, retryDist, saveClipEditor,
  selectRecommendationThumbnail, selectThumbnailCandidate, thumbnailStyleImageUrl,
  updateProgram, uploadFinishedClip, uploadVideo
  ```

### `/trends`

- 전이 파일 13 · 전역 상태(`useAppData`) 미사용
- **API 함수 2개**
  ```
  fetchTrendingVideos, fetchVideoCategories
  ```

