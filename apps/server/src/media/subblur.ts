/**
 * 원본 자막 블러(sub blur) — 클립 상태·순수 헬퍼.
 *
 * 해외 배포 클립에서 원본에 구운(burned-in) 자막을 가리는 기능의 **데이터 모양**이 여기 있다.
 * 검출(clip.subblur 잡 → core/vision/subtitle_blur.py)이 만든 이벤트(사각형+구간)를
 * `clip.subBlur` 에 저장하고, 렌더(/api/clips/:id/export)가 그걸 renderShort 의
 * `sourceBlur` 로 넘긴다. 켜고 끄는 스위치는 **editorState.subBlurOn** 이다 — editorState 는
 * 렌더 revision 해시에 통째로 들어가므로 토글만으로 캐시가 깨진다(재렌더 보장).
 *
 * 시간축: 이벤트는 **마스터 절대 초**다(clip.reframe 의 timeBase=master_absolute 와 같은 축).
 * 에디터 트림·목적지 길이 캡으로 렌더 창이 달라져도 좌표가 흔들리지 않고,
 * 렌더 직전에 windowSubBlurEvents() 가 렌더 창 기준으로 되베이스한다.
 */

export interface SubBlurEvent {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 마스터 절대 초. */
  start: number;
  end: number;
}

export interface ClipSubBlurState {
  status: "queued" | "running" | "ready" | "failed";
  /** 요청 식별 — 뒤늦게 도착한 옛 잡 결과가 새 요청 상태를 덮지 않게 한다(reframe 과 동일). */
  requestId: string;
  /** 검출 입력 지문(소스·구간·존). 어긋나면 stale — 재검출이 필요하다. */
  fingerprint: string;
  /** 자막 존 상단(높이 비율 0~1) — 검출이 이 위의 글자(로고·간판)를 무시했다는 기록. */
  zoneTop: number;
  jobId?: string | null;
  events?: SubBlurEvent[];
  /** 검출 당시 원본 해상도 — 이벤트 좌표의 좌표계 기록(렌더는 원본 좌표계에 블러를 건다). */
  width?: number;
  height?: number;
  requestedAt: number;
  updatedAt: number;
  detectedAt?: number;
  error?: string | null;
}

/** 검출 입력 지문 — 클립 구간이나 소스가 바뀌면 이벤트는 더 이상 그 클립의 것이 아니다. */
export function subBlurFingerprint(clip: Record<string, unknown>): string {
  const mediaId = String(clip.sourceMediaId ?? "");
  const start = Number(clip.startTime);
  const end = Number(clip.endTime);
  if (!mediaId) throw new Error("원본 영상(sourceMediaId)이 없습니다.");
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
    throw new Error("클립 구간이 올바르지 않습니다.");
  }
  return `${mediaId}:${start.toFixed(3)}:${end.toFixed(3)}:${SUBBLUR_ZONE_TOP}`;
}

/** 자막 존 기본값 — 화면 하단 28%(1080p 기준 y≥778). 로컬 실측(2026-09-15)에서 대사 자막
 *  밴드는 전부 이 안이었고, 이 위는 배경 간판 오검출이었다. */
export const SUBBLUR_ZONE_TOP = 0.72;

/** clip.subBlur 를 안전하게 읽는다 — 모양이 어긋나면 null(없는 것으로 취급). */
export function clipSubBlurState(clip: Record<string, unknown> | null | undefined): ClipSubBlurState | null {
  const raw = clip?.subBlur;
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<ClipSubBlurState>;
  if (s.status !== "queued" && s.status !== "running" && s.status !== "ready" && s.status !== "failed") return null;
  if (typeof s.requestId !== "string" || typeof s.fingerprint !== "string") return null;
  return s as ClipSubBlurState;
}

/**
 * 마스터 절대 이벤트를 렌더 창 기준으로 되베이스한다 — renderShort `sourceBlur` 의 입력.
 * 창 밖 이벤트는 버리고, 걸친 이벤트는 창 경계로 자른다. 퇴화 사각형(너무 작아 blur 가
 * 성립하지 않는 것)도 여기서 거른다 — ffmpeg boxblur 는 반경 > min(w,h)/2 면 죽는다.
 */
export function windowSubBlurEvents(
  events: SubBlurEvent[] | undefined,
  renderStart: number,
  renderEnd: number,
): SubBlurEvent[] {
  if (!Array.isArray(events)) return [];
  const out: SubBlurEvent[] = [];
  for (const ev of events) {
    if (!ev || !Number.isFinite(ev.start) || !Number.isFinite(ev.end)) continue;
    if (!(ev.end > renderStart) || !(ev.start < renderEnd)) continue;
    const w = Math.round(ev.w);
    const h = Math.round(ev.h);
    if (!(w >= 8) || !(h >= 8)) continue;
    out.push({
      x: Math.max(0, Math.round(ev.x)),
      y: Math.max(0, Math.round(ev.y)),
      w,
      h,
      start: Math.max(0, ev.start - renderStart),
      end: Math.min(renderEnd, ev.end) - renderStart,
    });
  }
  return out;
}
