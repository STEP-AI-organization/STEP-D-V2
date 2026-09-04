"use client";

/**
 * 배포 매트릭스 — **행=영상, 열=채널.** 한 영상이 어느 채널에 나갔는지 한눈에.
 *
 * 마크업은 디자이너 산출물(`STEPD_SaaS_UI_V1/src/app/edits/page.tsx` 245–348 ·
 * `.../distribution/page.tsx` 244–256 의 상태 알약)을 그대로 옮긴 것이다.
 * 원본 표는 **행이 map 이 아니라 리터럴 1개**이고 채널 5칸이 전부 같은 ＋ 버튼이라
 * 상태 분기가 아예 없다 — 아래 `Cell` 이 그 자리를 채운다.
 *
 * 예전 배포 로그는 (클립×채널) 한 줄씩이라, 한 영상을 여러 채널에 올리면 줄이 흩어져
 * "이 영상 어디어디 나갔지?"가 안 보였다. 매트릭스는 그걸 한 행에 모은다.
 *
 * 상태 어휘는 **넷뿐이다** — 예약됨 · 게시 중(업로드 도는 몇 분만) · 게시됨 · 실패
 * (사용자 2026-08-26 "딱 이거만 심플하게"). 5개 채널 전부 실업로드가 되면서 '기록됨'과
 * '받은함 전송' 같은 중간 상태 표기는 뺐다 — recorded 행(게이트 OFF 시절 기록)은 파일이
 * 어디에도 안 올라간 것이므로 **빈 칸(＋)과 같게** 그린다(F4 "게시처럼 보이지 않기"의 강한 형태).
 * 지난 예약도 별도 라벨 없이 '예약' — 실제 공개는 youtube.reconcile 이 되읽어 확정하면
 * 그때 게시됨으로 바뀐다(추측 표기 없음).
 *
 * 셀 동작(작동하는 것만):
 *  - 빈 칸(＋ · recorded 포함) → 그 영상을 **그 채널로** 배포(발행 모달이 해당 플랫폼을 미리 고른다).
 *  - 실패 칸 → 재시도(자동 재시도 없음 · F4-4).
 *  - 게시·예약 칸 → 기록된 링크가 있으면 영상 열기.
 *  - 유튜브에 나간 행 → '제목수정' 으로 **올라간 영상의 제목/설명을 고쳐 반영**(재발행 아님).
 */
import type { ReactNode } from "react";
import { Check, Film, Plus, Send, ArrowUpRight, RotateCw } from "lucide-react";

import { DISTRIBUTION_CHANNELS, type DistributionChannel } from "@/lib/constants";
import { EDIT_KIND_LABEL, type Clip } from "@/lib/types";
import { clipThumbSrc } from "@/lib/media-url";
import { shortReserve } from "@/lib/reserve-date";
import { fmtTime } from "@/lib/utils";

const CHANNELS = Object.keys(DISTRIBUTION_CHANNELS) as DistributionChannel[];

/** 원본 `<th>` 글자와 1:1 (YouTube · Instagram · Facebook · TikTok · 네이버 클립). */
const SHORT: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", facebook: "Facebook",
  tiktok: "TikTok", navertv: "네이버 TV", naverclip: "네이버 클립",
};

/** 상태별 알약 색 — 원본 배포 화면(distribution/page.tsx:250)의 초록 알약에서 톤만 갈랐다. */
const TONE = {
  published: "bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400",
  scheduled: "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400",
  past: "bg-slate-200/80 text-slate-600 dark:bg-[#282B35] dark:text-slate-300",
  pending: "bg-[#1C60FF]/10 text-[#1C60FF] dark:bg-[#1C60FF]/20 dark:text-[#60A5FA]",
  failed: "bg-rose-500/15 text-rose-500 dark:bg-rose-500/20 dark:text-rose-400",
} as const;

const PILL = "w-6 h-6 sm:w-[72px] sm:h-6 rounded-full text-[11px] font-bold inline-flex items-center justify-center gap-0.5 mx-auto border-none";
/** 예약 칸만 시각이 붙어 72px 를 넘긴다 — 폭을 내용에 맞춘다(색·높이·모양은 동일). */
const PILL_WIDE = "h-6 px-2 rounded-full text-[11px] font-bold inline-flex items-center justify-center gap-0.5 mx-auto border-none whitespace-nowrap";

export interface MatrixRow {
  clip: Clip;
  programTitle: string;
  episodeNumber?: number;
}

