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

  // 채널별 영상 링크 — 서버가 기록해 둔 것만 쓴다(추측 조립 금지). YouTube 는 videoId 로
  // 조립, 네이버는 워커가 남긴 url, Instagram·Facebook 은 Graph permalink. TikTok 은
  // 받은함 드래프트라 담당자가 앱에서 게시하기 전까지 공개 URL 이 존재하지 않는다.
  const link = d
    ? channel === "youtube" && d.externalId
      ? `https://www.youtube.com/watch?v=${d.externalId}`
      : (typeof d.url === "string" && d.url.startsWith("http") && d.url)
        || (typeof d.permalink === "string" && d.permalink.startsWith("http") && d.permalink)
        || null
    : null;

  // 아직 이 채널로 안 나감 — 누르면 배포.
  if (!d) {
    return (
      <button
        type="button"
        onClick={() => onPublish(clip)}
        className="mx-auto flex h-6 w-6 items-center justify-center rounded-[4px] text-[13px] leading-none opacity-65 hover:opacity-100"
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

  // ── 예약 칸 — **우리가 아는 것만 말한다.** ───────────────────────────────────
  //
  // 우리는 업로드하며 예약을 건 시점에 'scheduled' 로 적고 **그 뒤를 다시 확인하지 않는다**.
  // 그래서 예약 시각이 지나도 화면엔 계속 "예약됨" 이 남아, 유튜브에 가 보면 예약이 없고
  // 이미 공개돼 있다(2026-08-21 사용자 지적). 지난 건을 "게시됨" 으로 바꾸는 것도 거짓이다 —
  // 유튜브가 실제로 공개했는지 우리는 모른다(예약 실패·삭제·차단도 가능하다).
  // 그래서 ① 미래면 **몇 시 예약인지** 보여주고 ② 지나면 **확인이 필요하다**고 말한다.
  // 둘 다 영상으로 바로 갈 수 있게 링크를 건다 — 사용자가 실제로 하는 행동이 그거다.
  if (d.status === "scheduled") {
    const at = d.reserveDate ? Date.parse(d.reserveDate) : NaN;
    const known = Number.isFinite(at);
    const past = known && at <= Date.now();
    const when = known
      ? new Date(at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : null;
    const label = !known ? "예약됨" : past ? "게시 확인" : `예약 ${when}`;
    const tone = past
      ? { fg: "var(--sd-mut)", bg: "var(--sd-card-sub)" }   // 지난 예약은 '완료' 색을 주지 않는다
      : { fg: s.fg, bg: s.bg };
    const title = !known
      ? "예약 시각을 알 수 없습니다"
      : past
        ? `예약 시각(${when})이 지났습니다 — 실제 공개 여부는 채널에서 확인해 주세요. STEP D 는 예약을 건 뒤 상태를 다시 읽지 않습니다.`
        : `${when} 에 유튜브가 공개합니다 (업로드는 이미 끝났습니다)`;
    const chip = (
      <span
        className="mx-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium"
        style={{ background: tone.bg, color: tone.fg }}
        title={title}
      >
        ● {label}{link ? " ↗" : ""}
      </span>
    );
    return link ? (
      <a href={link} target="_blank" rel="noreferrer" className="mx-auto inline-flex hover:brightness-95">
        {chip}
      </a>
    ) : chip;
  }

  // 틱톡 받은함 초안 — status 는 published 로 기록되지만 **채널에 공개된 게 아니다**
  // (계정 주인이 틱톡 앱 받은함에서 편집·게시해야 뜬다). 초록 "게시됨"으로 그리면
  // "게시됐다는데 채널에 없다"는 혼란이 된다(사용자 2026-08-25). 다이렉트 게시가 켜져
  // 게시물 링크(url)가 기록된 행만 아래 published 분기로 내려가 초록+링크가 된다.
  if (d.status === "published" && channel === "tiktok" && !link) {
    return (
      <span
        className="mx-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium"
        style={{ background: STATUS.scheduled.bg, color: STATUS.scheduled.fg }}
        title="틱톡 앱 받은함에 초안으로 전송됐습니다 — 계정 주인이 앱(알림·받은함)에서 편집·게시해야 채널에 공개됩니다."
      >
        ● 받은함 전송
      </span>
    );
  }

  // 게시됨 + 링크 있음 → 영상 열기. 유튜브만이 아니라 네이버·인스타·페북도 같은 대접
  // (2026-08-25 사용자 "가능하면 다" — 서버는 이미 다 기록하고 있었고 화면만 버리고 있었다).
  if (d.status === "published" && link) {
    return (
      <a
        href={link}
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
      title={
        d.reserveDate ? `예약 ${d.reserveDate}`
          : channel === "tiktok" ? `${s.label} — 받은함 드래프트는 담당자가 TikTok 앱에서 게시해야 공개 URL 이 생깁니다`
          : s.label
      }
    >
      ● {s.label}
    </span>
  );
}
