/**
 * STEP-D — mock data layer (milestone M0/M1).
 *
 * Deterministic, in-memory sample data shaped exactly like the domain types.
 * This is the single data seam: milestone M6 replaces these functions with calls
 * to the real STEPD SPFN RPC API without touching any screen. (plan decision D3)
 */
import type { Clip, Connections, Episode, JobEvent, Program, Recommendation } from "@/lib/types";

/** Account-level channel connections (set once). SMR needs none (internal feed). */
export const connections: Connections = { youtube: true, instagram: false, facebook: false, tiktok: false };

export const programs: Program[] = [
  { id: "p1", title: "전지적 참견 시점", section: "예능", targetAge: 12, cast: ["이영자", "홍현희"], episodeCount: 5, status: "active",
    smr: { programCode: "jeonchamsi", category: "02", weekdays: [6], posterReady: true, thumbnailReady: true } },
  { id: "p2", title: "허수아비", section: "드라마", targetAge: 15, cast: ["김수현", "박은빈"], episodeCount: 3, status: "active",
    smr: { programCode: "heosuabi", category: "01", weekdays: [5, 6], posterReady: true, thumbnailReady: true } },
  // p3: SMR 프로그램 설정 미완 — 코드·편성요일·포스터 누락. 클립을 SMR에 올리려면 프로그램 준비부터 완료해야 함.
  { id: "p3", title: "짐쌀라비", section: "예능", targetAge: 0, cast: ["유재석"], episodeCount: 1, status: "active",
    smr: { category: "02", weekdays: [], posterReady: false, thumbnailReady: true } },
  { id: "p4", title: "놀면 뭐하니?", section: "예능", targetAge: 12, cast: ["유재석", "하하", "정준하"], episodeCount: 2, status: "active",
    smr: { programCode: "hangout", category: "02", weekdays: [6], posterReady: true, thumbnailReady: true } },
  { id: "p5", title: "뭉쳐야 찬다", section: "예능", targetAge: 7, cast: ["안정환", "이동국", "김성주"], episodeCount: 2, status: "active",
    smr: { programCode: "moongchan", category: "02", weekdays: [0], posterReady: true, thumbnailReady: true } },
  { id: "p6", title: "아침 시사 브런치", section: "시사", targetAge: 15, cast: ["김어준"], episodeCount: 1, status: "active",
    smr: { programCode: "morningbrunch", category: "04", weekdays: [1, 2, 3, 4, 5], posterReady: true, thumbnailReady: true } },
];

