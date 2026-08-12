"use client";

/**
 * U12 · 자동 배포 (README §12 · FLOWS F6 · 게이트 강제 지점 ③).
 *
 * 규칙 하나 = 프로그램 ↔ 채널 연결 하나. **규칙이 없으면 아무것도 하지 않는다** —
 * 전체 자동 실행 같은 기본 동작이 없다. 그 사실을 화면에서도 말한다.
 *
 * 보류 큐가 이 화면의 핵심이다. 게이트에 막힌 건은 여기 쌓이고, **사람이 확정 버튼을
 * 눌러야** 다음 순방에 다시 잡힌다. 이슈를 해제해서 게이트가 열려도 자동이 저절로
 * 밀어내지 않는다.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/auth";
import {
  deleteAutomationRule,
  fetchAutomation,
  fetchChannelRules,
  fetchShortsTemplates,
  fetchYouTubeChannels,
  type FrameTemplate,
  releaseAutomationHold,
  runAutomationNow,
  saveAutomationRule,
  setAutomationPaused,
  type AutomationRule,
  type ChannelRule,
  type GatePolicy,
  type RuleCriterion,
  type RuleHold,
  type RuleMediaKind,
  type RuleRun,
} from "@/lib/data/api";
import { useAppData } from "@/lib/data/store";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<RuleMediaKind, string> = { short: "숏폼", clip: "클립", both: "숏폼+클립" };
const CRIT_LABEL: Record<RuleCriterion, string> = { score80: "점수 80 이상", score85: "점수 85 이상", top3: "상위 3건" };
const POLICY_LABEL: Record<GatePolicy, string> = {
  approve_first: "게시 전 사람 승인",
  hold_on_issue: "권리 이슈 시 보류",
};
const RESULT_LABEL: Record<string, string> = {
  published: "게시됨", recorded: "기록됨", media_created: "미디어 생성",
  held: "보류", failed: "실패", skipped: "건너뜀",
};
const RESULT_TAG: Record<string, string> = {
  published: "sd-tag sd-tag--airing",
  recorded: "sd-tag",
  media_created: "sd-tag sd-tag--upcoming",
  held: "sd-tag sd-tag--warn",
  failed: "sd-tag sd-tag--danger",
  skipped: "sd-tag",
};

/**
 * 서버 factory.ts TEMPLATE_SEEDS 의 UI 미러 — 미리보기·슬라이더 초기값용.
 * 서버 시드를 바꾸면 여기도 같이 바꿔야 미리보기가 실제 렌더와 일치한다.
 */
const TEMPLATE_SEED_UI: Record<string, { accent: string; titleY: number; iconY: number; boxY: number; iconSize: number }> = {
  "broadcast-standard": { accent: "#40E0E0", titleY: 11, iconY: 68, boxY: 79.5, iconSize: 50 },
  "broadcast-drama": { accent: "#40E0E0", titleY: 8, iconY: 77, boxY: 87.5, iconSize: 50 },
  "broadcast-clean": { accent: "#FF4040", titleY: 11, iconY: 80, boxY: 92, iconSize: 40 },
};

/** 9:16 미니 캔버스에 템플릿 기하(띠·영상 영역)와 제목·로고·시간박스 위치를 그린다. */
function TemplatePreview({ template, accent, layout }: {
  template: FrameTemplate | null;
  accent: string;
  layout: { titleY: number; channelIconY: number; channelBoxY: number; channelIconSize: number };
}) {
  const video = template?.video ?? { x: 0, y: 34.2, w: 100, h: 31.7 };
  const iconPct = (layout.channelIconSize * 3 / 1920) * 100; // px(에디터) → 출력높이 → %
  return (
    <div className="relative w-[120px] shrink-0 overflow-hidden rounded-md border"
      style={{ aspectRatio: "9/16", background: "#000", borderColor: "var(--sd-border)" }}>
      {/* 영상 영역 */}
      <div className="absolute" style={{
        left: `${video.x}%`, top: `${video.y}%`, width: `${video.w}%`, height: `${video.h}%`,
        background: "linear-gradient(135deg,#2a3f4d,#1a2630)",
      }} />
      {/* 제목 2줄 */}
      <div className="absolute inset-x-1 text-center font-bold leading-tight"
        style={{ top: `${layout.titleY}%`, fontSize: 7, color: "#fff" }}>
        훅 첫 줄 텍스트
        <div style={{ color: accent }}>둘째 줄 강조</div>
      </div>
      {/* 로고 */}
      <div className="absolute left-1/2 -translate-x-1/2 rounded-sm"
        style={{ top: `${layout.channelIconY}%`, width: `${iconPct * 1.4}%`, height: `${iconPct}%`, background: "#666" }} />
      {/* 시간 박스 */}
      <div className="absolute left-1/2 -translate-x-1/2 rounded-[2px] px-1 text-center font-bold"
        style={{ top: `${layout.channelBoxY}%`, fontSize: 5.5, color: "#fff", background: "#3D7BD9" }}>
        (수) 밤 10시 30분
      </div>
    </div>
  );
}

