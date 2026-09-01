"use client";

/**
 * 배포 매트릭스 — **행=영상, 열=채널.** 한 영상이 어느 채널에 나갔는지 한눈에.
 *
 * 예전 배포 로그는 (클립×채널) 한 줄씩이라, 한 영상을 여러 채널에 올리면 줄이 흩어져
 * "이 영상 어디어디 나갔지?"가 안 보였다. 매트릭스는 그걸 한 행에 모은다.
 *
 * 상태 어휘는 **넷뿐이다** — 예약됨 · 게시 중(업로드 도는 몇 분만) · 게시됨 · 실패
 * (사용자 2026-08-26 "딱 이거만 심플하게"). 5개 채널 전부 실업로드가 되면서 '기록됨'과
 * '받은함 전송' 같은 중간 상태 표기는 뺐다 — recorded 행(게이트 OFF 시절 기록)은 파일이
 * 어디에도 안 올라간 것이므로 **빈 칸(＋)과 같게** 그린다(F4 "게시처럼 보이지 않기"의 강한 형태).
 * 지난 예약도 별도 라벨 없이 '예약됨' — 실제 공개는 youtube.reconcile 이 되읽어 확정하면
 * 그때 게시됨으로 바뀐다(추측 표기 없음).
 *
 * 셀 동작(작동하는 것만):
 *  - 빈 칸(＋ · recorded 포함) → 그 영상을 배포(발행 모달).
 *  - 실패 칸 → 재시도(자동 재시도 없음 · F4-4).
 *  - 게시·예약 칸 → 기록된 링크가 있으면 영상 열기.
 */
import { DISTRIBUTION_CHANNELS, type DistributionChannel } from "@/lib/constants";
import { EDIT_KIND_LABEL, type Clip } from "@/lib/types";
import { clipThumbSrc } from "@/lib/media-url";
import { shortReserve } from "@/lib/reserve-date";
import { fmtTime } from "@/lib/utils";

const CHANNELS = Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[];

const SHORT: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", facebook: "Facebook",
  tiktok: "TikTok", navertv: "네이버 TV", naverclip: "네이버 클립",
};

/** 상태별 칩 색 — 예약·게시 중·게시됨·실패 넷뿐(recorded 는 칩이 아니라 빈 칸으로 그린다). */
const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  published: { label: "게시됨", fg: "var(--sd-ok-strong, #2f7d32)", bg: "var(--sd-ok-bg, #eef7ee)" },
  scheduled: { label: "예약됨", fg: "var(--sd-warn, #8a5a00)", bg: "var(--sd-warn-bg, #fff4e5)" },
  pending: { label: "게시 중", fg: "var(--sd-accent, #2b6cb0)", bg: "var(--sd-accent-bg, #eaf2fb)" },
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
  // recorded(게이트 OFF 시절 기록) 는 파일이 어디에도 안 올라간 것 — 빈 칸과 같게 취급해
  // ＋ 로 그린다(다시 배포하면 그때 진짜 상태가 덮는다). 배지는 상태만 — origin 접미 없음.
  const d = clip.distributions?.find(
    (x) => x.channel === channel && x.status !== "none" && x.status !== "recorded");

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
  // 미래 예약은 **몇 시인지**를 보여주고, 지난 예약은 시각 없이 '예약됨' 으로 둔다 —
  // 실제 공개 여부는 youtube.reconcile 이 유튜브 상태를 되읽어 확정하고, 확정되면 이 칸이
  // 저절로 '게시됨' 이 된다(2026-08-26 상태 어휘 단순화 · 추측으로 '게시됨' 단정은 여전히 금지).
  if (d.status === "scheduled") {
    const at = d.reserveDate ? Date.parse(d.reserveDate) : NaN;
    const known = Number.isFinite(at);
    const past = known && at <= Date.now();
    // 예약 표기는 **reserve-date 단일 계약**을 쓴다(24시간제). 예전엔 여기서 직접
    // toLocaleString 을 불렀는데 ko-KR 은 12시간제가 기본이라 15:00 예약이 "오후 03:00" 으로
    // 찍혔다 — 15:00 으로 걸어 둔 사람이 목록에서 03:00 을 보고 다른 시각으로 읽는다.
    const when = known ? shortReserve(at) : null;
    const label = known && !past ? `예약 ${when}` : "예약됨";
    const tone = past
      ? { fg: "var(--sd-mut)", bg: "var(--sd-card-sub)" }   // 지난 예약은 '완료' 색을 주지 않는다
      : { fg: s.fg, bg: s.bg };
    const title = !known
      ? "예약 시각을 알 수 없습니다"
      : past
        ? `예약 시각(${when})이 지났습니다 — 실제 공개 여부를 자동 확인 중입니다(확인되면 게시됨으로 바뀝니다).`
        : `${when} 에 채널이 공개합니다 (업로드는 이미 끝났습니다)`;
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

  // 게시됨 + 링크 있음 → 영상 열기. 유튜브만이 아니라 네이버·인스타·페북도 같은 대접
  // (2026-08-25 사용자 "가능하면 다" — 서버는 이미 다 기록하고 있었고 화면만 버리고 있었다).
  if (d.status === "published" && link) {
    // ⚠️ 네이버(TV·클립)의 기록된 url 은 **시청자 링크가 아니라 스튜디오 주소**다.
    //    클립은 발행 뒤에도 /web/draft/<id> 에 머물고, 시청자용 naver.me 단축 링크는 공개 앱의
    //    '공유' 를 눌러야만 나와 발행 자동화가 알 수 없다(실측 2026-08-31). 그래서 여기서
    //    "영상 열기" 라고 부르지 않는다 — 눌렀더니 편집 화면이 뜨면 사람이 잘못 눌렀다고 생각한다.
    // 이 매트릭스가 그리는 채널에 navertv 는 없다(클립만) — 타입이 그걸 알고 있어
    // navertv 비교를 넣으면 타입 오류가 난다. 채널이 늘면 여기도 같이 늘려야 한다.
    const isNaver = channel === "naverclip";
    return (
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className="mx-auto inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium hover:brightness-95"
        style={{ background: s.bg, color: s.fg }}
        title={isNaver ? "네이버 스튜디오에서 열기 (시청자 링크는 앱의 '공유' 에서 받습니다)" : "영상 열기"}
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
