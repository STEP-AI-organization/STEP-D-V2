"use client";

/**
 * ShortsCard — 파이프라인이 뽑은 쇼츠 후보 하나를 시각 카드로 표시.
 * 검증 흐름: 썸네일 클릭 → 상단 원본 플레이어가 그 순간으로 seek+재생 →
 * "그럴싸하다" 싶으면 [채택] 또는 [채택+편집] → 편집기로 이동.
 *
 * short(파이프라인 산출물)와 rec(추천 보드에 등록된 아이템)를 시간창으로 페어링 —
 * 서버가 shorts를 1:1로 recFromShort() 하지만 rec DB에 아직 안 실려 있을 수도 있어
 * 그 경우 카드는 표시만 되고 채택 버튼은 비활성.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play, Check, Pencil, Loader2, Zap } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppData } from "@/lib/data/store";
import { useToast } from "@/components/ui/toast";
import { useVideoSeek } from "./episode/seek-context";
import { frameUrl, mediaUrl, type AnalysisShort } from "@/lib/data/api";
import type { Recommendation } from "@/lib/types";
import { formatTimecode } from "@/lib/utils";
import { cn } from "@/lib/utils";

import { ThumbnailPicker } from "./thumbnail-picker";

/** 매칭 관용 시간창 — recFromShort()가 0.1초 이내로 그대로 옮기지만
 *  간혹 라운딩·재분석 후 변형이 있어 넉넉히 잡음. */
const REC_MATCH_TOLERANCE_SEC = 1.0;

/** 인정되는 hook 카테고리(단일 진실 소스는 core/recommend.py HOOK_KEYS + "기타").
 *  clip 타입 propose_clips 프롬프트가 hook을 자유서술로 넣는 회귀가 있어(m_5ec98a5a #5·#6, 문장 72~76자)
 *  이 화이트리스트로 걸러 UI에 서술 텍스트가 뱃지로 새는 것을 원천 차단. */
const HOOK_CATEGORIES: ReadonlySet<string> = new Set([
  "반전", "감정고조", "돌직구", "질문", "정보성", "웃음", "갈등", "공감", "기타",
]);