export function DistributionMatrix({
  rows,
  onPublish,
  onRetry,
  onEditMeta,
  footer,
}: {
  rows: MatrixRow[];
  /**
   * 빈 채널 칸/배포 버튼 → 이 영상을 발행 모달로. `channel` 은 그 칸의 플랫폼 —
   * 열을 나눠 그려 놓고 아무것도 안 골라 주면 사람이 엉뚱한 채널을 고른다.
   */
  onPublish: (clip: Clip, channel?: DistributionChannel) => void;
  onRetry: (clipId: string, channel: DistributionChannel) => void;
  /**
   * 이미 유튜브에 올라간 영상의 **제목/설명을 고쳐 채널에 반영**한다 (재발행 아님).
   * 배포된 뒤에 오타·제목 교체가 생기는 건 흔한데, 여기서 갈 곳이 없으면 사람은
   * 재발행을 누르거나(같은 영상이 하나 더 생긴다) 유튜브 스튜디오로 나가 버린다.
   */
  onEditMeta?: (clip: Clip) => void;
  /** 표 카드 **안** 아래쪽에 붙는 줄 — 원본의 페이지네이션 자리(distribution/page.tsx:336). */
  footer?: ReactNode;
}) {
  return (
    <div className="w-full rounded-xl bg-[var(--color-bg-card)] border-none shadow-md shadow-slate-900/5 dark:shadow-none overflow-hidden flex flex-col">
      <div className="w-full overflow-x-auto">
        <table className="w-full table-fixed text-left border-collapse text-xs">
          {/* 폭은 채널 5개 전제다(48 + 8.8×5 + 8 = 100%). 채널이 늘면 여기 폭도 같이 고칠 것. */}
          <thead className="bg-[var(--color-bg-input)]/90 backdrop-blur-xs border-b border-[var(--color-border-subtle)] text-[11px] text-[var(--color-text-muted)] font-medium">
            <tr>
              <th className="py-3 px-4 w-[40%] sm:w-[48%] truncate">영상</th>
              {CHANNELS.map((ch) => (
                <th key={ch} className="py-3 w-[8.8%] text-center truncate">
                  {SHORT[ch] ?? ch}
                </th>
              ))}
              <th className="py-3 px-4 w-[8%] text-right truncate"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-subtle)]/60">
            {rows.map(({ clip, programTitle, episodeNumber }) => {
              const thumb = clipThumbSrc(clip);
              const onYoutube = (clip.distributions ?? []).some(
                (d) => d.channel === "youtube" && d.externalId,
              );
              return (
                <tr key={clip.id} className="hover:bg-[var(--color-bg-input)]/40 transition-colors">
                  {/* Video info tile */}
                  <td className="py-3 px-4 w-[40%] sm:w-[48%] overflow-hidden">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-20 h-11 rounded-lg bg-slate-800 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-hidden relative shrink-0 hidden sm:flex items-center justify-center">
                        {thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumb} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 bg-gradient-to-tr from-slate-800/80 to-slate-700/60 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
                            <Film className="w-4 h-4 text-slate-400 opacity-50" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <h4
                          className="font-bold text-[var(--color-text-primary)] text-xs truncate block max-w-full"
                          title={clip.title || "무제"}
                        >
                          {clip.title || "무제"}
                        </h4>
                        <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5 truncate block">
                          {/* 회차·유형은 **있을 때만** 붙인다 — 원본은 '1화' 를 늘 그린다(날조). */}
                          {programTitle}
                          {episodeNumber != null ? ` · ${episodeNumber}화` : ""}
                          {clip.editKind ? ` · ${EDIT_KIND_LABEL[clip.editKind]}` : ""} ·{" "}
                          {fmtTime(clip.durationSec || Math.max(0, (clip.endTime ?? 0) - (clip.startTime ?? 0)))}
                        </p>
                      </div>
                    </div>
                  </td>

                  {CHANNELS.map((ch) => (
                    <td key={ch} className="py-3 w-[8.8%] text-center">
                      <Cell clip={clip} channel={ch} onPublish={onPublish} onRetry={onRetry} />
                    </td>
                  ))}

                  {/* Deploy Button Column */}
                  <td className="py-3 px-4 w-[8%] text-right shrink-0">
                    <div className="flex items-center justify-end gap-1.5">
                      {onEditMeta && onYoutube && (
                        <button
                          type="button"
                          onClick={() => onEditMeta(clip)}
                          title="올라간 영상의 제목·설명을 고쳐 유튜브에 반영 (재업로드 아님)"
                          className="h-7 px-2.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium text-xs transition-colors cursor-pointer inline-flex items-center justify-center whitespace-nowrap"
                        >
                          제목수정
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onPublish(clip)}
                        title="채널 선택해서 배포"
                        className="h-7 w-7 sm:w-auto sm:px-3.5 rounded-full bg-[#222222] dark:bg-[#1C60FF] text-white hover:bg-black dark:hover:bg-[#0D1EB8] font-medium text-xs transition-colors cursor-pointer shadow-none border-none inline-flex items-center justify-center gap-1 shrink-0 whitespace-nowrap ml-auto"
                      >
                        <span className="hidden sm:inline">배포</span>
                        <Send className="w-3 h-3 fill-current shrink-0" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
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
  onPublish: (clip: Clip, channel?: DistributionChannel) => void;
  onRetry: (clipId: string, channel: DistributionChannel) => void;
}) {
  // recorded(게이트 OFF 시절 기록) 는 파일이 어디에도 안 올라간 것 — 빈 칸과 같게 취급해
  // ＋ 로 그린다(다시 배포하면 그때 진짜 상태가 덮는다).
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

  // 아직 이 채널로 안 나감 — 누르면 그 채널로 배포.
  if (!d) {
    return (
      <button
        type="button"
        onClick={() => onPublish(clip, channel)}
        title={`${SHORT[channel] ?? channel} 로 배포`}
        className="w-7 h-7 rounded-lg border border-dashed border-[var(--color-border-subtle)] hover:border-[#1C60FF] hover:bg-[#1C60FF]/10 text-[var(--color-text-muted)] hover:text-[#1C60FF] inline-flex items-center justify-center transition-colors cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    );
  }

  if (d.status === "failed") {
    return (
      <button
        type="button"
        onClick={() => onRetry(clip.id, channel)}
        title={`${d.error ?? "실패"} — 재시도`}
        className={`${PILL} ${TONE.failed} cursor-pointer hover:opacity-80 transition-opacity`}
      >
        <span className="hidden sm:inline">실패</span>
        <RotateCw className="w-3 h-3 stroke-[2.2]" />
      </button>
    );
  }

  // ── 예약 칸 — **우리가 아는 것만 말한다.** ───────────────────────────────────
  //
  // 미래 예약은 **몇 시인지**를 보여주고, 지난 예약은 시각 없이 '예약' 으로 둔다 —
  // 실제 공개 여부는 youtube.reconcile 이 유튜브 상태를 되읽어 확정하고, 확정되면 이 칸이
  // 저절로 '게시' 가 된다(2026-08-26 상태 어휘 단순화 · 추측으로 '게시됨' 단정은 여전히 금지).
  if (d.status === "scheduled") {
    const at = d.reserveDate ? Date.parse(d.reserveDate) : NaN;
    const known = Number.isFinite(at);
    const past = known && at <= Date.now();
    // 예약 표기는 **reserve-date 단일 계약**을 쓴다(24시간제). 예전엔 여기서 직접
    // toLocaleString 을 불렀는데 ko-KR 은 12시간제가 기본이라 15:00 예약이 "오후 03:00" 으로
    // 찍혔다 — 15:00 으로 걸어 둔 사람이 목록에서 03:00 을 보고 다른 시각으로 읽는다.
    const when = known ? shortReserve(at) : null;
    const label = known && !past ? `예약 ${when}` : "예약";
    const title = !known
      ? "예약 시각을 알 수 없습니다"
      : past
        ? `예약 시각(${when})이 지났습니다 — 실제 공개 여부를 자동 확인 중입니다(확인되면 게시됨으로 바뀝니다).`
        : `${when} 에 채널이 공개합니다 (업로드는 이미 끝났습니다)`;
    // 지난 예약은 '완료' 색을 주지 않는다.
    const cls = `${known && !past ? PILL_WIDE : PILL} ${past ? TONE.past : TONE.scheduled}`;
    return link ? (
      <a href={link} target="_blank" rel="noreferrer" title={title} className={`${cls} cursor-pointer hover:opacity-80 transition-opacity`}>
        <span className="hidden sm:inline">{label}</span>
        <ArrowUpRight className="w-3 h-3 stroke-[2.2]" />
      </a>
    ) : (
      <span title={title} className={cls}>
        <span className="hidden sm:inline">{label}</span>
        <Check className="w-3 h-3 stroke-[2.5] inline sm:hidden" />
      </span>
    );
  }

  // 게시됨 + 링크 있음 → 영상 열기. 유튜브만이 아니라 네이버·인스타·페북도 같은 대접
  // (2026-08-25 사용자 "가능하면 다" — 서버는 이미 다 기록하고 있었고 화면만 버리고 있었다).
  if (d.status === "published" && link) {
    // ⚠️ 네이버(TV·클립)의 기록된 url 은 **시청자 링크가 아니라 스튜디오 주소**다.
    //    클립은 발행 뒤에도 /web/draft/<id> 에 머물고, 시청자용 naver.me 단축 링크는 공개 앱의
    //    '공유' 를 눌러야만 나와 발행 자동화가 알 수 없다(실측 2026-08-31). 그래서 여기서
    //    "게시물 보기" 라고 부르지 않는다 — 눌렀더니 편집 화면이 뜨면 사람이 잘못 눌렀다고 생각한다.
    const isNaver = channel === "naverclip";
    return (
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        title={isNaver ? "네이버 스튜디오에서 열기 (시청자 링크는 앱의 '공유' 에서 받습니다)" : "게시물 보기"}
        className={`${PILL} ${TONE.published} cursor-pointer hover:opacity-80 transition-opacity`}
      >
        <span className="hidden sm:inline">게시</span>
        <ArrowUpRight className="w-3 h-3 stroke-[2.2]" />
      </a>
    );
  }

  const label = d.status === "published" ? "게시" : "게시 중";
  return (
    <span
      title={label}
      className={`${PILL} ${d.status === "published" ? TONE.published : TONE.pending}`}
    >
      <span className="hidden sm:inline">{label}</span>
      <Check className="w-3 h-3 stroke-[2.5] inline sm:hidden" />
    </span>
  );
}
