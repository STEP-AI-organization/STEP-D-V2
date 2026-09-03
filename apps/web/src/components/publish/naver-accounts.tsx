"use client";

/**
 * 네이버 계정 연결 — 배포채널 화면의 한 섹션.
 *
 * 다른 채널과 근본적으로 다르다. 네이버는 **공개 업로드 API 가 없다.** 그래서 OAuth 버튼이
 * 없고, 사람이 한 번 로그인해서 만든 브라우저 세션을 등록하면 워커(사무실 PC)가 그걸로
 * 대신 올린다. 이 화면이 하는 일은 두 가지뿐이다 — 계정을 만들고, 세션을 넣는 것.
 *
 * ⚠️ **세션 쿠키는 그 계정의 전체 권한이다.** 아이디·비번보다 오히려 즉시 쓸 수 있어 위험하다.
 * 그래서:
 *   - 파일은 브라우저에서 읽어 **바로 서버로만** 보낸다. 화면에 내용을 그리지 않는다.
 *   - 서버는 암호화해 저장하고 다시는 돌려주지 않는다 — 여기서 볼 수 있는 건 "있다/없다" 뿐.
 *   - 키가 없으면 서버가 저장을 거부한다(sessionStoreReady=false) → 버튼을 미리 막는다.
 *     올려도 안 되는 버튼을 눌러보게 하는 게 더 나쁘다.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Download } from "lucide-react";
import { NaverCredentials } from "@/components/publish/naver-credentials";
import type { NaverAccount } from "@/lib/data/api";
import {
  fetchNaverAccounts,
  createNaverAccount,
  updateNaverAccount,
  deleteNaverAccount,
  uploadNaverSession,
  clearNaverSession,
} from "@/lib/data/api";

/** 원본 보조 버튼 / 삭제 버튼 (D:312·318). */
const BTN = "px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none";
const BTN_DEL = "px-3 py-1.5 rounded-full bg-[var(--color-bg-card)] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/60 dark:hover:text-rose-400 dark:hover:border-rose-900 text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer transition-colors shadow-none";

const TARGET_LABEL: Record<NaverAccount["target"], string> = {
  both: "네이버 TV + 클립",
  tv: "네이버 TV 전용",
  clip: "네이버 클립 전용",
};

/**
 * 명령에 넣어줄 주소. 운영자가 "그래서 --api 에 뭘 쓰죠?" 를 묻지 않게 화면이 채워 준다.
 *
 * ⚠️ `--api` 와 `--web` 이 다를 수 있다. 프로덕션 웹은 서버를 `/api/proxy` 로 경유하므로
 * (NEXT_PUBLIC_API_URL=/api/proxy/api), 스크립트가 뒤에 `/api/...` 를 붙인다는 걸 감안해
 * 끝의 `/api` 를 떼서 준다. 오리진만 주면 404 가 난다 — 프록시를 안 타기 때문이다.
 */
function cmdTargets(): { api: string; web: string } {
  if (typeof window === "undefined") return { api: "<서버주소>", web: "<웹주소>" };
  const origin = window.location.origin;
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";
  if (base.startsWith("http")) {
    // 서버에 직접 붙는 구성 — 로그인 화면은 여전히 웹 쪽이다.
    return { api: base.replace(/\/api$/, ""), web: origin };
  }
  return { api: `${origin}${base.replace(/\/api$/, "")}`, web: origin };
}