const STEPS = [
  { n: "01", title: "회차 수신", desc: "새 회차 원본 감지 · 없으면 스킵" },
  { n: "02", title: "분석", desc: "분석 큐 투입 · 완료까지 다음 순방에 재확인" },
  { n: "03", title: "미디어 생성", desc: "규칙 조건 통과분만 생성 · 미달은 생성 안 함" },
  { n: "04", title: "게이트 확인", desc: "F3 그대로 · 막히면 보류 큐로, 사람이 확정해야 함", amber: true },
  { n: "05", title: "게시", desc: "채널 규칙 적용 · 실패는 자동 재시도 없음", blue: true },
];

export default function AutomationPage() {
  const { programs } = useAppData();
  const { toast } = useToast();
  const actor = useSession().user.name;

  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [holds, setHolds] = useState<RuleHold[]>([]);
  const [paused, setPaused] = useState(false);
  const [idleReason, setIdleReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchAutomation();
      setRules(r.rules); setRuns(r.runs); setHolds(r.holds);
      setPaused(r.paused); setIdleReason(r.idleReason);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function togglePause() {
    try {
      const r = await setAutomationPaused(!paused);
      toast({ title: paused ? "재시작했습니다" : "일시정지했습니다", description: r.notice, tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "변경 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  /** 규칙을 만들고 10분을 기다리지 않아도 결과를 본다. */
  async function runNow() {
    try {
      const r = await runAutomationNow();
      toast({
        title: "순방을 돌렸습니다",
        description:
          r.idleReason ||
          `규칙 ${r.rulesEvaluated}개 · 미디어 ${r.adopted} · 게시 ${r.published} · 보류 ${r.held}`,
        tone: r.held > 0 ? "warn" : "done",
      });
      await load();
    } catch (err) {
      toast({ title: "순방 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  async function release(h: RuleHold) {
    try {
      const r = await releaseAutomationHold(h.ruleId, h.clipId, actor);
      toast({ title: "확정했습니다", description: r.notice, tone: "done" });
      await load();
    } catch (err) {
      toast({ title: "확정 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }

  const running = !paused && rules.some((r) => r.enabled);

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col gap-[14px]">
      {/* ── 상태 바 ───────────────────────────────────────────────────────── */}
      <div className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
        <span
          className="size-[9px] shrink-0 rounded-full"
          style={{ background: running ? "var(--sd-ok)" : "var(--sd-idle)" }}
          aria-hidden
        />
        <span className="text-[13px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          {running ? "파이프라인 도는 중" : "멈춤"}
        </span>
        <span className="text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          {idleReason || `규칙 ${rules.filter((r) => r.enabled).length}개가 순방마다 평가됩니다`}
        </span>
        <button type="button" className="sd-btn ml-auto" onClick={runNow}>
          지금 한 바퀴
        </button>
        <button type="button" className="sd-btn" onClick={togglePause}>
          {paused ? "재시작" : "일시정지"}
        </button>
        <button type="button" className="sd-btn sd-btn-primary" onClick={() => setAdding(true)}>
          ＋ 자동 배포 규칙 추가
        </button>
      </div>

      {error && (
        <div
          className="rounded-[4px] px-3 py-2 text-[11.5px]"
          style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
        >
          자동 배포 상태를 불러오지 못했습니다 ({error}).
        </div>
      )}

      {/* ── 5단계 ─────────────────────────────────────────────────────────── */}
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {STEPS.map((s) => (
          <div
            key={s.n}
            className="sd-card flex flex-col gap-1 p-3"
            style={
              s.amber
                ? { borderColor: "var(--sd-warn-border)", background: "var(--sd-warn-bg)" }
                : s.blue
                  ? { borderColor: "var(--sd-accent-border)", background: "var(--sd-accent-bg)" }
                  : undefined
            }
          >
            <span className="sd-eb" style={{ color: "var(--sd-label)" }}>{s.n}</span>
            <span className="text-[12.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>{s.title}</span>
            <span className="text-[10.5px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>{s.desc}</span>
          </div>
        ))}
      </div>

      {adding && (
        <RuleForm
          programs={programs.map((p) => ({ id: p.id, title: p.title }))}
          onCancel={() => setAdding(false)}
          onSaved={async (notice) => {
            setAdding(false);
            toast({ title: "규칙을 만들었습니다", description: notice, tone: "done" });
            await load();
          }}
        />
      )}

      {/* ── 보류 큐 — 이 화면의 핵심 ──────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>보류 큐</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            게이트에 막힌 건입니다 — <b>확정해야 다음 순방에 다시 잡힙니다.</b> 이슈를 해제해도 저절로 나가지 않습니다.
          </span>
        </div>
        {holds.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            보류된 건이 없습니다
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {holds.map((h) => (
              <div key={`${h.ruleId}:${h.clipId}`} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="sd-mono text-[11px]" style={{ color: "var(--sd-mut)" }}>{h.clipId}</span>
                <span className="min-w-[200px] flex-1 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>{h.reason}</span>
                <span className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>{h.heldAt?.slice(0, 16).replace("T", " ")}</span>
                <button type="button" className="sd-btn sd-btn-primary" onClick={() => void release(h)}>
                  확정 — 다시 잡기
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 규칙 ─────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>규칙</h3>
        {rules.length === 0 ? (
          <div
            className="sd-ph grid min-h-[100px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            규칙이 없습니다 — 자동 배포는 규칙이 있어야만 동작합니다 (기본 동작 없음)
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rules.map((r) => {
              const program = programs.find((p) => p.id === r.programId);
              const upload = r.platform === "youtube";
              return (
                <div key={r.id} className="sd-card flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <span className="text-[12.5px] font-medium" style={{ color: "var(--sd-fg)" }}>
                    {program?.title ?? r.programId} → {r.platform}
                  </span>
                  <span className={cn("sd-tag", !r.enabled ? "sd-tag--ended" : upload ? "sd-tag--airing" : "")}>
                    {!r.enabled ? "멈춤" : upload ? "실행 중" : "기록만"}
                  </span>
                  <span className="sd-tag">{KIND_LABEL[r.mediaKind]}</span>
                  <span className="sd-tag">{CRIT_LABEL[r.criterion]}</span>
                  <span className="sd-tag sd-tag--warn">{POLICY_LABEL[r.gatePolicy]}</span>
                  <span className="sd-tag">{r.window}</span>
                  <span className="sd-tag">{r.templateId ? `템플릿 ${r.templateId}` : "템플릿 자동"}</span>

                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      className="sd-btn"
                      onClick={async () => {
                        try {
                          await saveAutomationRule({ ...r, enabled: !r.enabled });
                          toast({
                            title: r.enabled ? "규칙을 멈췄습니다" : "규칙을 재개했습니다",
                            description: program?.title ?? r.programId,
                            tone: "done",
                          });
                        } catch (err) {
                          toast({ title: "변경 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                        } finally {
                          await load();
                        }
                      }}
                    >
                      {r.enabled ? "멈춤" : "재개"}
                    </button>
                    <button
                      type="button"
                      className="sd-btn"
                      onClick={async () => {
                        if (!window.confirm("이 규칙을 지웁니다. 이미 게시된 영상은 내려가지 않습니다. 계속할까요?")) return;
                        try {
                          const res = await deleteAutomationRule(r.id);
                          toast({ title: "규칙을 지웠습니다", description: res.notice, tone: "done" });
                        } catch (err) {
                          toast({ title: "삭제 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
                        } finally {
                          await load();
                        }
                      }}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 자동 실행 로그 — 사람이 누른 배포와 분리 ─────────────────────── */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>최근 자동 실행</h3>
          <span className="text-[11px]" style={{ color: "var(--sd-mut)" }}>
            사람이 누른 배포는 여기 없습니다 — 배포 화면에서 봅니다
          </span>
        </div>
        {runs.length === 0 ? (
          <div
            className="sd-ph grid min-h-[80px] place-items-center rounded-[6px] px-6 text-center"
            style={{ border: "1px dashed var(--sd-border)" }}
          >
            자동 실행 기록이 없습니다
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {runs.map((run) => (
              <div key={run.id} className="sd-card flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="sd-mono text-[10.5px]" style={{ color: "var(--sd-mut)" }}>
                  {run.at?.slice(0, 16).replace("T", " ")}
                </span>
                <span className="min-w-[200px] flex-1 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
                  {run.detail || run.clipId || "—"}
                </span>
                <span className={RESULT_TAG[run.result] ?? "sd-tag"}>
                  {RESULT_LABEL[run.result] ?? run.result}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 하단 경고 — 자동도 게이트를 건너뛰지 않는다 */}
      <div
        className="rounded-[4px] px-3 py-2.5 text-[11.5px] leading-relaxed"
        style={{ border: "1px solid var(--sd-warn-border)", background: "var(--sd-warn-bg)", color: "var(--sd-warn)" }}
      >
        <b>자동 배포도 게이트를 건너뛰지 않습니다.</b> 권리·심의를 통과하지 않은 미디어는 어떤 규칙으로도
        나가지 않고 보류 큐에 쌓입니다. 보류된 건은 사람이 확정해야 다음 순방에 다시 잡힙니다 —
        이슈를 해제해서 게이트가 열려도 저절로 나가지 않습니다.
      </div>
    </div>
  );
}

function RuleForm({
  programs,
  onCancel,
  onSaved,
}: {
  programs: { id: string; title: string }[];
  onCancel: () => void;
  onSaved: (notice: string) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [programId, setProgramId] = useState(programs[0]?.id ?? "");
  const [platform, setPlatform] = useState("youtube");
  const [accountId, setAccountId] = useState("");
  const [mediaKind, setMediaKind] = useState<RuleMediaKind>("short");
  const [criterion, setCriterion] = useState<RuleCriterion>("score80");
  const [approveFirst, setApproveFirst] = useState(true);
  const [win, setWin] = useState("방영 익일 10시");
  const [templateId, setTemplateId] = useState("");   // "" = 프로그램 장르 자동
  const [templates, setTemplates] = useState<FrameTemplate[]>([]);
  // 위치 미세조정 — 시드 기본값에서 시작, 슬라이더로 조절. 저장 시 layout 으로 전송.
  const [layout, setLayout] = useState<{ titleY: number; channelIconY: number; channelBoxY: number; channelIconSize: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchShortsTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // 템플릿 바꾸면 슬라이더를 그 템플릿의 시드 기본값으로 리셋.
  const effectiveTemplate = templateId || "broadcast-standard";
  useEffect(() => {
    const s = TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"];
    setLayout({ titleY: s.titleY, channelIconY: s.iconY, channelBoxY: s.boxY, channelIconSize: s.iconSize });
  }, [effectiveTemplate]);

  // 계정 ID 를 자유 입력으로 두면 오타 하나로 규칙이 "실행 중" 배지를 달고 영원히 아무것도
  // 안 한다(순방이 채널 규칙을 못 찾으면 skipped 로만 남는다). 실재하는 규칙에서만 고르게 한다.
  const [channelRules, setChannelRules] = useState<ChannelRule[] | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchChannelRules()
      .then((rs) => { if (alive) { setChannelRules(rs); setRulesErr(null); } })
      .catch((err) => {
        if (!alive) return;
        setChannelRules([]);
        setRulesErr(err instanceof Error ? err.message : String(err));
      });
    return () => { alive = false; };
  }, []);

  // 배포 규칙이 없어도 배포는 가능해야 한다 — YouTube 는 연결된 게시 가능 채널을
  // 직접 불러와 규칙 유무와 무관하게 고를 수 있게 한다 (규칙 있으면 라벨에 표시만).
  const [ytChannels, setYtChannels] = useState<{ channelId: string; channelName: string; status: string }[]>([]);
  useEffect(() => {
    void fetchYouTubeChannels()
      .then((cs) => setYtChannels(cs.filter((c) => c.status === "active")))
      .catch(() => setYtChannels([]));
  }, []);

  const platformRules = (channelRules ?? []).filter((r) => r.platform === platform);
  // 선택지 = (YouTube 면) 연결 채널 ∪ 규칙 계정, 그 외 플랫폼은 규칙 계정.
  const accountOptions: { accountId: string; label: string }[] = platform === "youtube"
    ? ytChannels.map((c) => {
        const ruled = platformRules.some((r) => r.accountId === c.channelId);
        return { accountId: c.channelId, label: `${c.channelName}${ruled ? " · 규칙 있음" : ""}` };
      })
    : platformRules.map((r) => ({ accountId: r.accountId, label: `${r.label} · ${r.accountId}` }));

  useEffect(() => {
    // 플랫폼을 바꾸면 그 플랫폼에 없는 계정이 남아 있으면 안 된다.
    setAccountId((prev) => (accountOptions.some((o) => o.accountId === prev) ? prev : accountOptions[0]?.accountId ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, channelRules, ytChannels]);
  const upload = platform === "youtube";

  async function save() {
    if (!programId || !accountId.trim()) return;
    setBusy(true);
    try {
      const r = await saveAutomationRule({
        programId, platform, accountId: accountId.trim(),
        mediaKind, criterion,
        gatePolicy: approveFirst ? "approve_first" : "hold_on_issue",
        window: win, enabled: true,
        ...(templateId ? { templateId } : {}),
        ...(layout ? { layout } : {}),
      });
      await onSaved(r.notice);
    } catch (err) {
      toast({ title: "저장 실패", description: err instanceof Error ? err.message : String(err), tone: "error" });
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-2.5 rounded-[5px] p-3"
      style={{ background: "var(--sd-card-sub)", border: "1px solid var(--sd-border)" }}
    >
      <div className="grid grid-cols-2 gap-2">
        <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="sd-input">
          {programs.length === 0 && <option value="">프로그램 없음</option>}
          {programs.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="sd-input">
          <option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
          <option value="tiktok">TikTok</option>
          <option value="navertv">네이버 TV</option>
          <option value="naverclip">네이버 클립</option>
        </select>
      </div>

      <div>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="sd-input w-full"
          disabled={accountOptions.length === 0}
        >
          {accountOptions.length === 0 ? (
            <option value="">
              {platform === "youtube" ? "연결된 YouTube 채널이 없습니다" : "이 플랫폼의 채널 규칙이 없습니다"}
            </option>
          ) : (
            accountOptions.map((o) => (
              <option key={o.accountId} value={o.accountId}>{o.label}</option>
            ))
          )}
        </select>
        {accountOptions.length === 0 && (
          <p className="mt-1 text-[10.5px]" style={{ color: "var(--sd-warn)" }}>
            {platform === "youtube" ? (
              <><Link href="/publish-channels" className="underline">배포 채널</Link> 화면에서 채널을 먼저 연결하세요.</>
            ) : (
              <>{rulesErr ? `채널 규칙을 불러오지 못했습니다 (${rulesErr}) — ` : ""}
              <Link href="/channels" className="underline">배포 규칙</Link> 화면에서 이 플랫폼의 규칙을 먼저 만드세요.</>
            )}
          </p>
        )}
        {platform === "youtube" && accountId && !platformRules.some((r) => r.accountId === accountId) && (
          <p className="mt-1 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
            배포 규칙 없이 진행 — 길이·프레임 제한 없이 기본값(비공개 업로드)으로 나갑니다.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <select value={mediaKind} onChange={(e) => setMediaKind(e.target.value as RuleMediaKind)} className="sd-input">
          {(Object.keys(KIND_LABEL) as RuleMediaKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
        <select value={criterion} onChange={(e) => setCriterion(e.target.value as RuleCriterion)} className="sd-input">
          {(Object.keys(CRIT_LABEL) as RuleCriterion[]).map((k) => (
            <option key={k} value={k}>{CRIT_LABEL[k]}</option>
          ))}
        </select>
      </div>

      <input value={win} onChange={(e) => setWin(e.target.value)} placeholder="시간대" className="sd-input w-full" />

      {/* 렌더 템플릿 — 자동 생성 클립의 기본 모양. 비우면 프로그램 장르로 자동 선택. */}
      <div>
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="sd-input w-full">
          <option value="">템플릿: 자동 (드라마=확대 크롭 · 그 외=표준)</option>
          {templates.map((t) => (
            <option key={t.name} value={t.name}>템플릿: {t.title || t.name}</option>
          ))}
        </select>
        <p className="mt-1 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
          로고·방영시간은 프로그램 설정(쇼츠 아이콘·편성 시간)에서 채워집니다.
        </p>
      </div>

      {/* 미리보기 + 위치 조절 — 저장되는 렌더 기하와 같은 % 좌표를 그대로 그린다 */}
      {layout && (
        <div className="flex gap-3">
          <TemplatePreview
            template={templates.find((t) => t.name === effectiveTemplate) ?? null}
            accent={(TEMPLATE_SEED_UI[effectiveTemplate] ?? TEMPLATE_SEED_UI["broadcast-standard"]).accent}
            layout={layout}
          />
          <div className="flex-1 space-y-2 text-[10.5px]" style={{ color: "var(--sd-fg-dim)" }}>
            {([
              ["제목 위치", "titleY", 3, 30],
              ["로고 위치", "channelIconY", 60, 92],
              ["시간박스 위치", "channelBoxY", 62, 94],
              ["로고 크기", "channelIconSize", 20, 90],
            ] as const).map(([label, key, min, max]) => (
              <label key={key} className="block">
                {label} <span className="opacity-70">{Math.round(layout[key])}{key === "channelIconSize" ? "px" : "%"}</span>
                <input
                  type="range" min={min} max={max} step={0.5} value={layout[key]}
                  onChange={(e) => setLayout({ ...layout, [key]: Number(e.target.value) })}
                  className="w-full"
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--sd-fg)" }}>
        <input type="checkbox" checked={approveFirst} onChange={(e) => setApproveFirst(e.target.checked)} />
        게시 전 사람 승인 (끄면 게이트만 통과하면 바로 나갑니다)
      </label>

      {/* ⚑ 채널별 안내 — 만들 때 성격을 말한다 (F6). */}
      <p
        className="rounded-[4px] px-2.5 py-2 text-[11px] leading-relaxed"
        style={{
          border: `1px solid ${upload ? "var(--sd-border)" : "var(--sd-warn-border)"}`,
          background: upload ? "var(--sd-card)" : "var(--sd-warn-bg)",
          color: upload ? "var(--sd-mut)" : "var(--sd-warn)",
        }}
      >
        {upload
          ? "YouTube 는 실제 파일이 업로드됩니다. 기본 공개 범위와 시간대는 배포 채널 규칙을 따릅니다."
          : "이 채널은 배포 기록만 남습니다 — 파일이 올라가지 않고, 실제 게시는 담당자가 해당 앱에서 직접 해야 합니다."}
      </p>

      <div className="flex gap-2">
        <button type="button" className="sd-btn" onClick={onCancel}>취소</button>
        <button
          type="button"
          className="sd-btn sd-btn-primary ml-auto"
          disabled={busy || !programId || !accountId.trim()}
          onClick={save}
        >
          규칙 만들기
        </button>
      </div>
    </div>
  );
}