export const episodes: Episode[] = [
  { id: "e1", programId: "p1", programTitle: "전지적 참견 시점", episodeNumber: 312, broadDate: "2026-07-05", targetAge: 12,
    pipeline: { stage: "recommend", stageStatus: "done", note: "추천 18건 · 채택 대기", progress: 100 } },
  { id: "e2", programId: "p1", programTitle: "전지적 참견 시점", episodeNumber: 311, broadDate: "2026-06-28", targetAge: 12,
    pipeline: { stage: "publish", stageStatus: "done", note: "SMR·YT 게시 완료" } },
  { id: "e3", programId: "p2", programTitle: "허수아비", episodeNumber: 8, broadDate: "2026-07-06", targetAge: 15,
    pipeline: { stage: "analyze", stageStatus: "progress", progress: 62, note: "3-Pass 분석 중" } },
  { id: "e4", programId: "p3", programTitle: "짐쌀라비", episodeNumber: 1, broadDate: "2026-07-09", targetAge: 0,
    pipeline: { stage: "publish", stageStatus: "error", blockedReason: "SMR 예약일 미설정으로 미게시 (3건)" } },
  { id: "e5", programId: "p1", programTitle: "전지적 참견 시점", episodeNumber: 313, broadDate: "2026-07-12", targetAge: 12,
    pipeline: { stage: "encode", stageStatus: "progress", progress: 45, note: "클립 2건 인코딩 중" } },
  { id: "e6", programId: "p4", programTitle: "놀면 뭐하니?", episodeNumber: 45, broadDate: "2026-07-11", targetAge: 12,
    pipeline: { stage: "recommend", stageStatus: "done", note: "추천 22건 · 채택 대기", progress: 100 } },
  { id: "e7", programId: "p4", programTitle: "놀면 뭐하니?", episodeNumber: 44, broadDate: "2026-07-04", targetAge: 12,
    pipeline: { stage: "publish", stageStatus: "done", note: "YT·SMR·Meta 게시 완료" } },
  { id: "e8", programId: "p2", programTitle: "허수아비", episodeNumber: 7, broadDate: "2026-06-29", targetAge: 15,
    pipeline: { stage: "publish", stageStatus: "warn", note: "YT 1건 실패 · 재시도 대기", blockedReason: "YouTube 업로드 실패 — 인증 만료" } },
  { id: "e9", programId: "p5", programTitle: "뭉쳐야 찬다", episodeNumber: 12, broadDate: "2026-07-13", targetAge: 7,
    pipeline: { stage: "recommend", stageStatus: "done", note: "추천 9건 · 채택 대기", progress: 100 } },
  { id: "e10", programId: "p5", programTitle: "뭉쳐야 찬다", episodeNumber: 11, broadDate: "2026-07-06", targetAge: 7,
    pipeline: { stage: "edit", stageStatus: "progress", note: "편집 검수 · 클립 3건 초안", progress: 60 } },
  { id: "e11", programId: "p6", programTitle: "아침 시사 브런치", episodeNumber: 88, broadDate: "2026-07-15", targetAge: 15,
    pipeline: { stage: "publish", stageStatus: "done", note: "SMR 게시 완료" } },
  { id: "e12", programId: "p1", programTitle: "전지적 참견 시점", episodeNumber: 310, broadDate: "2026-06-21", targetAge: 12,
    pipeline: { stage: "publish", stageStatus: "done", note: "3채널 배포 완료" } },
];

