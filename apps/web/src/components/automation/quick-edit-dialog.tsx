"use client";

/**
 * 확인·수정 팝업 — 자동배포 **대기 중(이미 렌더된)** 클립을 그 자리에서 가볍게 고친다
 * (AENA 통합목업 "확인·수정" · 2026-09-15).
 *
 * 사용자 요구 둘(2026-09-15):
 *  ① "제목 선택해서 오버레이 바뀌게" — 후보를 고르면 **왼쪽 9:16 미리보기가 즉시** 바뀐다.
 *    미리보기는 템플릿 설정과 같은 컴포넌트(TemplatePreview)에 실제 두 줄을 흘려 그린다.
 *  ② "편집 누르면 편집기 띄우지 말고 템플릿 편집하듯 가볍게" — 위치·스타일 슬라이더
 *    (LayoutSliders · 템플릿 설정과 같은 컨트롤)를 접이식으로 품는다. 값은 이 클립에만
 *    저장된다(overlay-title PATCH 가 규칙 layout 과 같은 어휘를 받는다). 트림·키프레임 같은
 *    깊은 편집만 하단 "전체 편집기" 링크로 나간다.
 *
 * 문구 후보 아래에는 우리가 만든 3형(실명형·인용형·상황형 · clip.titleAlts)을 별도 블록으로.
 * 저장 즉시 서버가 이 클립만 다시 굽는다(50~90초).
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import Link from "next/link";
import type { Clip } from "@/lib/types";
import { fetchClipOverlayTitle, patchClipOverlayTitle, type OverlayTitleState } from "@/lib/data/api";
import { clipThumbSrc } from "@/lib/media-url";
import { LayoutSliders, SUBTITLE_DEFAULTS, TemplatePreview, type LayoutState } from "@/components/automation/template-preview";
// 세로 배치 후보 — 순방·템플릿 설정과 같은 목록(RULE_ASPECTS). 화면에 사본을 두지 않는다.
import { RULE_ASPECTS } from "@server-pure/pipeline/automation";

const ASPECT_LABELS: Record<string, string> = {
  "9:16-letterbox": "전체 담기",
  "9:16-crop-full": "꽉 채우기",
  "9:16-crop-main": "위 자막띠",
  "9:16-crop-sub": "위아래 띠",
};

const KIND_LABELS: Record<string, string> = { name: "실명형", quote: "인용형", situation: "상황형" };
/** 표준 강조색(금빛) — factory 시드와 동일. 줄 색을 못 읽었을 때의 미리보기 폴백. */
const FALLBACK_ACCENT = "#F3AF4F";

/** GET layout(null=값 없음) → 슬라이더 초기값. 폴백은 표준 템플릿 시드 자리와 동일. */
function layoutFromGet(g: OverlayTitleState["layout"] | undefined): LayoutState {
  return {
    titleY: g?.titleY ?? 8,
    channelIconY: g?.channelIconY ?? 79,
    channelBoxY: g?.channelBoxY ?? 87,
    channelIconSize: g?.channelIconSize ?? 50,
    titleColor: "",                    // 줄 색이 정본 — 아래 previewLayout 에서 덮는다
    subtitleY: g?.subtitleY ?? SUBTITLE_DEFAULTS.y,
    subtitleSize: g?.subtitleSize ?? SUBTITLE_DEFAULTS.size,
    subtitleColor: g?.subtitleColor ?? SUBTITLE_DEFAULTS.color,
    logo: g?.logo,
    timebox: g?.timebox,
    titleFont: g?.titleFont ?? undefined,
    captionFont: g?.captionFont ?? undefined,
    titleSpacing: g?.titleSpacing ?? undefined,
    titleLineHeight: g?.titleLineHeight ?? undefined,
    subtitleSpacing: g?.subtitleSpacing ?? undefined,
    titleShadow: g?.titleShadow ?? undefined,
    subtitleShadow: g?.subtitleShadow ?? undefined,
    subtitleShadowX: g?.subtitleShadowX ?? undefined,
    subtitleShadowY: g?.subtitleShadowY ?? undefined,
    subtitleStroke: g?.subtitleStroke ?? undefined,
    subtitleStrokeColor: g?.subtitleStrokeColor ?? undefined,
    subtitleBg: g?.subtitleBg ?? undefined,
    subtitleBgColor: g?.subtitleBgColor ?? undefined,
    subtitleBgOpacity: g?.subtitleBgOpacity ?? undefined,
    timeboxFont: g?.timeboxFont ?? undefined,
    timeboxColor: g?.channelBoxColor ?? undefined,
    timeboxSize: g?.timeboxSize ?? undefined,
  };
}

