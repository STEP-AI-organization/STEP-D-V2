"use client";

/**
 * 완전자동화 — 수집 채널을 지정하면 롱폼을 받아 숏폼으로 만들어 배포한다.
 *
 * 실험실에 둔다(사용자 지정 2026-09-04). 예비 기능을 모아 두는 자리이고, 본 메뉴에 두면
 * 완성된 기능으로 읽힌다 — 이건 **크레딧이 저절로 나가는** 기능이라 더욱 그렇다.
 *
 * ## 이 화면이 반드시 보여줘야 하는 것
 *
 *  1. **등록 전 예상 소모.** "312편 · 18,700크레딧 · 156일" 을 누르기 전에 봐야 한다.
 *     이걸 안 보여주면 채널 하나 등록에 잔액이 사라지고, 사용자는 무엇이 그랬는지도 모른다.
 *  2. **왜 안 도는지.** 확인 필요 · 크레딧 부족 · 일시정지가 각각 다른 말로 보여야 한다.
 *  3. **어디로 나가는지.** 배포 채널이 없으면 아무것도 가져오지 않는다 — 그 상태를 크게 알린다.
 *
 * ## 권리 확인도 여기서 한다 (2026-09-04 사용자 결정)
 *
 * 처음엔 STEPAI 어드민에서만 열 수 있게 했다. 그런데 그 채널과 어떤 계약을 맺었는지 아는
 * 것은 **쓰는 쪽**이다 — 우리가 심사하는 척하면 심사는 형식이 되고, 고객은 채널 하나
 * 추가할 때마다 사람을 기다린다. 대신 **누가 확인했는지는 기록에 남는다**(owner·admin만).
 *
 * ## 입력은 둘이다 (2026-09-04)
 *
 *   수집 채널(유튜브 주소)  +  배포 채널(연결된 것 중 선택)
 *
 * 프로그램은 **수집 채널 이름으로 자동 생성**되고(사용자 지정), 배포 계획도 등록과 함께
 * 만들어진다. 시간대·요일·템플릿은 **자동 배포 화면과 같은 것**을 쓴다 — 값의 정규화와
 * 하루 발행 수 계산은 서버 순방과 같은 순수 함수(`ruleSlots`·`perDayCount`)가 한다.
 * 화면이 따로 세면 "하루 3개" 라고 적어 놓고 다르게 나간다.
 *
 * 만든 뒤 계획을 고치는 건 **자동 배포 화면**에서 한다 — 한 계획을 두 화면에서 편집하게
 * 두면 어느 쪽이 이기는지 아무도 모른다.
 *
 * 숫자는 **서버가 계산한 것을 그대로 그린다**(pipeline/harvest.ts 가 수확기와 같은 함수를
 * 쓴다). 화면이 따로 세면 "312편 남았다" 고 해 놓고 다르게 수확하는 일이 생긴다.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { SlotPicker } from "@/components/automation/slot-picker";
// 순방 판정과 **같은 함수**로 하루 발행 수·요일 문구를 낸다. automation.ts 는 import 0개짜리
// 순수 모듈이라 웹이 그대로 가져다 쓴다(자동배포 화면도 같은 것을 쓴다).
import {
  formatWeekdays, perDayCount, slotLabel, type RuleSlot,
} from "@server-pure/pipeline/automation";
import {
  approveHarvestSource, createHarvestSource, deleteHarvestSource, fetchHarvestSources,
  fetchShortsTemplates, fetchYouTubeChannels, runHarvest, updateHarvestSource,
  type FrameTemplate, type HarvestSource, type YouTubeChannelInfo,
} from "@/lib/data/api";

const CARD = "bg-[var(--color-bg-card)] rounded-2xl shadow-md shadow-slate-900/5 dark:shadow-none";
const MUTED = "text-[var(--color-text-muted)]";
const FIELD =
  "w-full px-3 py-2 rounded-xl bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] outline-none";
const LABEL = `block text-[11px] font-bold mb-1.5 ${MUTED}`;

/** 상태 한 줄 — 사용자가 지금 무엇을 해야 하는지가 여기서 갈린다. */
const STATE: Record<HarvestSource["status"], { label: string; hint: string; tone: string }> = {
  active: { label: "수집 중", hint: "새 영상이 올라오면 자동으로 가져옵니다.", tone: "text-emerald-500" },
  paused: { label: "일시정지", hint: "다시 시작하기 전까지 아무것도 가져오지 않습니다.", tone: "text-amber-500" },
  blocked: {
    label: "확인 필요",
    hint: "우리가 연결한 채널이 아닙니다 — 이 채널 영상을 쓸 권리가 있는지 확인해 주세요. 확인 전에는 아무것도 가져오지 않습니다.",
    tone: "text-rose-500",
  },
};