export const recommendations: Recommendation[] = [
  { id: "r1", episodeId: "e1", kind: "short", title: "이영자 폭소 리액션 모먼트", appeal: 5, startTime: 742, endTime: 776, people: ["이영자"], editNote: "첫 3초 훅 강함", status: "pending",
    thumbnailCandidates: [
      { id: "r1t1", atTime: 744, label: "리액션 클로즈업" },
      { id: "r1t2", atTime: 758, label: "폭소 순간" },
      { id: "r1t3", atTime: 770, label: "테이블 와이드" },
    ] },
  { id: "r2", episodeId: "e1", kind: "short", title: "홍현희 몸개그 하이라이트", appeal: 4, startTime: 1210, endTime: 1242, people: ["홍현희"], status: "pending",
    thumbnailCandidates: [
      { id: "r2t1", atTime: 1212, label: "동작 시작" },
      { id: "r2t2", atTime: 1228, label: "리액션" },
    ] },
  { id: "r3", episodeId: "e1", kind: "clip", title: "8분 요약 클립", appeal: 4, startTime: 0, endTime: 512, status: "pending",
    thumbnailCandidates: [
      { id: "r3t1", atTime: 12, label: "오프닝 타이틀" },
      { id: "r3t2", atTime: 240, label: "하이라이트" },
    ] },
  { id: "r4", episodeId: "e1", kind: "short", title: "게스트 등장 장면", appeal: 3, startTime: 300, endTime: 330, status: "pending" },

  // e6 · 놀면 뭐하니? 45화 — 채택 대기 큰 배치
  { id: "r5", episodeId: "e6", kind: "short", title: "유재석 즉흥 랩 폭소", appeal: 5, startTime: 155, endTime: 190, people: ["유재석"], editNote: "훅 강함, 자막 강조 추천", status: "pending",
    thumbnailCandidates: [
      { id: "r5t1", atTime: 158, label: "표정 클로즈업" },
      { id: "r5t2", atTime: 172, label: "리듬 타는 순간" },
      { id: "r5t3", atTime: 185, label: "폭소 반응" },
    ] },
  { id: "r6", episodeId: "e6", kind: "short", title: "하하 3초 멘탈 붕괴", appeal: 5, startTime: 640, endTime: 668, people: ["하하"], status: "pending",
    thumbnailCandidates: [
      { id: "r6t1", atTime: 642, label: "황당 리액션" },
      { id: "r6t2", atTime: 658, label: "얼굴 붉음" },
    ] },
  { id: "r7", episodeId: "e6", kind: "short", title: "정준하 폭식 하이라이트", appeal: 4, startTime: 1420, endTime: 1455, people: ["정준하"], status: "pending" },
  { id: "r8", episodeId: "e6", kind: "clip", title: "게스트 소개 5분", appeal: 3, startTime: 0, endTime: 300, status: "pending" },
  { id: "r9", episodeId: "e6", kind: "short", title: "MC들 단체 웃음 폭발", appeal: 4, startTime: 2110, endTime: 2145, people: ["유재석", "하하", "정준하"], editNote: "합본 컷 좋음", status: "pending",
    thumbnailCandidates: [
      { id: "r9t1", atTime: 2115, label: "단체 웃음" },
      { id: "r9t2", atTime: 2130, label: "유재석 클로즈업" },
    ] },
  { id: "r10", episodeId: "e6", kind: "short", title: "미니게임 승부 결정 순간", appeal: 4, startTime: 2810, endTime: 2842, status: "pending" },

  // e9 · 뭉쳐야 찬다 12화 — 채택 대기
  { id: "r11", episodeId: "e9", kind: "short", title: "안정환 헤딩 결승골", appeal: 5, startTime: 3210, endTime: 3245, people: ["안정환"], editNote: "슬로우 편집 권장", status: "pending",
    thumbnailCandidates: [
      { id: "r11t1", atTime: 3215, label: "점프 순간" },
      { id: "r11t2", atTime: 3232, label: "골 세리머니" },
    ] },
  { id: "r12", episodeId: "e9", kind: "short", title: "이동국 넉살 인터뷰", appeal: 3, startTime: 1120, endTime: 1152, people: ["이동국"], status: "pending" },
  { id: "r13", episodeId: "e9", kind: "clip", title: "전반전 하이라이트", appeal: 4, startTime: 0, endTime: 720, status: "pending",
    thumbnailCandidates: [
      { id: "r13t1", atTime: 60, label: "킥오프" },
      { id: "r13t2", atTime: 480, label: "역전골" },
    ] },

  // e5 · 전참시 313화 — 채택→인코딩(리니지 확인용)
  { id: "r14", episodeId: "e5", kind: "short", title: "이영자 반전 고백", appeal: 5, startTime: 512, endTime: 548, people: ["이영자"], status: "adopted", adoptedClipId: "c4",
    thumbnailCandidates: [{ id: "r14t1", atTime: 520, label: "고백 순간" }] },
  { id: "r15", episodeId: "e5", kind: "short", title: "홍현희 반응 컷", appeal: 4, startTime: 605, endTime: 630, people: ["홍현희"], status: "adopted", adoptedClipId: "c5" },
];