export function ShortsCard({
  short,
  index,
  mediaId,
  episodeId,
  apiBase,
}: {
  short: AnalysisShort;
  index: number;
  mediaId: string;
  episodeId: string;
  apiBase: string;
}) {
  const router = useRouter();
  const { adoptRecommendation, rejectRecommendation, recsForEpisode, selectThumbnail } = useAppData();
  const { toast } = useToast();
  const seek = useVideoSeek();
  const [busy, setBusy] = useState<null | "adopt" | "edit">(null);

  const rec = matchRec(recsForEpisode(episodeId), short);
  const status = rec?.status ?? "unregistered";
  const duration = Math.max(0, (short.end ?? 0) - (short.start ?? 0));
  // 썸네일 프레임 시점 — 클립은 시작·앞 부분에 방송의 "예고 자막"(원본에 인코딩)이 계속
  // 남아있는 경우가 많음. 클립은 **정중앙 프레임** 사용 (안내 자막 대부분 지나감).
  // 숏폼은 훅이 시작에 있어야 하므로 시작 유지.
  const shortType = (short as any).type;
  const thumbTime =
    shortType === "shortform"
      ? short.start
      : short.start + duration * 0.5;  // 클립·하이라이트는 정중앙
  const src = frameUrl(apiBase, mediaId, thumbTime);

  async function doAdopt(edit: boolean) {
    if (!rec || busy) return;
    setBusy(edit ? "edit" : "adopt");
    try {
      const clipId = await adoptRecommendation(rec.id);
      toast({
        title: "채택됨",
        description: `${short.title || "쇼츠 후보"} · 클립을 생성했습니다.`,
        tone: "done",
      });
      if (edit && clipId) router.push(`/editor/${clipId}`);
    } catch (err) {
      toast({ title: "채택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function doReject() {
    if (!rec) return;
    rejectRecommendation(rec.id, "품질 낮음");
    toast({ title: "반려", description: "이 후보를 반려 처리했습니다.", tone: "warn" });
  }

  // score100 근거 (2026-08-06~ 결정론 4축). 옛 회차는 없어서 아래 LLM 3축으로 폴백.
  // AnalysisShort 는 core 원본 스키마(snake_case)다 — Recommendation 의 camelCase 와 다르다.
  const scoreParts =
    short.score_parts && typeof short.score_parts === "object" ? short.score_parts : undefined;

  // score100 이 있으면 그걸 우선, 없으면 legacy appeal(1-5)에서 (a-1)*25로 역산.
  // 이렇게 두면 아직 재분석 안 된 옛 회차도 카드가 깨지지 않고, 정밀 재분석 후엔 자동으로 score100 반영.
  const score =
    typeof short.score100 === "number"
      ? Math.round(short.score100)
      : typeof short.appeal === "number"
        ? Math.round((short.appeal - 1) * 25)
        : null;
  const scoreTone =
    score == null
      ? "bg-black/70 text-white"
      : score >= 75
        ? "bg-status-warn text-black"
        : score >= 55
          ? "bg-status-warn/80 text-black"
          : "bg-black/70 text-white";

  return (
    <Card className={cn("overflow-hidden p-0", status === "adopted" && "ring-1 ring-status-done/40")}>
      {/* Thumbnail — 클릭 시 원본 플레이어가 이 구간 시작으로 seek+재생, end에 도달하면 자동 정지 */}
      <button
        type="button"
        onClick={() => seek?.seekTo(short.start, { end: short.end })}
        className="group relative block aspect-video w-full overflow-hidden bg-black/40"
        title={`▶ ${formatTimecode(short.start)}–${formatTimecode(short.end)} 구간 재생 (end에서 자동 정지)`}
      >
        {rec?.thumbnails && rec.thumbnails.length > 0 ? (() => {
          // 선택된 썸네일 혹은 첫번째 썸네일 사용
          const activeThumb = rec.thumbnails.find(t => t.id === rec.selectedThumbnailId) || rec.thumbnails.find(t => t.chosen) || rec.thumbnails[0];
          return (
            <img
              src={mediaUrl(activeThumb.urls["16:9"] ?? activeThumb.urls["9:16"])}
              alt=""
              loading="lazy"
              className="absolute inset-0 size-full object-cover opacity-90 transition group-hover:opacity-100 group-hover:scale-[1.02]"
            />
          );
        })() : (
          <img
            src={src}
            alt=""
            loading="lazy"
            className="absolute inset-0 size-full object-cover opacity-90 transition group-hover:opacity-100 group-hover:scale-[1.02]"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.opacity = "0";
            }}
          />
        )}
        {/* 클립·하이라이트: 상단 방송 자막(원본에 인코딩) 시각적 마스킹.
            정중앙 프레임 사용에도 남는 경우가 있어 CSS 그라디언트로 덮음. */}
        {shortType !== "shortform" && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1/4 bg-gradient-to-b from-black/70 via-black/40 to-transparent" />
        )}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
          <Play className="size-10 fill-white text-white opacity-0 drop-shadow-lg transition group-hover:opacity-100" />
        </div>
        {/* 좌상단: 순위 + 스코어(0-100) — 신규 3축 스코어. legacy appeal은 호버 툴팁으로만. */}
        <div className="absolute left-1.5 top-1.5 flex gap-1">
          <span className="rounded bg-status-warn px-1.5 py-0.5 text-[10px] font-bold text-black">
            #{short.rank ?? index + 1}
          </span>
          {score != null && (
            <span
              className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums", scoreTone)}
              title={
                typeof short.score100 === "number"
                  ? scoreParts
                    // 2026-08-06~ 결정론 스코어. 근거를 그대로 보여준다 — 어느 축이
                    // 점수를 끌었는지 못 보면 편집자가 판단을 검증할 수 없다.
                    ? `신호 ${fmtPart(scoreParts.signal)} · 훅 ${fmtPart(scoreParts.hook)}`
                      + ` · 길이 ${fmtPart(scoreParts.length)} · 끝맺음 ${fmtPart(scoreParts.closure)}`
                      + `\n(가중치 0.40·0.25·0.20·0.15 · LLM 점수 아님)`
                    : `결정론 스코어 (근거 없음 — 재분석 필요)`
                  : `legacy appeal ${short.appeal} → score ${score} 근사`
              }
            >
              {score}점
            </span>
          )}
        </div>
        {/* 우상단: hook 카테고리. 카테고리 값이 아니면(=LLM이 서술을 넣은 회귀) 뱃지 자체 생략. */}
        {short.hook && HOOK_CATEGORIES.has(short.hook) && (
          <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {short.hook}
          </span>
        )}
        {/* 하단: 시간·길이 */}
        <div className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
          {formatTimecode(short.start)}–{formatTimecode(short.end)} · {formatDurationMS(duration)}
        </div>
        {status === "adopted" && (
          <span className="absolute bottom-1.5 left-1.5 rounded bg-status-done px-1.5 py-0.5 text-[10px] font-bold text-white">
            ✓ 채택
          </span>
        )}
      </button>

      {/* Body */}
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="line-clamp-2 text-[12.5px] font-semibold leading-snug">
          {short.title || "제목 없음"}
        </div>
        {/* 첫 3초 Hook Intro (docs/plans/shorts-hook-intro-3sec.md) — 이탈 방지 attention retention.
            core가 채운 hook_intro_caption(어그로 자막)을 프리뷰. hook_quote(실 대사)는 근거로 병기,
            hook_time_sec는 쇼츠 시작 기준 상대 시각 마커. 하나라도 있어야 표시(옛 회차 자동 생략). */}
        {(short.hook_intro_caption || short.hook_quote) && (
          <div className="rounded-md bg-status-warn/10 px-2 py-1.5">
            <div className="flex items-center gap-1">
              <Zap className="size-3 shrink-0 fill-status-warn text-status-warn" />
              <span className="text-[9px] font-bold uppercase tracking-wide text-status-warn/80">
                첫 3초 훅
              </span>
              {typeof short.hook_time_sec === "number" && (
                <span
                  className="ml-auto shrink-0 text-[9.5px] font-semibold tabular-nums text-status-warn/70"
                  title="쇼츠 시작 기준 hook 대사 시각"
                >
                  +{short.hook_time_sec.toFixed(1)}s
                </span>
              )}
            </div>
            <div className="mt-0.5 line-clamp-1 text-[11.5px] font-bold text-status-warn">
              {short.hook_intro_caption || short.hook_quote}
            </div>
            {short.hook_intro_caption && short.hook_quote && (
              <p className="mt-0.5 line-clamp-1 text-[10px] italic text-muted-foreground" title={short.hook_quote}>
                “{short.hook_quote}”
              </p>
            )}
          </div>
        )}
        {/* 스코어 분해 — 근거. 2026-08-06~ 는 결정론 4축(score_parts), 그 이전 회차는 LLM 3축.
            둘 다 없으면(옛 회차) 자동 생략. */}
        {scoreParts ? (
          <div className="flex flex-wrap gap-1 text-[10px] tabular-nums">
            <AxisChip label="신호" value={pct10(scoreParts.signal)} />
            <AxisChip label="훅" value={pct10(scoreParts.hook)} />
            <AxisChip label="길이" value={pct10(scoreParts.length)} />
            <AxisChip label="끝맺음" value={pct10(scoreParts.closure)} />
          </div>
        ) : (
          (typeof short.hook_strength === "number" ||
            typeof short.payoff === "number" ||
            typeof short.completeness === "number") && (
            <div className="flex flex-wrap gap-1 text-[10px] tabular-nums">
              <AxisChip label="훅" value={short.hook_strength} />
              <AxisChip label="터짐" value={short.payoff} />
              <AxisChip label="완결" value={short.completeness} />
            </div>
          )
        )}
        {short.reason && (
          <p className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {short.reason}
          </p>
        )}
        {short.tags && short.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {short.tags.slice(0, 4).map((t) => (
              <Badge key={t} className="text-[10px] text-muted-foreground">
                {t}
              </Badge>
            ))}
          </div>
        )}

        {/* 썸네일 변형 Picker (추천 보드 등록 후 생성된 경우) */}
        {rec?.thumbnails && rec.thumbnails.length > 0 && (
          <ThumbnailPicker
            thumbnails={rec.thumbnails}
            apiBase={apiBase}
            chosenId={
              rec.selectedThumbnailId ||
              rec.thumbnails.find(t => t.chosen)?.id ||
              rec.thumbnails[0].id
            }
            onChoose={async (id) => {
              try {
                await selectThumbnail(rec.id, id);
                toast({ title: "썸네일 선택됨", description: "선택이 저장되었습니다. 클립 생성 시 반영됩니다.", tone: "done" });
              } catch (err) {
                toast({ title: "썸네일 선택 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
              }
            }}
          />
        )}

        {/* 액션 영역 — 상태에 따라 셋 중 하나 */}
        <div className="mt-1">
          {status === "pending" && rec && (
            <div className="flex gap-1">
              <Button
                size="xs"
                variant="outline"
                className="flex-1"
                onClick={() => doAdopt(false)}
                disabled={!!busy}
              >
                {busy === "adopt" ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                채택
              </Button>
              <Button
                size="xs"
                className="flex-1"
                onClick={() => doAdopt(true)}
                disabled={!!busy}
              >
                {busy === "edit" ? <Loader2 className="size-3 animate-spin" /> : <Pencil className="size-3" />}
                채택+편집
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="px-1.5"
                onClick={doReject}
                disabled={!!busy}
                title="반려"
              >
                ✕
              </Button>
            </div>
          )}
          {status === "adopted" && rec?.adoptedClipId && (
            <Link
              href={`/editor/${rec.adoptedClipId}`}
              className="flex w-full items-center justify-center gap-1 rounded-md bg-status-done/10 py-1.5 text-[11.5px] font-semibold text-status-done hover:bg-status-done/15"
            >
              편집기 열기 →
            </Link>
          )}
          {status === "rejected" && (
            <div className="rounded-md bg-muted py-1.5 text-center text-[10.5px] text-muted-foreground">
              반려됨{rec?.rejectReason ? ` · ${rec.rejectReason}` : ""}
            </div>
          )}
          {status === "unregistered" && (
            <div className="rounded-md border border-dashed border-border py-1.5 text-center text-[10.5px] text-muted-foreground">
              추천 보드 미등록 · 표시 전용
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** duration(초) → 편집자 친숙한 표기. <60s: `45초`, ≥60s: `1분 20초` (0초 생략). */
function formatDurationMS(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}분` : `${m}분 ${rem}초`;
}

/** 3축 단일 값 표시(0-10). 값이 클수록 강조. 없으면 렌더 안 함. */
/** score_parts 의 0-1 값 → 0-10 (AxisChip 이 10점 척도라 맞춘다). 숫자가 아니면 undefined. */
function pct10(v: unknown): number | undefined {
  return typeof v === "number" ? Math.round(v * 10) : undefined;
}

/** 툴팁용 0-1 → "0.69" 표기. 숫자가 아니면 "-". */
function fmtPart(v: unknown): string {
  return typeof v === "number" ? v.toFixed(2) : "-";
}

function AxisChip({ label, value }: { label: string; value: number | undefined }) {
  if (typeof value !== "number") return null;
  const tone =
    value >= 8
      ? "bg-status-warn/20 text-status-warn"
      : value >= 5
        ? "bg-muted text-foreground"
        : "bg-muted/60 text-muted-foreground";
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-semibold", tone)}>
      {label} {value}
    </span>
  );
}

/** shorts 배열 인덱스와 rec의 startTime/endTime 매칭. 서버가 1:1로 만들지만
 *  라운딩·재분석으로 startTime이 살짝 변할 수 있어 관용창(1s) 안에서 최근접 매칭. */
function matchRec(recs: Recommendation[], short: AnalysisShort): Recommendation | undefined {
  let best: { r: Recommendation; d: number } | null = null;
  for (const r of recs) {
    const dStart = Math.abs((r.startTime ?? 0) - short.start);
    if (dStart > REC_MATCH_TOLERANCE_SEC) continue;
    const dEnd = Math.abs((r.endTime ?? 0) - short.end);
    if (dEnd > REC_MATCH_TOLERANCE_SEC * 2) continue;
    const d = dStart + dEnd;
    if (!best || d < best.d) best = { r, d };
  }
  return best?.r;
}
