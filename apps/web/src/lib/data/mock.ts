/**
 * STEP-D — mock data layer (milestone M0/M1).
 *
 * Deterministic, in-memory sample data shaped exactly like the domain types.
 * This is the single data seam: milestone M6 replaces these functions with calls
 * to the real STEPD SPFN RPC API without touching any screen. (plan decision D3)
 */
import type { Clip, Connections, Episode, JobEvent, Program, Recommendation } from "@/lib/types";

/** Account-level channel connections (set once). SMR needs none (internal feed). */
export const connections: Connections = { youtube: true, meta: true, metaInstagram: true };

export const programs: Program[] = [
  { id: "p1", title: "전지적 참견 시점", section: "예능", targetAge: 12, cast: ["이영자", "홍현희"], episodeCount: 3, status: "active",
    smr: { programCode: "jeonchamsi", category: "02", weekdays: [6], posterReady: true, thumbnailReady: true } },
  { id: "p2", title: "허수아비", section: "드라마", targetAge: 15, cast: ["김수현"], episodeCount: 2, status: "active",
    smr: { programCode: "heosuabi", category: "01", weekdays: [5, 6], posterReady: true, thumbnailReady: true } },
  // p3: SMR 프로그램 설정 미완 — 코드·편성요일·포스터 누락. 클립을 SMR에 올리려면 프로그램 준비부터 완료해야 함.
  { id: "p3", title: "짐쌀라비", section: "예능", targetAge: 0, cast: ["유재석"], episodeCount: 1, status: "active",
    smr: { category: "02", weekdays: [], posterReady: false, thumbnailReady: true } },
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
];

export const jobs: JobEvent[] = [
  { id: "j1", label: "허수아비 8화 · 3-Pass 분석", stage: "analyze", status: "running", progress: 62, episodeId: "e3" },
  { id: "j2", label: "짐쌀라비 1화 · SMR 배포", stage: "publish", status: "failed", episodeId: "e4", needsAction: true },
  { id: "j3", label: "전참시 312화 · 추천 생성", stage: "recommend", status: "done", episodeId: "e1" },
];

// NOTE: the home inbox and sidebar badge counts are derived live from state in
// lib/data/store.tsx (they change as recommendations are adopted / clips published).
