"use client";

/**
 * U11 · 썸네일 생성 (README §11 · FLOWS F7).
 *
 * 좌: 대상 미디어 그리드(라디오, **숏폼 제외**) · 우 400px: 프롬프트 + 비율 + 결과 3안.
 *
 * 지키는 것:
 *  - 대상이 있어야 생성 버튼이 눌린다(F7-2).
 *    프롬프트·비율은 **서버가 아직 읽지 않는다**(POST /api/media/:id/thumbnail 은 programId·
 *    candidates 만 본다) — 그래서 입력을 필수로 걸지 않고 비활성 + 사유로 표기한다.
 *    필수로 걸면 "내가 쓴 문장이 반영됐다"고 믿게 된다.
 *  - 대상을 바꾸면 이전 결과는 초기화된다(F7-4).
 *  - **완료 알림이 없다.** 다른 화면으로 가도 결과는 미디어에 남는다 — 그 점을 문구로
 *    명시한다(F7-5). 알림을 만들면 "알림을 놓치면 결과도 사라진다"고 오해하게 된다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { useToast } from "@/components/ui/toast";
import {
  fetchThumbnailCandidates,
  generateThumbnails,
  selectThumbnailCandidate,
  type ThumbnailCandidateFile,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { fmtTime } from "@/lib/utils";
import { clipThumbSrc } from "@/lib/media-url";
import type { Clip } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function ThumbnailsPage() {
  const { clips, episodes, programs, loading } = useAppData();
  const { toast } = useToast();

  const [targetId, setTargetId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("16:9");
  const [candidates, setCandidates] = useState<ThumbnailCandidateFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 숏폼은 생성 대상이 아니다 (F7-1). 세로 미디어는 목록에서 아예 뺀다.
  const targets = useMemo(() => clips.filter((c) => !c.aspectRatio?.startsWith("9:16")), [clips]);
  const target = targets.find((c) => c.id === targetId) ?? null;

  const mediaIdOf = (c: Clip) => c.mediaId ?? c.sourceMediaId ?? "";

  const loadCandidates = useCallback(async (clip: Clip | null) => {
    const mediaId = clip ? mediaIdOf(clip) : "";
    if (!mediaId) { setCandidates([]); setSelected(null); return; }
    try {
      const r = await fetchThumbnailCandidates(mediaId);
      setCandidates(r.candidates);
      setSelected(r.selected);
      setError(null);
    } catch (err) {
      setCandidates([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 대상이 바뀌면 이전 결과를 버린다 (F7-4). 남겨 두면 다른 미디어의 결과를
  // 이 미디어 것으로 착각한다.
  useEffect(() => {
    setCandidates([]);
    setSelected(null);
    setError(null);
    void loadCandidates(target);
  }, [targetId, target, loadCandidates]);

  const canGenerate = Boolean(target) && !busy;

  async function generate() {
    if (!target || !canGenerate) return;
    const mediaId = mediaIdOf(target);
    const ep = episodes.find((e) => e.id === target.episodeId);
    const programId = ep?.programId ?? "";
    if (!mediaId || !programId) {
      toast({ title: "생성할 수 없습니다", description: "이 미디어의 원본·프로그램을 찾을 수 없습니다.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      await generateThumbnails(mediaId, { programId, prompt: prompt.trim(), aspect, candidates: 3 });
      toast({
        title: "생성을 요청했습니다",
        // 서버가 같은 미디어의 진행 중 잡을 dedupe 로 삼킨다(요청은 200 이지만 새 잡이 안 뜬다).
        // 그래서 "시작했습니다"라고 단정하지 않는다.
        description: "이미 생성 중이면 이 요청은 무시됩니다. 완료 알림은 없습니다 — 결과는 이 미디어에 남습니다.",
        tone: "progress",
      });
    } catch (err) {
      toast({ title: "생성 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function choose(path: string) {
    if (!target) return;
    try {
      await selectThumbnailCandidate(mediaIdOf(target), path);
      setSelected(path);
      toast({ title: "대표 썸네일로 지정했습니다", description: target.title, tone: "done" });
    } catch (err) {
      toast({ title: "지정 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  return (
    <div className="flex gap-4">
      {/* ── 대상 그리드 ───────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-baseline gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>대상 선택</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            숏폼은 대상이 아닙니다 — 세로 미디어는 목록에 없습니다
          </span>
        </div>

        {targets.length === 0 ? (
          <div
            className="sd-ph grid min-h-[200px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            {loading ? "불러오는 중…" : "가로(16:9) 미디어가 없습니다 — 영상 분석에서 클립을 채택하면 여기 나타납니다"}
          </div>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {targets.map((c) => {
              const ep = episodes.find((e) => e.id === c.episodeId);
              const pg = programs.find((p) => p.id === ep?.programId);
              const on = targetId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setTargetId(c.id)}
                  className="sd-card flex flex-col overflow-hidden text-left"
                  style={on ? { outline: "2px solid var(--sd-accent)", outlineOffset: -1 } : undefined}
                >
                  <div className="sd-ph h-[112px]" style={{ borderBottom: "1px solid var(--sd-border)" }}>
                    {clipThumbSrc(c) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={clipThumbSrc(c)} alt="" loading="lazy" className="size-full object-cover" />
                    ) : (
                      "썸네일 없음"
                    )}
                  </div>
                  <div className="flex flex-col gap-1 px-2.5 py-2">
                    <span className="line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--sd-fg)" }}>
                      {c.title}
                    </span>
                    <span className="sd-mono truncate text-[10px]" style={{ color: "var(--sd-mut)" }}>
                      {pg?.title ?? ""}{ep ? ` · 회차 ${ep.episodeNumber}` : ""} · {fmtTime(c.durationSec)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 우측 400px ────────────────────────────────────────────────────── */}
      <aside className="flex w-[400px] shrink-0 flex-col gap-2.5">
        <div className="sd-card flex flex-col gap-2.5 p-3">
          <div className="sd-eb" style={{ color: "var(--sd-label)" }}>선택한 미디어</div>
          {target ? (
            <div className="text-[12.5px]" style={{ color: "var(--sd-fg)" }}>{target.title}</div>
          ) : (
            <div className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>왼쪽에서 하나 고르세요.</div>
          )}

          <div>
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="text-[11.5px] font-semibold" style={{ color: "var(--sd-mut)" }}>프롬프트</span>
              <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>배선 전 — 입력해도 반영되지 않습니다</span>
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled
              placeholder="아직 서버가 프롬프트를 받지 않습니다 — 프로그램 스타일 프로파일과 등록 출연자 사진으로만 생성됩니다."
              title="서버가 아직 프롬프트를 받지 않습니다"
              className="sd-input h-[92px] w-full resize-none py-2 leading-relaxed"
            />
          </div>

          <div>
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="text-[11.5px] font-semibold" style={{ color: "var(--sd-mut)" }}>비율</span>
              <span className="text-[10.5px]" style={{ color: "var(--sd-mut)" }}>현재 16:9 만 생성됩니다</span>
            </div>
            <div className="flex gap-[3px]">
              {(["16:9", "9:16"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  disabled
                  title="비율 선택은 아직 서버로 전달되지 않습니다"
                  className={cn("sd-btn", aspect === a && "sd-btn--on")}
                  onClick={() => setAspect(a)}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {/* F7-5 ⚑ — 알림이 없다는 것을 먼저 말해 둔다. */}
          <p
            className="rounded-[4px] px-2.5 py-2 text-[11px] leading-relaxed"
            style={{ border: "1px solid var(--sd-border)", background: "var(--sd-card-sub)", color: "var(--sd-mut)" }}
          >
            생성에는 몇 분이 걸립니다. <b style={{ color: "var(--sd-fg)" }}>완료 알림도, 실패 알림도 없습니다</b> —
            다른 화면으로 가도 결과는 이 미디어에 남아 있고, 이 화면에서 다시 볼 수 있습니다.
            출연자 사진이 등록돼 있지 않으면 생성이 실패하는데, 그 경우 몇 분 뒤에도 결과가 비어 있습니다.
          </p>

          <button
            type="button"
            className="sd-btn sd-btn-primary"
            disabled={!canGenerate}
            title={!target ? "대상을 고르세요" : undefined}
            onClick={generate}
          >
            {busy ? "요청 중…" : "썸네일 생성"}
          </button>
        </div>

        <div className="sd-card flex flex-col gap-2.5 p-3">
          <div className="flex items-center gap-2">
            <span className="sd-eb" style={{ color: "var(--sd-label)" }}>결과</span>
            <button
              type="button"
              className="sd-btn ml-auto"
              onClick={() => void loadCandidates(target)}
              disabled={!target}
            >
              새로고침
            </button>
          </div>

          {error && (
            <p className="text-[11.5px]" style={{ color: "var(--sd-danger-strong)" }}>
              결과를 불러오지 못했습니다 ({error}).
            </p>
          )}

          {candidates.length === 0 ? (
            <div
              className="sd-ph grid min-h-[120px] place-items-center rounded-[5px] px-4 text-center"
              style={{ border: "1px dashed var(--sd-border)" }}
            >
              {target ? "아직 생성된 결과가 없습니다" : "대상을 고르면 기존 결과가 여기 보입니다"}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {candidates.map((cand) => (
                <button
                  key={cand.id}
                  type="button"
                  onClick={() => void choose(cand.id)}
                  className="overflow-hidden rounded-[5px] text-left"
                  style={{
                    border: `1px solid ${selected === cand.id ? "var(--sd-accent)" : "var(--sd-border)"}`,
                    outline: selected === cand.id ? "1px solid var(--sd-accent)" : undefined,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={cand.url} alt={cand.name} className="w-full object-cover" />
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <span className="sd-mono truncate text-[10px]" style={{ color: "var(--sd-mut)" }}>{cand.name}</span>
                    {selected === cand.id ? (
                      <span className="sd-tag sd-tag--airing ml-auto">대표</span>
                    ) : (
                      <span className="ml-auto text-[10.5px]" style={{ color: "var(--sd-accent)" }}>대표로 지정</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
