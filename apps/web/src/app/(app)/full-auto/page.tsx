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
 *  2. **왜 안 도는지.** 승인 대기 · 크레딧 부족 · 일시정지가 각각 다른 말로 보여야 한다.
 *  3. **어디로 나가는지.** 배포 채널이 없으면 **만들기만 하고 아무 데도 안 나간다** —
 *     크레딧은 그대로 나가는데. 그 상태를 목록에서 크게 알린다.
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
import { AlertTriangle, Loader2, Pause, Play, Plus, Trash2 } from "lucide-react";

import { Footer } from "@/components/layout/footer";
import { Header } from "@/components/layout/header";
import { SlotPicker } from "@/components/automation/slot-picker";
// 순방 판정과 **같은 함수**로 하루 발행 수·요일 문구를 낸다. automation.ts 는 import 0개짜리
// 순수 모듈이라 웹이 그대로 가져다 쓴다(자동배포 화면도 같은 것을 쓴다).
import {
  formatWeekdays, perDayCount, slotLabel, type RuleSlot,
} from "@server-pure/pipeline/automation";
import {
  createHarvestSource, deleteHarvestSource, fetchHarvestSources, fetchShortsTemplates,
  fetchYouTubeChannels, updateHarvestSource,
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
    label: "승인 대기",
    hint: "연결하지 않은 채널이라 담당자 승인이 필요합니다. 승인 전에는 돌지 않습니다.",
    tone: "text-rose-500",
  },
};

export default function FullAutoPage() {
  const [sources, setSources] = useState<HarvestSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [cap, setCap] = useState(2);
  const [backfill, setBackfill] = useState(true);
  const [busy, setBusy] = useState(false);

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

  const add = useCallback(async () => {
    const v = url.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createHarvestSource({
        sourceChannelUrl: v, dailyCap: cap, backfill,
        // 배포 채널을 안 골랐으면 계획을 만들지 않는다 — 그 상태는 목록에서 경고로 보인다.
        ...(selChannels.length
          ? { publish: { channels: selChannels, slots, weekdays, ...(templateId ? { templateId } : {}) } }
          : {}),
      });
      setUrl("");
      await load();
    } catch (e) {
      // 서버가 사람 말로 준 사유를 그대로 — "핸들을 못 찾았다", "이미 등록됐다" 가
      // 화면에서 사라지면 사용자는 무엇을 고쳐야 할지 모른다.
      setError(e instanceof Error ? e.message : "등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [url, cap, backfill, selChannels, slots, weekdays, templateId, busy, load]);

  const patch = useCallback(async (id: string, p: Parameters<typeof updateHarvestSource>[1]) => {
    setError(null);
    try {
      await updateHarvestSource(id, p);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "바꾸지 못했습니다.");
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
            분석에는 크레딧이 듭니다 — 60분짜리 한 편이 60크레딧입니다. 그래서
            <b className="text-[var(--color-text-primary)]"> 하루 상한</b>을 두고 천천히 가져오고,
            배포 예정 물량이 이미 충분하면 그날은 가져오지 않습니다.
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
              <div className="w-28">
                <label className={LABEL}>하루 편수</label>
                <input
                  type="number" min={1} max={20} value={cap}
                  onChange={(e) => setCap(Number(e.target.value))}
                  className={FIELD}
                />
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
              우리가 연결한 채널이 아니면 <b>승인 대기</b>로 등록됩니다 — 남의 영상을 재배포하는 것은
              저작권 문제라, 담당자가 확인한 뒤에 돕니다.
            </p>
          </div>

          {error && (
            <div className={`${CARD} p-4 text-xs text-rose-500`}>{error}</div>
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
                        note={`하루 ${s.dailyCap}편`}
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
 * 배포 계획 한 줄. **계획이 없으면 경고**다 — 이 조합(가져오고 만들지만 안 나감)은
 * 크레딧만 쓰고 결과물이 아무 데도 안 가는, 이 기능의 최악 상태다.
 */
function PublishLine({ publish }: { publish: HarvestSource["publish"] }) {
  if (!publish) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[11px] leading-relaxed bg-amber-500/10 text-[var(--color-text-primary)]">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
        <span>
          <b>배포 채널이 없습니다</b> — 숏폼을 만들기만 하고 아무 데도 올리지 않습니다(크레딧은
          그대로 듭니다).{" "}
          <Link href="/automation" className="underline">자동 배포</Link> 화면에서 이 프로그램의
          계획을 만들어 주세요.
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
