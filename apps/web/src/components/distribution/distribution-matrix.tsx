"use client";

/**
 * 배포 매트릭스 — **행=영상, 열=채널.** 한 영상이 어느 채널에 나갔는지 한눈에.
 *
 * 예전 배포 로그는 (클립×채널) 한 줄씩이라, 한 영상을 여러 채널에 올리면 줄이 흩어져
 * "이 영상 어디어디 나갔지?"가 안 보였다. 매트릭스는 그걸 한 행에 모은다.
 *
 * 셀 동작(작동하는 것만):
 *  - 빈 칸(＋) → 그 영상을 배포(발행 모달). 아직 안 나간 채널로 바로 보낸다.
 *  - 실패 칸 → 재시도(자동 재시도 없음 · F4-4).
 *  - YouTube 게시 칸 → 영상 열기(외부 링크).
 *  - 그 외 상태(게시·예약·기록·진행) → 표시만.
 */
import { DISTRIBUTION_CHANNELS, type DistributionChannel } from "@/lib/constants";
import { EDIT_KIND_LABEL, type Clip } from "@/lib/types";
import { clipThumbSrc } from "@/lib/media-url";
import { fmtTime } from "@/lib/utils";

const CHANNELS = Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[];

const SHORT: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", facebook: "Facebook",
  tiktok: "TikTok", navertv: "네이버 TV", naverclip: "네이버 클립",
};

/** 상태별 칩 색. 기록됨은 게시가 아니므로 초록을 주지 않는다(F4 Invariant). */
const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  published: { label: "게시됨", fg: "var(--sd-ok-strong, #2f7d32)", bg: "var(--sd-ok-bg, #eef7ee)" },
  scheduled: { label: "예약됨", fg: "var(--sd-warn, #8a5a00)", bg: "var(--sd-warn-bg, #fff4e5)" },
  pending: { label: "진행 중", fg: "var(--sd-accent, #2b6cb0)", bg: "var(--sd-accent-bg, #eaf2fb)" },
  recorded: { label: "기록됨", fg: "var(--sd-mut)", bg: "var(--sd-card-sub)" },
  failed: { label: "실패", fg: "var(--sd-danger-strong, #a11)", bg: "var(--sd-danger-bg, #fdecec)" },
};

export interface MatrixRow {
  clip: Clip;
  programTitle: string;
  episodeNumber?: number;
}

export function DistributionMatrix({
  rows,
  onPublish,
  onRetry,
}: {
  rows: MatrixRow[];
  /** 빈 채널 칸/배포 버튼 → 이 영상을 발행 모달로. */
  onPublish: (clip: Clip) => void;
  onRetry: (clipId: string, channel: DistributionChannel) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-[6px]" style={{ border: "1px solid var(--sd-border)" }}>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr style={{ background: "var(--sd-card-sub)" }}>
            <th
              className="sticky left-0 z-10 px-3 py-2 text-left text-[11px] font-semibold"
              style={{ background: "var(--sd-card-sub)", color: "var(--sd-mut)", minWidth: 220 }}
            >
              영상
            </th>
            {CHANNELS.map((ch) => (
              <th
                key={ch}
                className="whitespace-nowrap px-2 py-2 text-center text-[10.5px] font-semibold"
                style={{ color: "var(--sd-mut)", minWidth: 74 }}
                title={SHORT[ch]}
              >
                {SHORT[ch]}
              </th>
            ))}
            <th style={{ minWidth: 56 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ clip, programTitle, episodeNumber }) => {
            const thumb = clipThumbSrc(clip);
            return (
              <tr key={clip.id} style={{ borderTop: "1px solid var(--sd-border)" }}>
                <td
                  className="sticky left-0 z-10 px-3 py-2"
                  style={{ background: "var(--sd-bg, #fff)", minWidth: 220 }}
                >
                  <div className="flex items-center gap-2">
                    <div className="sd-ph h-[34px] w-[60px] shrink-0 overflow-hidden rounded-[3px]">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumb} alt="" loading="lazy" className="size-full object-cover" />
                      ) : null}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium" style={{ color: "var(--sd-fg)" }}>
                        {clip.title || "무제"}
                      </div>
                      <div className="sd-mono truncate text-[10px]" style={{ color: "var(--sd-mut)" }}>
                        {programTitle}
                        {episodeNumber != null ? ` · ${episodeNumber}화` : ""}
                        {clip.editKind ? ` · ${EDIT_KIND_LABEL[clip.editKind]}` : ""} · {fmtTime(clip.durationSec || Math.max(0, (clip.endTime ?? 0) - (clip.startTime ?? 0)))}
                      </div>
                    </div>
                  </div>
                </td>

                {CHANNELS.map((ch) => (
                  <td key={ch} className="px-1.5 py-2 text-center align-middle">
                    <Cell clip={clip} channel={ch} onPublish={onPublish} onRetry={onRetry} />
                  </td>
                ))}

                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    className="sd-btn"
                    onClick={() => onPublish(clip)}
                    title="채널 선택해서 배포"
                  >
                    배포+
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  clip,
  channel,
  onPublish,
  onRetry,
}: {
  clip: Clip;
  channel: DistributionChannel;
  onPublish: (clip: Clip) => void;
  onRetry: (clipId: string, channel: DistributionChannel) => void;
}) {
  const d = clip.distributions?.find((x) => x.channel === channel && x.status !== "none");
  // 배지는 상태만 보여준다 — origin(수동/자동) 접미는 붙이지 않는다(2026-08-18).

  // 아직 이 채널로 안 나감 — 누르면 배포.
  if (!d) {
    return (
      <button
        type="button"
        onClick={() => onPublish(clip)}
        className="mx-auto flex h-6 w-6 items-center justify-center rounded-[4px] text-[13px] leading-none opacity-40 hover:opacity-100"
        style={{ border: "1px dashed var(--sd-border)", color: "var(--sd-mut)" }}
        title={`${SHORT[channel] ?? channel} 로 배포`}
      >
        ＋
      </button>
    );
  }

  const s = STATUS[d.status] ?? STATUS.recorded;

  if (d.status === "failed") {
    return (
      <button
        type="button"
        onClick={() => onRetry(clip.id, channel)}
        className="mx-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium hover:brightness-95"
        style={{ background: s.bg, color: s.fg }}
        title={`${d.error ?? "실패"} — 재시도`}
      >
        ● 실패 ↻
      </button>
    );
  }

  if (d.status === "published" && channel === "youtube" && d.externalId) {
    return (
      <a
        href={`https://www.youtube.com/watch?v=${d.externalId}`}
        target="_blank"
        rel="noreferrer"
        className="mx-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium hover:brightness-95"
        style={{ background: s.bg, color: s.fg }}
        title="영상 열기"
      >
        ● 게시 ↗
      </a>
    );
  }

  return (
    <span
      className="mx-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ background: s.bg, color: s.fg }}
      title={d.reserveDate ? `예약 ${d.reserveDate}` : s.label}
    >
      ● {s.label}
    </span>
  );
}