function when(ts: number | null): string {
  if (!ts) return "";
  return new Date(Number(ts)).toLocaleString("ko-KR", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function NaverAccounts({ onChange }: { onChange?: (accounts: NaverAccount[]) => void }) {
  const [accounts, setAccounts] = useState<NaverAccount[]>([]);
  // 세션 저장 키가 서버에 있는가. null = 아직 모름(목록을 못 읽음) — "안 된다"고 단정하지 않는다.
  const [storeReady, setStoreReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState<NaverAccount["target"]>("clip");
  const [busy, setBusy] = useState<string | null>(null);
  // 원본 드로어는 기본 열림이다(로그인 안내가 그 안에 있다) — 닫은 것만 기억한다.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [devOpen, setDevOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetchNaverAccounts();
      setAccounts(r.accounts);
      setStoreReady(r.sessionStoreReady);
      setErr(null);
      // 위쪽 플랫폼 카드가 같은 숫자를 보여준다 — 여기서만 갱신하면 둘이 어긋난다.
      onChange?.(r.accounts);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onChange]);
  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    const name = label.trim();
    if (!name) return;
    setBusy("add");
    try {
      await createNaverAccount(name, target);
      setLabel(""); setTarget("clip"); setAdding(false);
      setMsg(`'${name}' 추가됨 — 아래에서 로그인 세션을 등록하면 발행이 가능합니다.`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  /**
   * storageState JSON 을 골라 서버로 보낸다.
   *
   * 파일 내용은 **읽어서 곧장 전송**하고 상태에 담지 않는다 — React state 에 들어가면
   * devtools·에러 리포트·스크린샷 어디로든 쿠키가 새어나갈 수 있다.
   */
  const handleSession = async (acct: NaverAccount, file: File) => {
    setBusy(acct.id);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("JSON 파일이 아닙니다 — 로그인 세션(storageState) 파일을 선택하세요.");
      }
      await uploadNaverSession(acct.id, parsed);
      setMsg(`'${acct.label}' 로그인 세션이 등록됐습니다.`);
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const handleClearSession = async (acct: NaverAccount) => {
    if (!confirm(`'${acct.label}' 의 로그인 세션을 삭제할까요? 계정 설정은 남습니다.`)) return;
    setBusy(acct.id);
    try {
      await clearNaverSession(acct.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const handleDelete = async (acct: NaverAccount) => {
    if (!confirm(`'${acct.label}' 계정을 삭제할까요? 등록된 로그인 세션도 함께 사라집니다.`)) return;
    setBusy(acct.id);
    try {
      await deleteNaverAccount(acct.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const handleToggleDisabled = async (acct: NaverAccount) => {
    setBusy(acct.id);
    try {
      // 비활성 → 되살릴 때 active 로 올리지 않는다. 세션이 있어야 진짜 active 다 —
      // 세션 없이 active 로 두면 발행 시점에야 실패한다.
      await updateNaverAccount(acct.id, {
        status: acct.status === "disabled"
          ? (acct.hasSession ? "active" : "session_expired")
          : "disabled",
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  return (
    <div id="naver-accounts" className="space-y-3 scroll-mt-24">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-[var(--color-text-primary)]">
          네이버 연동 <span className="text-[11px] text-[var(--color-text-muted)] font-normal">(네이버 클립 — 공개 업로드 API 가 없어 로그인 세션으로 발행합니다)</span>
        </h3>
      </div>

      {msg && (
        <div className="p-3.5 rounded-2xl bg-[var(--color-bg-card)] border-none text-xs text-[var(--color-text-primary)] font-medium shadow-md shadow-slate-900/5 dark:shadow-none">
          {msg}
        </div>
      )}
      {err && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-400 font-medium">
          {err}
        </div>
      )}
      {storeReady === false && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400 font-medium leading-relaxed">
          서버에 세션 암호화 키(NAVER_SESSION_KEY)가 없어 로그인 세션을 등록할 수 없습니다.
          평문으로 저장하지 않으므로, 키를 설정하기 전까지 등록 버튼은 막혀 있습니다.
        </div>
      )}

      {/* Action Banner Card */}
      <div className="bg-[var(--color-bg-card)] border-none p-3.5 rounded-2xl flex items-center justify-between text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
        {adding ? (
          <div className="flex flex-wrap items-end gap-3 w-full">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-text-muted)] font-medium">계정 이름 (우리가 알아볼 이름)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="예: JTBC 공식 채널"
                autoFocus
                className="w-64 h-9 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--color-text-muted)] font-medium">쓸 곳</span>
              {/* 네이버 TV 는 제품에서 제외 (2026-08-13) — 새 계정은 클립 전용으로만 만든다.
                  기존 tv·both 계정은 데이터에 남아 있고 라벨 표시는 유지된다. */}
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value as NaverAccount["target"])}
                className="h-9 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] focus:outline-none"
              >
                <option value="clip">네이버 클립 전용</option>
              </select>
            </label>
            <button
              type="button"
              style={{ boxShadow: "none" }}
              onClick={handleAdd}
              disabled={!label.trim() || busy === "add"}
              className="px-3.5 py-2 rounded-full bg-[#222222] hover:bg-black text-white dark:bg-stone-700 dark:hover:bg-stone-600 text-xs font-bold transition-colors cursor-pointer shadow-none border-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === "add" ? "추가 중…" : "추가"}
            </button>
            <button
              type="button"
              style={{ boxShadow: "none" }}
              onClick={() => { setAdding(false); setLabel(""); }}
              className={BTN}
            >
              취소
            </button>
          </div>
        ) : (
          <>
            <span className="text-xs text-[var(--color-text-muted)]">
              고객사 채널마다 계정을 하나씩 등록합니다. 네이버 아이디·비밀번호는 받지 않습니다 — 로그인은 브라우저에서 직접 하고, 그 결과 세션만 등록합니다.
            </span>
            <button
              type="button"
              style={{ boxShadow: "none" }}
              onClick={() => setAdding(true)}
              className="px-3.5 py-2 rounded-full bg-[#222222] hover:bg-black text-white dark:bg-stone-700 dark:hover:bg-stone-600 text-xs font-bold transition-colors cursor-pointer shadow-none shrink-0 ml-4 border-none"
            >
              + 네이버 계정 추가
            </button>
          </>
        )}
      </div>

      {loading ? (
        <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-6 shadow-md shadow-slate-900/5 dark:shadow-none text-xs text-center text-[var(--color-text-muted)]">
          불러오는 중…
        </div>
      ) : accounts.length === 0 ? (
        <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-6 shadow-md shadow-slate-900/5 dark:shadow-none text-xs text-center text-[var(--color-text-muted)]">
          등록된 네이버 계정이 없습니다. 위 &quot;+ 네이버 계정 추가&quot; 로 시작하세요.
        </div>
      ) : (
        /* Clean Table List Card matching Reference Image 1 & 2 */
        <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-4 shadow-md shadow-slate-900/5 dark:shadow-none divide-y divide-[var(--color-border-subtle)]/60 text-xs">
          {/* List Header */}
          <div className="hidden sm:grid grid-cols-[38%_16%_22%_24%] items-center text-[11px] font-bold text-[var(--color-text-muted)] pb-2.5 px-3">
            <div className="text-left">계정 / 채널</div>
            <div className="text-center">상태</div>
            <div className="text-center">등록 / 발행 정보</div>
            <div className="text-right">관리 / 상세 설정</div>
          </div>

          {accounts.map((a) => {
            // 원본은 드로어가 기본 열림이다(로그인 안내가 그 안에 있다).
            const open = !closed[a.id];
            const toggle = () => setClosed((p) => ({ ...p, [a.id]: !p[a.id] }));
            return (
              <div key={a.id} className="py-3.5 first:pt-2 last:pb-0">
                <div
                  onClick={toggle}
                  className="grid grid-cols-1 sm:grid-cols-[38%_16%_22%_24%] items-center gap-2 sm:gap-0 px-3 cursor-pointer hover:bg-[var(--color-bg-input)]/40 rounded-xl py-1.5 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 border-none">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/channel-icons/naver.png" alt="네이버 클립" draggable={false} className="w-full h-full object-cover rounded-full" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">{a.label}</h4>
                      <p className="text-[11px] text-[var(--color-text-muted)] truncate">{TARGET_LABEL[a.target]}</p>
                    </div>
                  </div>

                  <div className="hidden sm:flex items-center justify-center text-center">
                    {/* 상태는 "세션이 있는가"가 먼저다 — 세션 없이 활성이라고 하면 거짓말이다. */}
                    {a.status === "disabled" ? (
                      <Pill tone="idle" label="비활성" />
                    ) : a.hasSession ? (
                      <Pill tone="ok" label="로그인됨" />
                    ) : (
                      <Pill tone="warn" label="로그인 필요" />
                    )}
                  </div>

                  <div className="hidden sm:flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-mono truncate">
                    {a.sessionUpdatedAt ? `${when(a.sessionUpdatedAt)} 등록` : "세션 없음"}
                    {a.lastPublishAt ? ` · ${when(a.lastPublishAt)} 발행` : ""}
                  </div>

                  <div className="flex items-center justify-end gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {/* 세션 파일 등록은 `<label>` 이어야 한다 — 안에 감춘 file input 을 여는 유일한 방법. */}
                    <label
                      className={`px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium shadow-none ${
                        storeReady === false || busy === a.id ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }`}
                      title="로그인한 브라우저에서 내보낸 세션(storageState) JSON 파일"
                    >
                      {busy === a.id ? "등록 중…" : a.hasSession ? "세션 갱신" : "로그인 세션 등록"}
                      <input
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        disabled={storeReady === false || busy === a.id}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          // 같은 파일을 다시 골라도 change 가 나게 값을 비운다.
                          e.target.value = "";
                          if (f) void handleSession(a, f);
                        }}
                      />
                    </label>
                    <button type="button" style={{ boxShadow: "none" }} onClick={() => handleDelete(a)} className={BTN_DEL}>
                      삭제
                    </button>
                    <button
                      type="button"
                      style={{ boxShadow: "none" }}
                      onClick={(e) => { e.stopPropagation(); toggle(); }}
                      title="상세 설정 보기"
                      className="p-1.5 rounded-full hover:bg-[var(--color-bg-input)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer shadow-none"
                    >
                      {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Expandable Detail Sub-Drawer */}
                {open && (
                  <div className="mt-3 p-3.5 rounded-xl bg-[var(--color-bg-input)]/50 border border-[var(--color-border-subtle)] space-y-2 animate-in fade-in duration-150 text-xs">
                    {/* 자동 로그인(아이디·비번) — 세션 만료마다 사람이 붙는 걸 없애는 자리. */}
                    <NaverCredentials
                      accountId={a.id}
                      label={a.label}
                      extraActions={
                        <>
                          {a.hasSession && (
                            <button
                              type="button"
                              style={{ boxShadow: "none" }}
                              onClick={() => handleClearSession(a)}
                              className="px-3 py-1 rounded-full bg-[var(--color-bg-input)] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/60 dark:hover:text-rose-400 dark:hover:border-rose-900 text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none transition-colors"
                            >
                              세션 삭제
                            </button>
                          )}
                          <button
                            type="button"
                            style={{ boxShadow: "none" }}
                            onClick={() => handleToggleDisabled(a)}
                            className="px-3 py-1 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none"
                          >
                            {a.status === "disabled" ? "사용" : "사용 중지"}
                          </button>
                        </>
                      }
                    />

                    {/* Login Guide Box — 편집자용 정상 경로. 세션이 이미 있으면 접어둔다. */}
                    {!a.hasSession && (
                      <div className="p-4 rounded-2xl bg-slate-100 dark:bg-stone-800/60 border-none space-y-3 shadow-none">
                        <p className="text-xs text-[#222222] dark:text-slate-200 leading-relaxed">
                          <span className="font-bold text-xs text-[#222222] dark:text-slate-200">로그인하는 법:</span> ① 아래 버튼으로 <span className="font-bold text-xs text-[#222222] dark:text-slate-200">로그인 도우미</span>를 내려받아 실행 → ② 뜨는 브라우저에서 STEP D 로그인 → ③ 네이버 로그인. 끝나면 세션이 자동으로 여기 등록됩니다. 아이디·비밀번호는 브라우저에만 들어가고 서버로 오지 않습니다.
                        </p>

                        <div>
                          {/* ⚠️ **계정별로 받아야 한다.** 파일명에 이 계정 키가 박혀 나가고, 도우미가
                              그걸 읽어 자동 선택한다 — 계정이 둘 이상일 때 도우미가 "어느 계정인가요?"
                              를 다시 묻지 않게 하는 유일한 연결고리다(잘못 고르면 세션이 남의 계정에
                              들어간다). account 를 빼면 그 옛 동작으로 돌아간다. */}
                          <a
                            style={{ boxShadow: "none" }}
                            href={`${process.env.NEXT_PUBLIC_API_URL ?? "/api"}/naver/login-tool?account=${encodeURIComponent(a.id)}`}
                            className="flex w-fit items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[#222222] dark:text-slate-200 font-bold border border-[var(--color-border-subtle)] cursor-pointer transition-colors shadow-none"
                          >
                            <Download className="w-4 h-4 text-[#1C60FF]" />
                            <span>&lsquo;{a.label}&rsquo; 로그인 도우미 다운로드 (Windows)</span>
                          </a>
                        </div>

                        <p className="text-xs text-[#222222] dark:text-slate-200">
                          받은 파일이 이 계정에 묶여 있습니다 — 도우미를 켜면{" "}
                          <span className="font-bold text-xs text-[#222222] dark:text-slate-200">계정: {a.label}</span> 로 바로 진행합니다.
                        </p>

                        {/* Developer Guide Accordion Matching Reference Image 2 */}
                        <div className="pt-0.5">
                          <button
                            type="button"
                            onClick={() => setDevOpen((p) => ({ ...p, [a.id]: !p[a.id] }))}
                            className="flex items-center gap-1.5 text-xs text-[#222222] dark:text-slate-200 font-medium hover:opacity-80 transition-opacity cursor-pointer"
                          >
                            <span>{devOpen[a.id] ? "▼" : "▶"}</span>
                            <span>개발자용 — 명령줄 / 세션 파일 등록</span>
                          </button>

                          {devOpen[a.id] && (
                            <div className="mt-3 space-y-2 animate-in fade-in duration-150">
                              <div className="bg-[#0B0F17] p-3.5 rounded-xl border border-stone-800/80 font-mono text-xs overflow-x-auto shadow-none">
                                <code className="text-slate-200 whitespace-nowrap">
                                  <span className="text-amber-500 font-bold">pnpm</span> --filter @stepd/server naver:login:upload -- --account {a.id} --api {cmdTargets().api} --web {cmdTargets().web}
                                </code>
                              </div>
                              <p className="text-xs text-[#222222] dark:text-slate-200 leading-normal">
                                또는 위 &quot;로그인 세션 등록&quot; 버튼으로 Playwright storageState JSON 을 직접 올립니다.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 원본 상태 알약(D:301). 톤만 갈랐다. */
function Pill({ label, tone }: { label: string; tone: "ok" | "warn" | "idle" }) {
  const cls =
    tone === "ok"
      ? "bg-[#ECFDF5] text-[#059669] dark:bg-emerald-500/20 dark:text-emerald-400"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400"
        : "bg-slate-200/80 text-slate-600 dark:bg-[#282B35] dark:text-slate-300";
  const dot =
    tone === "ok" ? "bg-[#059669] dark:bg-emerald-400"
      : tone === "warn" ? "bg-amber-500 dark:bg-amber-400"
        : "bg-slate-400 dark:bg-slate-500";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border-none ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
      {label}
    </span>
  );
}