"use client";

/**
 * 확인·수정 팝업 — 자동배포 **대기 중(이미 렌더된)** 클립의 오버레이 문구를 그 자리에서
 * 고친다 (AENA 통합목업 "확인·수정" 팝업 · 2026-09-15 사용자 요청 "대기중인 거 적당히
 * 편집해서 만들어볼 수 있게").
 *
 * 문구 후보 = clip.titleAlts (2026-09-15 3형 — 실명형은 YOLO 확인 인물일 때만 생성·승격).
 * 저장은 PATCH /api/clips/:id/overlay-title 하나 — 서버가 저장 즉시 이 클립만 다시 굽는다
 * (50~90초). 세밀한 편집(트림·키프레임·자막)은 기존 '편집'(풀 에디터)이 담당하고, 여기는
 * 목업이 말하는 "문구 고르고 배치만 바꾸는" 가벼운 층이다.
 */
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { Clip } from "@/lib/types";
import { fetchClipOverlayTitle, patchClipOverlayTitle } from "@/lib/data/api";
// 세로 배치 후보 — 순방·템플릿 설정과 같은 목록(RULE_ASPECTS). 화면에 사본을 두지 않는다.
import { RULE_ASPECTS } from "@server-pure/pipeline/automation";

const ASPECT_LABELS: Record<string, string> = {
  "9:16-letterbox": "전체 담기",
  "9:16-crop-full": "꽉 채우기",
  "9:16-crop-main": "위 자막띠",
  "9:16-crop-sub": "위아래 띠",
};

const KIND_LABELS: Record<string, string> = { name: "실명형", quote: "인용형", situation: "상황형" };

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
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [clip.id]);

  // 후보 = 현재 줄(맨 위) + 3형 후보. 같은 쌍은 접는다.
  const candidates: Array<{ kind?: string; l1: string; l2: string }> = [];
  const seen = new Set<string>();
  for (const c of [
    { l1: clip.titleLine1 ?? "", l2: clip.titleLine2 ?? "" },
    ...(clip.titleAlts ?? []).map((a) => ({ kind: a.kind, l1: a.titleLine1, l2: a.titleLine2 })),
  ]) {
    const key = `${c.l1}|${c.l2}`;
    if (!(c.l1 || c.l2) || seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await patchClipOverlayTitle(clip.id, {
        lines: [
          { text: line1.trim(), ...(colors[0] ? { color: colors[0] } : {}) },
          ...(line2.trim() ? [{ text: line2.trim(), ...(colors[1] ? { color: colors[1] } : {}) }] : []),
        ],
        ...(aspect && aspect !== initialAspect ? { layout: { aspect } } : {}),
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
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-bold text-[var(--color-text-primary)]">확인·수정 — 오버레이 문구</div>
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
          <div className="space-y-3">
            {candidates.length > 1 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-[var(--color-text-muted)]">문구 후보 — 클릭해서 적용</div>
                {candidates.map((c, i) => {
                  const active = c.l1 === line1 && c.l2 === line2;
                  return (
                    <button
                      key={i}
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
                })}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-[var(--color-text-muted)]">직접 수정</div>
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

            {error && <div className="text-[11px] text-status-warn">{error}</div>}

            <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              저장하면 이 영상만 즉시 다시 굽습니다 (50~90초). 배치를 바꾸면 잘리는 모양이
              통째로 달라집니다. 다 구워진 새 미리보기는 잠시 뒤 카드에서 확인하세요.
            </p>

            <div className="flex justify-end gap-2">
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
        )}
      </div>
    </div>
  );
}