export const clips: Clip[] = [
  { id: "c1", episodeId: "e2", programTitle: "전지적 참견 시점", title: "이영자 먹방 하이라이트", clipType: "T6", clipCategory: "02", targetAge: 12, aspectRatio: "9:16-crop-main", durationSec: 34, thumbnailLabel: "리액션 클로즈업",
    synopsis: "이영자가 먹방 중 폭소하는 하이라이트 모먼트", status: "published",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260628103000" },
      { channel: "youtube", status: "published", reserveDate: "20260628110000", externalId: "enJbzwZnZZI" },
    ] },
  { id: "c2", episodeId: "e2", programTitle: "전지적 참견 시점", title: "311화 요약", clipType: "TZ", clipCategory: "02", targetAge: 12, aspectRatio: "16:9", durationSec: 498, thumbnailLabel: "오프닝 타이틀",
    synopsis: "전참시 311화 핵심 장면 8분 요약 클립", status: "published",
    distributions: [
      { channel: "smr", status: "scheduled", reserveDate: "20260712190000" },
      { channel: "youtube", status: "published", reserveDate: "20260630193000", externalId: "GOzKHs6CYAU" },
    ] },
  // c3: 짐쌀라비(p3) — 프로그램 SMR 설정 미완이라 SMR만 막힘. YouTube는 이미 게시됨.
  { id: "c3", episodeId: "e4", programTitle: "짐쌀라비", title: "유재석 오프닝", clipType: "T6", targetAge: 0, aspectRatio: "9:16-crop-main", durationSec: 28, thumbnailLabel: "유재석 등장",
    synopsis: "유재석의 오프닝 등장 숏폼", status: "published",
    distributions: [
      { channel: "smr", status: "failed", error: "예약일 빈값 — 네이버 미게시" },
      { channel: "youtube", status: "published", reserveDate: "20260709200000", externalId: "aB3kZ9xQp0" },
    ] },

  // e5 · 전참시 313화 — 채택→편집→인코딩 진행 (초안/인코딩 상태 표본)
  { id: "c4", episodeId: "e5", programTitle: "전지적 참견 시점", title: "이영자 반전 고백", clipType: "T6", clipCategory: "02", targetAge: 12,
    aspectRatio: "9:16-crop-main", durationSec: 36, thumbnailLabel: "고백 순간",
    synopsis: "이영자가 예상 밖 고백을 하는 반전 모먼트", status: "editing",
    sourceRecommendationId: "r14", targetChannel: "youtube_shorts", startTime: 512, endTime: 548,
    distributions: [] },
  { id: "c5", episodeId: "e5", programTitle: "전지적 참견 시점", title: "홍현희 반응 컷", clipType: "T6", clipCategory: "02", targetAge: 12,
    aspectRatio: "9:16-crop-main", durationSec: 25, thumbnailLabel: "리액션",
    synopsis: "홍현희의 폭소 리액션 짧은 컷", status: "encoding",
    sourceRecommendationId: "r15", targetChannel: "instagram_reels", startTime: 605, endTime: 630,
    distributions: [] },

  // e7 · 놀면 뭐하니? 44화 — 3채널 게시 완료 (풀 게시 표본)
  { id: "c6", episodeId: "e7", programTitle: "놀면 뭐하니?", title: "유재석 즉흥 랩 폭소", clipType: "T6", clipCategory: "02", targetAge: 12,
    aspectRatio: "9:16-crop-main", durationSec: 34, thumbnailLabel: "표정 클로즈업",
    synopsis: "유재석의 즉흥 랩과 멤버들 반응", status: "published", rendered: true, renderPreset: "youtube_shorts",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260704193000" },
      { channel: "youtube", status: "published", reserveDate: "20260704200000", externalId: "yt_hangout_c6" },
      { channel: "instagram", status: "published", reserveDate: "20260704210000" },
      { channel: "facebook", status: "published", reserveDate: "20260704210000" },
    ] },
  { id: "c7", episodeId: "e7", programTitle: "놀면 뭐하니?", title: "44화 8분 요약", clipType: "TZ", clipCategory: "02", targetAge: 12,
    aspectRatio: "16:9", durationSec: 486, thumbnailLabel: "오프닝",
    synopsis: "놀면 뭐하니 44화의 핵심 장면 8분 요약", status: "published", rendered: true, renderPreset: "smr",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260704220000" },
      { channel: "youtube", status: "scheduled", reserveDate: "20260716180000", externalId: "yt_hangout_c7" },
    ] },

  // e8 · 허수아비 7화 — YT 실패 (배포 재시도 화면용)
  { id: "c8", episodeId: "e8", programTitle: "허수아비", title: "김수현 오열 씬", clipType: "T6", clipCategory: "01", targetAge: 15,
    aspectRatio: "9:16-crop-main", durationSec: 42, thumbnailLabel: "오열 클로즈업",
    synopsis: "김수현의 오열 명장면", status: "published", rendered: true, renderPreset: "youtube_shorts",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260629221500" },
      { channel: "youtube", status: "failed", error: "인증 토큰 만료 — 재연결 필요" },
    ] },
  { id: "c9", episodeId: "e8", programTitle: "허수아비", title: "박은빈 반전 재회", clipType: "T6", clipCategory: "01", targetAge: 15,
    aspectRatio: "9:16-crop-main", durationSec: 38, thumbnailLabel: "재회 순간",
    synopsis: "박은빈의 반전 재회 하이라이트", status: "published", rendered: true, renderPreset: "youtube_shorts",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260629223000" },
      { channel: "youtube", status: "published", reserveDate: "20260629230000", externalId: "yt_scarecrow_c9" },
    ] },

  // e10 · 뭉쳐야 찬다 11화 — 편집 진행 (초안 여러 개)
  { id: "c10", episodeId: "e10", programTitle: "뭉쳐야 찬다", title: "안정환 결승골 슬로우", clipType: "T6", clipCategory: "02", targetAge: 7,
    aspectRatio: "9:16-crop-main", durationSec: 32, thumbnailLabel: "골 세리머니",
    synopsis: "안정환 결승골 슬로우 모션 편집", status: "editing",
    startTime: 3210, endTime: 3245,
    distributions: [] },
  { id: "c11", episodeId: "e10", programTitle: "뭉쳐야 찬다", title: "이동국 인터뷰 컷", clipType: "TI", clipCategory: "02", targetAge: 7,
    aspectRatio: "16:9", durationSec: 45, thumbnailLabel: "인터뷰",
    synopsis: "경기 후 이동국 짧은 인터뷰", status: "editing",
    distributions: [] },
  { id: "c12", episodeId: "e10", programTitle: "뭉쳐야 찬다", title: "전반전 하이라이트", clipType: "TH", clipCategory: "02", targetAge: 7,
    aspectRatio: "16:9", durationSec: 320, thumbnailLabel: "역전골",
    synopsis: "전반전 주요 장면 압축", status: "ready", rendered: true, renderPreset: "smr",
    distributions: [
      { channel: "smr", status: "pending" },
    ] },

  // e11 · 아침 시사 브런치 88화 — SMR만 (시사 카테고리)
  { id: "c13", episodeId: "e11", programTitle: "아침 시사 브런치", title: "오늘의 톱이슈 3분 브리핑", clipType: "TS", clipCategory: "04", targetAge: 15,
    aspectRatio: "16:9", durationSec: 178, thumbnailLabel: "톱이슈",
    synopsis: "당일 이슈 3분 요약 브리핑", status: "published", rendered: true, renderPreset: "smr",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260715080000" },
    ] },

  // e12 · 전참시 310화 — 3채널 게시 (오래된 표본)
  { id: "c14", episodeId: "e12", programTitle: "전지적 참견 시점", title: "레전드 회식 모먼트", clipType: "TH", clipCategory: "02", targetAge: 12,
    aspectRatio: "9:16-crop-main", durationSec: 48, thumbnailLabel: "리액션",
    synopsis: "310화 회식 하이라이트", status: "published", rendered: true, renderPreset: "youtube_shorts",
    distributions: [
      { channel: "smr", status: "published", reserveDate: "20260621230000" },
      { channel: "youtube", status: "published", reserveDate: "20260622000000", externalId: "yt_jch_c14" },
      { channel: "instagram", status: "published", reserveDate: "20260622013000" },
    ] },
];

