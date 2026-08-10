/**
 * 미디어 이미지 URL 한 곳.
 *
 * `clip.thumbnailUrl` 은 **서버 상대 경로**(또는 GCS 오브젝트 경로)다. `<img src>` 에
 * 그대로 넣으면 아무것도 안 나온다 — 재설계 화면에서 실제로 그렇게 넣어서 썸네일이
 * 전부 비어 있었다. 매 화면이 각자 접두사를 붙이면 또 빠지므로 여기로 모은다.
 *
 * 폴백이 중요하다: 생성된 썸네일이 없는 클립이 대부분이라, 그때는 **원본에서 그 시각의
 * 프레임을 뽑아** 보여준다(`/media/:id/frame?t=`). 폴백이 없으면 목록이 회색 상자밭이 된다.
 */
import { API_BASE } from "@/lib/data/api";

/** 서버 상대 경로 → 절대 URL. 이미 절대면 그대로. */
export function absolute(relative: string | null | undefined): string | undefined {
  if (!relative) return undefined;
  return relative.startsWith("http") ? relative : `${API_BASE}${relative}`;
}

export interface ClipThumbSource {
  thumbnailUrl?: string;
  sourceMediaId?: string;
  mediaId?: string;
  startTime?: number;
}

/**
 * 클립 카드에 쓸 이미지.
 *  1. 생성/선택된 썸네일이 있으면 그것
 *  2. 없으면 원본의 시작 지점 프레임
 *  3. 원본도 모르면 undefined (호출부가 플레이스홀더를 그린다)
 */
export function clipThumbSrc(clip: ClipThumbSource): string | undefined {
  if (clip.thumbnailUrl) return absolute(clip.thumbnailUrl);
  const source = clip.sourceMediaId ?? clip.mediaId;
  if (!source) return undefined;
  const t = Math.max(0, clip.startTime ?? 0);
  return `${API_BASE}/media/${source}/frame?t=${t.toFixed(2)}`;
}

/** 회차 카드에 쓸 이미지 — 원본(master)의 대표 썸네일. */
export function mediaThumbSrc(mediaId: string | undefined): string | undefined {
  if (!mediaId) return undefined;
  return `${API_BASE}/media/${mediaId}/thumb`;
}

/** 렌더된 클립의 재생 URL. 렌더 전이면 undefined. */
export function clipVideoSrc(clip: { videoUrl?: string; rendered?: boolean }): string | undefined {
  if (!clip.rendered || !clip.videoUrl) return undefined;
  return absolute(clip.videoUrl);
}