export default function FullAutoPage() {
  const [sources, setSources] = useState<HarvestSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [backfill, setBackfill] = useState(true);
  const [busy, setBusy] = useState(false);
  // 순회 결과 — "왜 안 가져왔는지" 가 사용자가 알아야 하는 값이다. 조용히 끝내면
  // "눌렀는데 아무 일도 안 남" 이 되고, 그때 사람은 기능이 고장 났다고 판단한다.
  const [running, setRunning] = useState(false);
  const [runNotes, setRunNotes] = useState<string[] | null>(null);

  // 배포 설정 — 자동 배포 화면과 같은 값 체계. 기본은 그 화면의 새 계획 기본과 맞춘다:
  // 요일 비움 = 매일, 슬롯 비움 = 할당량 방식(하루 3개), 템플릿 비움 = 장르 자동.
  const [channels, setChannels] = useState<YouTubeChannelInfo[]>([]);
  const [selChannels, setSelChannels] = useState<string[]>([]);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [slots, setSlots] = useState<RuleSlot[]>([]);
  const [templates, setTemplates] = useState<FrameTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setSources(await fetchHarvestSources());
    } catch (e) {
      setError(e instanceof Error ? e.message : "목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 배포 채널·템플릿은 목록과 무관하게 한 번만 읽는다. 실패해도 화면을 세우지 않는다 —
  // 수집원 목록은 그대로 보여야 "왜 안 도는지" 를 볼 수 있다.
  useEffect(() => {
    void fetchYouTubeChannels()
      .then((list) => setChannels(list.filter((ch) => ch.status !== "disconnected")))
      .catch(() => setChannels([]));
    void fetchShortsTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  /** 하루 몇 개가 나가는지 — **서버 순방과 같은 함수**로 낸다(화면이 곱하지 않는다). */
  const perDay = useMemo(() => perDayCount({ slots, dailyQuota: 3 }), [slots]);

  /**
   * 수확 순회를 **지금** 돌린다. 상한은 그대로다 — 이 버튼은 시각만 앞당긴다.
   * 결과(무엇을 가져왔는지 · 왜 안 가져왔는지)를 그대로 화면에 남긴다.
   */
  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setRunNotes(null);
    try {
      const report = await runHarvest();
      setRunNotes(
        report.outcomes.length === 0
          ? ["등록된 수집 채널이 없습니다."]
          : report.outcomes.map((o) => (o.picked ? `가져왔습니다 — ${o.note}` : o.note)),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "지금 가져오지 못했습니다.");
    } finally {
      setRunning(false);
    }
  }, [running, load]);

  const add = useCallback(async () => {
    const v = url.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    setRunNotes(null);
    try {
      await createHarvestSource({
        sourceChannelUrl: v, backfill,
        // 배포 채널을 안 골랐으면 계획을 만들지 않는다 — 그 상태는 목록에서 경고로 보인다.
        ...(selChannels.length
          ? { publish: { channels: selChannels, slots, weekdays, ...(templateId ? { templateId } : {}) } }
          : {}),
      });
      setUrl("");
      await load();
      // **등록하면 그 자리에서 한 번 돈다.** 새벽 2시까지 기다려야 아무 일이 일어나는지
      // 알 수 있으면 사용자는 기능이 고장 났다고 판단한다. 상한은 그대로라 여기서
      // 가져오는 것도 한 편뿐이다.
      await run();
    } catch (e) {
      // 서버가 사람 말로 준 사유를 그대로 — "핸들을 못 찾았다", "이미 등록됐다" 가
      // 화면에서 사라지면 사용자는 무엇을 고쳐야 할지 모른다.
      setError(e instanceof Error ? e.message : "등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [url, backfill, selChannels, slots, weekdays, templateId, busy, load, run]);

  const patch = useCallback(async (id: string, p: Parameters<typeof updateHarvestSource>[1]) => {
    setError(null);
    try {
      await updateHarvestSource(id, p);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "바꾸지 못했습니다.");
    }
  }, [load]);

  /**
   * 권리 확인 — 이 채널 영상을 쓸 권리가 있다고 확정한다.
   *
   * 확인하면 **그 채널 영상을 내려받아 숏폼으로 만들어 배포 채널에 올린다.** 남의 영상이면
   * 저작권 사고라, 되돌릴 수 없는 쪽에 서기 전에 무슨 일이 일어나는지 그대로 적어 묻는다.
   */
  const approve = useCallback(async (s: HarvestSource) => {
    const ok = window.confirm(
      [
        `"${s.sourceChannelTitle || s.sourceChannelId}" 의 영상을 사용합니다.`,
        "",
        "이 채널의 영상을 내려받아 숏폼으로 만들어 배포 채널에 올립니다.",
        "이 채널 영상을 사용할 권리가 있습니까? (확인한 사람이 기록에 남습니다)",
      ].join("\n"),
    );
    if (!ok) return;
    setError(null);
    try {
      await approveHarvestSource(s.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "확인하지 못했습니다.");
    }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteHarvestSource(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "해지하지 못했습니다.");
    }
  }, [load]);

  return (
    <>
      <Header title="완전자동화" subtitle="수집 채널 → 숏폼 → 배포 채널까지 사람 없이" />

      <main className="flex-1 p-6 overflow-y-auto">
        <div className="space-y-4 max-w-5xl">
          {/* 무엇이 일어나는지 — 크레딧이 저절로 나가는 기능이라 먼저 말한다. */}
          <div className={`${CARD} p-4 text-xs leading-relaxed ${MUTED}`}>
            수집 채널을 등록하면 그 채널의 <b className="text-[var(--color-text-primary)]">긴 영상</b>을
            자동으로 가져와 분석하고, 숏폼을 만들어 <b className="text-[var(--color-text-primary)]">배포
            채널</b>에 올립니다. 프로그램은 <b className="text-[var(--color-text-primary)]">수집 채널
            이름</b>으로 자동으로 만들어집니다.
            <br />
            내려받기와 분석에는 크레딧이 듭니다 — 60분짜리 한 편이 60크레딧입니다. 그래서
            채널에 영상이 수천 개 있어도 <b className="text-[var(--color-text-primary)]">하루 한 편씩</b>만
            가져옵니다. 배포 예정 물량이 이미 충분하거나 배포할 채널이 없으면
            <b className="text-[var(--color-text-primary)]"> 내려받기 자체를 하지 않습니다.</b>
          </div>

          {/* 등록 — ① 수집 채널 · ② 배포 설정 순서. 사람이 정하는 것을 위에서 아래로 둔다. */}
          <div className={`${CARD} p-4 space-y-4`}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[260px]">
                <label className={LABEL}>수집할 유튜브 채널</label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void add(); }}
                  placeholder="youtube.com/@채널이름  또는  /channel/UC…"
                  className={FIELD}
                />
              </div>
              {/* 하루 편수는 **고르는 값이 아니다.** 수확 순회가 하루 한 번이라 실제로는
                  언제나 1편이고(harvest.ts MAX_PER_DAY), 입력칸을 두면 3 을 넣은 사람이
                  하루 3편을 기대하게 된다 — 지키지도 못할 약속이다. 사실만 적는다. */}
              <div className={`text-xs pb-2.5 ${MUTED}`}>
                하루 <b className="text-[var(--color-text-primary)]">1편</b>씩 가져옵니다
              </div>
              <label className={`flex items-center gap-2 text-xs pb-2.5 ${MUTED} cursor-pointer`}>
                <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
                과거 영상까지
              </label>
            </div>

            {/* 배포 설정 — 자동 배포 화면과 같은 컨트롤(발행 요일·발행 시간·템플릿). */}
            <div className="pt-4 border-t border-[var(--color-border-subtle)]/50 space-y-4">
              <div>
                <label className={LABEL}>배포할 채널 (연결된 유튜브 채널)</label>
                {channels.length === 0 ? (
                  <p className={`text-[11px] ${MUTED}`}>
                    연결된 채널이 없습니다 —{" "}
                    <Link href="/publish-channels" className="underline text-[var(--color-text-primary)]">
                      배포채널
                    </Link>{" "}
                    화면에서 먼저 연결하세요. 채널을 안 고르면 숏폼을 만들기만 하고 올리지 않습니다.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {channels.map((ch) => {
                      const on = selChannels.includes(ch.channelId);
                      return (
                        <button
                          key={ch.channelId} type="button"
                          onClick={() => setSelChannels(
                            on ? selChannels.filter((x) => x !== ch.channelId) : [...selChannels, ch.channelId],
                          )}
                          className="px-3 py-1.5 rounded-full text-xs font-bold transition-colors cursor-pointer"
                          style={on
                            ? { background: "var(--color-text-primary)", color: "var(--color-bg-card)" }
                            : { border: "1px solid var(--color-border-subtle)", color: "var(--color-text-muted)" }}
                        >
                          {ch.channelName || ch.channelId}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <span className={`text-[11px] font-bold ${MUTED}`}>발행 요일</span>
                    <span className={`text-[11px] ${MUTED}`}>{formatWeekdays(weekdays)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                      const on = weekdays.includes(d);
                      return (
                        <button
                          key={d} type="button"
                          onClick={() => setWeekdays(
                            on ? weekdays.filter((x) => x !== d) : [...weekdays, d].sort((a, b) => a - b),
                          )}
                          className="h-7 w-8 rounded-xl text-xs cursor-pointer"
                          style={on
                            ? { background: "var(--color-text-primary)", color: "var(--color-bg-card)" }
                            : { border: "1px solid var(--color-border-subtle)", color: "var(--color-text-muted)" }}
                        >
                          {["", "월", "화", "수", "목", "금", "토", "일"][d]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <span className={`text-[11px] font-bold ${MUTED}`}>발행 시간 (KST)</span>
                    <span className={`text-[11px] ${MUTED}`}>시각마다 올릴 개수를 정하세요</span>
                  </div>
                  <SlotPicker slots={slots} onChange={setSlots} />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="full-auto-template" className={LABEL}>영상 템플릿</label>
                  <select
                    id="full-auto-template"
                    value={templateId}
                    onChange={(e) => setTemplateId(e.target.value)}
                    className={FIELD}
                  >
                    <option value="">자동 선택 (드라마=확대 크롭 · 그 외=표준)</option>
                    {templates.map((t) => <option key={t.name} value={t.name}>{t.title || t.name}</option>)}
                  </select>
                </div>

                {/* 하루 발행 수는 **컨트롤이 아니라 결과 표기**다 — 서버와 같은 함수(perDayCount). */}
                <div className="flex items-end">
                  <div className="w-full p-3 rounded-xl bg-slate-100 dark:bg-stone-800/60 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="text-xs font-bold text-[var(--color-text-primary)]">채널당 하루 발행</span>
                    <div className="flex items-center gap-2">
                      <span className="font-extrabold text-sm text-[#1C60FF]">{perDay}개</span>
                      <span className={`text-[11px] ${MUTED}`}>
                        {slots.length ? "시각당 개수의 합" : "시간 미지정 · 24시간 안에서"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className={`text-[11px] leading-relaxed ${MUTED} flex-1 min-w-[280px]`}>
                  등록하면 이 설정으로 <b className="text-[var(--color-text-primary)]">자동 배포 계획</b>이
                  같이 만들어집니다 — 이후 수정은{" "}
                  <Link href="/automation" className="underline text-[var(--color-text-primary)]">자동 배포</Link>{" "}
                  화면에서 하세요. 완전자동화는 <b className="text-[var(--color-text-primary)]">사람 승인
                  없이</b> 바로 올립니다.
                </p>
                <button
                  onClick={() => { void add(); }}
                  disabled={busy || !url.trim()}
                  className="px-4 py-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-bold transition-colors cursor-pointer flex items-center gap-1.5 shadow-md shadow-slate-900/5 dark:shadow-none disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  <span>등록</span>
                </button>
              </div>
            </div>

            <p className={`text-[11px] ${MUTED}`}>
              우리가 연결한 채널이 아니면 <b>확인 필요</b> 상태로 등록됩니다 — 남의 영상을 재배포하는
              것은 저작권 문제라, 그 채널 영상을 쓸 권리가 있는지 확인해야 돕니다(관리자만).
            </p>
          </div>

          {error && (
            <div className={`${CARD} p-4 text-xs text-rose-500`}>{error}</div>
          )}

          {/* 지금 가져오기 — 새벽 2시를 기다리지 않는다. 상한은 그대로라 눌러도 한 편이다. */}
          <div className={`${CARD} p-4 flex flex-wrap items-center justify-between gap-3`}>
            <div className={`text-[11px] leading-relaxed ${MUTED} flex-1 min-w-[260px]`}>
              평소에는 <b className="text-[var(--color-text-primary)]">매일 새벽 2시</b>에 한 번
              확인합니다. 지금 바로 확인하려면 오른쪽 버튼을 누르세요 — 눌러도 가져오는 양은
              같습니다(채널당 한 편).
            </div>
            <button
              onClick={() => { void run(); }}
              disabled={running || busy}
              className="px-4 py-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-bold transition-colors cursor-pointer flex items-center gap-1.5 shadow-md shadow-slate-900/5 dark:shadow-none disabled:cursor-not-allowed disabled:opacity-70"
            >
              {running
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5" />}
              <span>지금 가져오기</span>
            </button>
          </div>

          {/* 순회 결과 — 안 가져왔으면 **그 이유**가 여기 남는다. */}
          {runNotes && (
            <div className={`${CARD} p-4 text-[11px] leading-relaxed ${MUTED} space-y-1`}>
              <b className="text-[var(--color-text-primary)]">방금 확인한 결과</b>
              {runNotes.map((n, i) => <div key={i}>· {n}</div>)}
            </div>
          )}

          {/* 목록 */}
          {loading ? (
            <div className={`${CARD} p-10 text-center text-xs ${MUTED}`}>불러오는 중…</div>
          ) : sources.length === 0 ? (
            <div className={`${CARD} p-10 text-center text-xs ${MUTED} leading-relaxed`}>
              등록된 수집 채널이 없습니다.<br />위에 채널 주소를 넣으면 그때부터 자동으로 가져옵니다.
            </div>
          ) : (
            <div className="space-y-3">
              {sources.map((s) => {
                const st = STATE[s.status];
                return (
                  <div key={s.id} className={`${CARD} p-4`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-[14px] text-[var(--color-text-primary)] truncate">
                            {s.sourceChannelTitle || s.sourceChannelId}
                          </h3>
                          <span className={`text-[11px] font-bold ${st.tone}`}>{st.label}</span>
                        </div>
                        <p className={`mt-1 text-[11px] ${MUTED}`}>{st.hint}</p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* 확인은 **여기**서 한다(2026-09-04 사용자 결정) — 예전엔 STEPAI 어드민에서만
                            열 수 있었는데, 그 채널과 어떤 계약을 맺었는지 아는 건 쓰는 쪽이다. */}
                        {s.status === "blocked" && (
                          <button
                            onClick={() => { void approve(s); }}
                            className="px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] border border-[var(--color-border-subtle)] text-[11px] font-bold text-[var(--color-text-primary)] transition-colors cursor-pointer flex items-center gap-1"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>권리 확인</span>
                          </button>
                        )}
                        {s.status !== "blocked" && (
                          <button
                            onClick={() => { void patch(s.id, { status: s.status === "paused" ? "active" : "paused" }); }}
                            className="p-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] border border-[var(--color-border-subtle)] transition-colors cursor-pointer"
                            aria-label={s.status === "paused" ? "다시 시작" : "일시정지"}
                          >
                            {s.status === "paused"
                              ? <Play className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                              : <Pause className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
                          </button>
                        )}
                        <button
                          onClick={() => { void remove(s.id); }}
                          className="p-2 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] border border-[var(--color-border-subtle)] transition-colors cursor-pointer"
                          aria-label="해지"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                        </button>
                      </div>
                    </div>

                    {/* 어디로 나가는지 — 계획이 없으면 **만들기만 하고 안 나간다**. 크레딧은
                        그대로 나가므로 조용히 두면 안 되는 상태다. */}
                    <PublishLine publish={s.publish} />

                    {/* 진행률 — 숫자는 서버가 수확기와 같은 기준으로 계산한 값이다. */}
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-[var(--color-border-subtle)]/50">
                      <Stat label="가져온 편수" value={`${s.made.toLocaleString("ko-KR")}편`} />
                      <Stat label="남은 롱폼" value={`${s.remaining.toLocaleString("ko-KR")}편`} />
                      <Stat label="예상 크레딧" value={s.credits.toLocaleString("ko-KR")} />
                      <Stat
                        label="예상 소요"
                        value={s.remaining === 0 ? "—" : `${s.days.toLocaleString("ko-KR")}일`}
                        note="하루 1편"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 아는 함정을 미리 적는다 — 이걸 모르면 "수집은 됐는데 영상이 안 온다" 에서 막힌다. */}
          <div className={`${CARD} p-4 text-[11px] leading-relaxed ${MUTED}`}>
            <b className="text-[var(--color-text-primary)]">알아 두실 것</b> · 영상 내려받기는 사무실
            전용 PC 에서 돕니다. 그 PC 가 꺼져 있으면 회차만 만들어지고 영상은 나중에 내려옵니다.
            크레딧이 부족하면 새 영상을 가져오지 않습니다 — 충전하면 다음 순회부터 다시 돕니다.
            해지해도 이미 만든 회차와 배포 계획은 남습니다.
          </div>
        </div>

        <Footer />
      </main>
    </>
  );
}

/**
 * 배포 계획 한 줄. **계획이 없으면 수집이 멈춰 있다는 뜻**이다.
 *
 * 예전엔 계획이 없어도 계속 가져왔고, 그건 곧 안 나갈 영상을 채널이 빌 때까지 받아 두는
 * 것이었다. 지금은 아예 안 가져온다(harvest.ts `no_plan`) — 그러니 이 경고는 "결과물이
 * 안 나간다" 가 아니라 **"아무것도 안 돌고 있다"** 로 읽혀야 한다.
 */
function PublishLine({ publish }: { publish: HarvestSource["publish"] }) {
  if (!publish) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[11px] leading-relaxed bg-amber-500/10 text-[var(--color-text-primary)]">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
        <span>
          <b>배포 채널이 없어 멈춰 있습니다</b> — 올릴 곳이 없으면 영상을 내려받지도 않습니다
          (크레딧을 쓰지 않습니다).{" "}
          <Link href="/automation" className="underline">자동 배포</Link> 화면에서 이 프로그램의
          계획을 만들면 그때부터 돕니다.
        </span>
      </div>
    );
  }
  return (
    <div className={`mt-3 text-[11px] ${MUTED}`}>
      <b className="text-[var(--color-text-primary)]">
        {publish.channels.map((ch) => ch.name).join(" · ") || "채널 미지정"}
      </b>
      {" 으로 "}
      {formatWeekdays(publish.weekdays)} 하루 {publish.perDay}개
      {publish.slots.length ? ` · ${publish.slots.map(slotLabel).join(" ")}` : ""}
      {publish.templateId ? ` · 템플릿 ${publish.templateId}` : " · 템플릿 자동"}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className={`text-[10.5px] font-bold ${MUTED}`}>{label}</div>
      <div className="mt-0.5 font-mono text-[15px] font-bold text-[var(--color-text-primary)]">{value}</div>
      {note && <div className={`text-[10.5px] ${MUTED}`}>{note}</div>}
    </div>
  );
}