export const jobs: JobEvent[] = [
  { id: "j1", label: "허수아비 8화 · 3-Pass 분석", stage: "analyze", status: "running", progress: 62, episodeId: "e3" },
  { id: "j2", label: "짐쌀라비 1화 · SMR 배포", stage: "publish", status: "failed", episodeId: "e4", needsAction: true },
  { id: "j3", label: "전참시 312화 · 추천 생성", stage: "recommend", status: "done", episodeId: "e1" },
  { id: "j4", label: "놀면 뭐하니 45화 · 추천 생성", stage: "recommend", status: "done", episodeId: "e6" },
  { id: "j5", label: "전참시 313화 · 클립 인코딩", stage: "encode", status: "running", progress: 45, episodeId: "e5" },
  { id: "j6", label: "뭉쳐야 찬다 12화 · 추천 생성", stage: "recommend", status: "done", episodeId: "e9" },
  { id: "j7", label: "놀면 뭐하니 44화 · Meta 배포", stage: "publish", status: "done", episodeId: "e7" },
  { id: "j8", label: "허수아비 7화 · YT 업로드", stage: "publish", status: "failed", episodeId: "e8", needsAction: true },
  { id: "j9", label: "뭉쳐야 찬다 11화 · 클립 인코딩", stage: "encode", status: "running", progress: 78, episodeId: "e10" },
];

// NOTE: the home inbox and sidebar badge counts are derived live from state in
// lib/data/store.tsx (they change as recommendations are adopted / clips published).