export function QuickEditDialog({ clip, onClose, onSaved }: {
  clip: Clip;
  onClose: () => void;
  /** 저장 성공 알림 — 부모가 toast 를 띄운다(재렌더 안내 포함). */
  onSaved: () => void;
}) {
  const [line1, setLine1] = useState(clip.titleLine1 ?? "");
  const [line2, setLine2] = useState(clip.titleLine2 ?? "");
  // 줄 색 — GET 으로 받은 현재 색을 저장 때 되돌려 보낸다(안 보내면 강조색이 날아간다).
  const [colors, setColors] = useState<[string, string]>(["", ""]);
  const [aspect, setAspect] = useState("");
  const [initialAspect, setInitialAspect] = useState("");
  const [lay, setLay] = useState<LayoutState | null>(null);
  const initialLay = useRef<LayoutState | null>(null);
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  const initialSubtitles = useRef(true);
  const [styleOpen, setStyleOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchClipOverlayTitle(clip.id)
      .then((s) => {
        if (!alive) return;
        const [l1, l2] = s.titleLines;
        if (l1?.text) setLine1(l1.text);
        if (l2?.text) setLine2(l2.text);
        setColors([l1?.color ?? "", l2?.color ?? ""]);
        const a = s.layout?.aspect ?? "";
        setAspect(a);
        setInitialAspect(a);
        const built = layoutFromGet(s.layout);
        setLay(built);
        initialLay.current = built;
        const subs = s.layout?.subtitles !== false;
        setSubtitlesOn(subs);
        initialSubtitles.current = subs;
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [clip.id]);

  // 후보 분리 — 원래 문구·무형(kind 없음)은 위, 우리 3형(실명·인용·상황)은 아래 블록.
  const seen = new Set<string>();
  const dedup = (arr: Array<{ kind?: string; l1: string; l2: string }>) =>
    arr.filter((c) => {
      const key = `${c.l1}|${c.l2}`;
      if (!(c.l1 || c.l2) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const plain = dedup([
    { l1: clip.titleLine1 ?? "", l2: clip.titleLine2 ?? "" },
    ...(clip.titleAlts ?? []).filter((a) => !a.kind).map((a) => ({ l1: a.titleLine1, l2: a.titleLine2 })),
  ]);
  const typed = dedup(
    (clip.titleAlts ?? []).filter((a) => a.kind).map((a) => ({ kind: a.kind, l1: a.titleLine1, l2: a.titleLine2 })),
  );

  const previewLayout: LayoutState = {
    ...(lay ?? layoutFromGet(undefined)),
    titleColor: colors[1] || FALLBACK_ACCENT,
  };

  const candidateRow = (c: { kind?: string; l1: string; l2: string }, i: number) => {
    const active = c.l1 === line1 && c.l2 === line2;
    return (
      <button
        key={`${c.kind ?? "p"}-${i}`}
        type="button"
        onClick={() => { setLine1(c.l1); setLine2(c.l2); }}
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
          active
            ? "border-[#1C60FF] bg-[var(--color-bg-active)]/10"
            : "border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-input)]"
        }`}
      >
        {c.kind && (
          <span className="shrink-0 rounded-full bg-[var(--color-bg-input)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-accent)]">
            {KIND_LABELS[c.kind] ?? c.kind}
          </span>
        )}
        <span className="min-w-0 truncate text-[var(--color-text-primary)]">
          {c.l1}{c.l2 ? ` / ${c.l2}` : ""}
        </span>
      </button>
    );
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // 위치·스타일은 **바뀐 키만** 보낸다 — 안 만진 축까지 보내면 "템플릿 기본을 따름"(값
      // 없음) 상태가 명시값으로 굳어, 나중에 계획 템플릿을 바꿔도 이 클립만 옛날에 남는다.
      const layoutPatch: Record<string, unknown> = {};
      const before = initialLay.current;
      if (lay && before) {
        for (const k of Object.keys(lay) as Array<keyof LayoutState>) {
          if (k === "titleColor") continue;               // 줄 색이 정본 — lines 로 나간다
          if (lay[k] !== before[k] && lay[k] !== undefined) layoutPatch[k] = lay[k];
        }
      }
      if (subtitlesOn !== initialSubtitles.current) layoutPatch.subtitles = subtitlesOn;
      if (aspect && aspect !== initialAspect) layoutPatch.aspect = aspect;
      await patchClipOverlayTitle(clip.id, {
        lines: [
          { text: line1.trim(), ...(colors[0] ? { color: colors[0] } : {}) },
          ...(line2.trim() ? [{ text: line2.trim(), ...(colors[1] ? { color: colors[1] } : {}) }] : []),
        ],
        ...(Object.keys(layoutPatch).length ? { layout: layoutPatch } : {}),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    // 관용구: template-preview 다이얼로그와 동일(오버레이 클릭 닫힘 · 내부 클릭 전파 차단).
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-bold text-[var(--color-text-primary)]">확인·수정</div>
            <div className="truncate text-[11px] text-[var(--color-text-muted)]">{clip.title}</div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-input)]" aria-label="닫기">
            <X className="size-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="size-4 animate-spin" /> 불러오는 중…
          </div>
        ) : (
          <div className="flex flex-wrap gap-4">
            {/* 왼쪽 — 라이브 미리보기. 후보 클릭·직접 수정·배치·슬라이더가 전부 즉시 반영된다.
                실제 재렌더 결과는 저장 후 카드의 '미리보기'(렌더 산출물 재생)로 확인한다. */}
            <div className="mx-auto shrink-0 self-start md:sticky md:top-0">
              <TemplatePreview
                template={null}
                accent={colors[1] || FALLBACK_ACCENT}
                layout={previewLayout}
                frameSrc={clipThumbSrc(clip)}
                subtitlesOn={subtitlesOn}
                aspect={aspect || undefined}
                width={216}
                titleLine1={line1}
                titleLine2={line2}
              />
            </div>

            <div className="min-w-[260px] flex-1 space-y-3">
              {plain.length > 1 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-[var(--color-text-muted)]">문구 후보 — 클릭하면 미리보기가 바뀝니다</div>
                  {plain.map(candidateRow)}
                </div>
              )}
              {/* 우리 3형 — 실명형(YOLO 확인 인물)·인용형(실 대사)·상황형. 후보 아래 별도 블록. */}
              {typed.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-[var(--color-text-muted)]">
                    유형별 후보 <span className="font-normal">실명형 = 화면에서 확인된 인물만</span>
                  </div>
                  {typed.map(candidateRow)}
                </div>
              )}

              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-[var(--color-text-muted)]">직접 수정 — 고치는 즉시 미리보기 반영</div>
                <input
                  value={line1}
                  onChange={(e) => setLine1(e.target.value)}
                  placeholder="첫 줄"
                  className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#1C60FF]"
                />
                <input
                  value={line2}
                  onChange={(e) => setLine2(e.target.value)}
                  placeholder="둘째 줄 (강조 · 비우면 한 줄)"
                  className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#1C60FF]"
                />
              </div>

              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-[var(--color-text-muted)]">영상 배치</div>
                <select
                  value={aspect}
                  onChange={(e) => setAspect(e.target.value)}
                  className="h-8 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-input)] px-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[#1C60FF]"
                >
                  <option value="">현재 유지 (템플릿 기본)</option>
                  {RULE_ASPECTS.map((a) => (
                    <option key={a} value={a}>{ASPECT_LABELS[a] ?? a}</option>
                  ))}
                </select>
              </div>

              {/* 위치·스타일 — 템플릿 설정과 **같은 컨트롤**(LayoutSliders)로 이 클립만 고친다
                  (사용자: "편집 누르면 편집기 말고 템플릿 편집하듯 가볍게"). 접어 두는 이유:
                  대부분의 수정은 문구 선택으로 끝나고, 슬라이더는 예외 수정이다. */}
              {lay && (
                <div className="rounded-lg border border-[var(--color-border-subtle)]">
                  <button
                    type="button"
                    onClick={() => setStyleOpen((v) => !v)}
                    className="flex w-full items-center justify-between px-2.5 py-2 text-[11px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg-input)]"
                    aria-expanded={styleOpen}
                  >
                    <span>위치·스타일 — 이 영상에만 적용</span>
                    <ChevronDown className={`size-3.5 transition-transform ${styleOpen ? "rotate-180" : ""}`} />
                  </button>
                  {styleOpen && (
                    <LayoutSliders
                      layout={lay}
                      onChange={setLay}
                      subtitlesOn={subtitlesOn}
                      onSubtitlesChange={setSubtitlesOn}
                      className="space-y-2.5 border-t border-[var(--color-border-subtle)] p-2.5"
                    />
                  )}
                </div>
              )}

              {error && <div className="text-[11px] text-status-warn">{error}</div>}

              <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                저장하면 이 영상만 즉시 다시 굽습니다 (50~90초). 저장하지 않고 닫으면 지금
                문구·배치가 그대로 나갑니다.
              </p>

              <div className="flex items-center gap-2">
                {/* 트림·키프레임·자막 편집 같은 깊은 수정만 전체 편집기로 — 가벼운 수정은 여기서 끝낸다. */}
                <Link
                  href={`/editor/${clip.id}`}
                  className="text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:underline"
                >
                  전체 편집기 ↗
                </Link>
                <div className="ml-auto flex gap-2">
                  <button
                    onClick={onClose}
                    className="rounded-full border border-[var(--color-border-subtle)] px-3.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-input)]"
                  >
                    닫기
                  </button>
                  <button
                    onClick={() => void save()}
                    disabled={saving || !line1.trim()}
                    className="rounded-full bg-[var(--color-bg-active)] px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#0D1EB8] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? "저장 중…" : "저장 — 다시 굽기"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
