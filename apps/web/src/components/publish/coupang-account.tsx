"use client";

/**
 * 쿠팡파트너스 연결 — 배포채널 화면의 한 섹션.
 *
 * 네이버와 같은 성격이다. 쿠팡파트너스도 **공개 API 가 최종승인(누적 판매 15만원) 후에야**
 * 나와서, 그 전까지는 사람이 한 번 로그인해 만든 세션으로 워커가 대신 링크를 발급한다.
 * 그래서 OAuth 버튼이 없고, 이 화면이 하는 일은 "연결됐나 / 어떻게 연결하나" 둘뿐이다.
 *
 * ## 왜 이 화면이 필요한가
 *
 * 이게 없으면 **워크스페이스마다 연결됐는지 안 됐는지 알 방법이 없었다.** 커미션은 등록된
 * 계정으로 정산되므로 "이 회사가 연결돼 있나" 는 돈과 직결된 질문인데, 답을 볼 곳이 없었다.
 *
 * ## 계정은 워크스페이스당 하나다
 *
 * 네이버는 채널마다 계정을 여럿 두지만 쿠팡은 하나다 — **커미션 정산이 계정 단위**라,
 * 여러 개를 두고 고르게 하면 "어느 계정으로 나갔나" 를 사람이 매번 판단해야 한다.
 * 그건 수익 귀속 문제라 실수하면 안 되는 자리다.
 *
 * ⚠️ 세션 쿠키는 그 계정의 전체 권한이다(2차인증까지 통과된 상태). 네이버와 같은 자세 —
 * 파일은 읽어서 **바로 서버로만** 보내고 화면 state 에 담지 않는다. 서버는 봉인해 저장하고
 * 다시는 돌려주지 않는다. 키가 없으면 서버가 저장을 거부하므로 버튼을 미리 막는다.
 */

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import {
  fetchCommerceAccount,
  saveCommerceAccount,
  uploadCommerceSession,
  clearCommerceSession,
  type CommerceAccount,
} from "@/lib/data/api";

/** 명령에 넣어줄 주소 — 운영자가 "--api 에 뭘 쓰죠?" 를 묻지 않게 화면이 채워 준다. */
function cmdTargets(): { api: string; web: string } {
  if (typeof window === "undefined") return { api: "<서버주소>", web: "<웹주소>" };
  const origin = window.location.origin;
  const base = process.env.NEXT_PUBLIC_API_URL ?? "";
  if (base.startsWith("http")) return { api: base.replace(/\/api$/, ""), web: origin };
  return { api: `${origin}${base.replace(/\/api$/, "")}`, web: origin };
}

/** 원본 알약 버튼 (publish-channels D:544·550·264). */
const BTN = "px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_DEL = "px-3 py-1.5 rounded-full bg-[var(--color-bg-card)] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/60 dark:hover:text-rose-400 dark:hover:border-rose-900 text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer transition-colors shadow-none";
const BTN_PRIMARY = "px-3.5 py-2 rounded-full bg-[#222222] hover:bg-black text-white dark:bg-stone-700 dark:hover:bg-stone-600 text-xs font-bold transition-colors cursor-pointer shadow-none border-none disabled:opacity-50 disabled:cursor-not-allowed";

function when(ts: number | null): string {
  if (!ts) return "";
  return new Date(Number(ts)).toLocaleString("ko-KR", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function CoupangAccount() {
  const [account, setAccount] = useState<CommerceAccount | null>(null);
  // null = 아직 모름(못 읽음). "안 된다" 고 단정하지 않는다.
  const [keyReady, setKeyReady] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetchCommerceAccount();
      setAccount(r.account);
      setKeyReady(r.sessionKeyReady);
      setEnabled(r.enabled);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    const name = label.trim();
    if (!name) return;
    setBusy("add");
    try {
      await saveCommerceAccount(name);
      setLabel(""); setAdding(false);
      setMsg(`'${name}' 등록됨 — 아래에서 로그인하면 링크 발급이 시작됩니다.`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  /** 세션 파일은 **읽어서 곧장 전송**하고 상태에 담지 않는다(devtools·에러리포트로 샌다). */
  const handleSession = async (file: File) => {
    setBusy("session");
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("JSON 파일이 아닙니다 — 로그인 세션(storageState) 파일을 선택하세요.");
      }
      await uploadCommerceSession(parsed);
      setMsg("로그인 세션이 등록됐습니다. 이제 이 워크스페이스의 링크가 이 계정으로 발급됩니다.");
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const handleClear = async () => {
    if (!confirm("로그인 세션을 삭제할까요? 계정 설정은 남고, 새 링크 발급만 멈춥니다.")) return;
    setBusy("clear");
    try {
      await clearCommerceSession();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const [devOpen, setDevOpen] = useState(false);
  const hasSession = !!account?.sessionUpdatedAt && account.status !== "session_expired";
  const cmd = cmdTargets();

  return (
    <div id="coupang-account" className="space-y-3 scroll-mt-24">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-[var(--color-text-primary)]">
          쿠팡파트너스 연동 <span className="text-[11px] text-[var(--color-text-muted)] font-normal">(영상 속 상품 링크 — 공개 API 가 최종승인 후에야 나와 로그인 세션으로 발급합니다)</span>
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
      {keyReady === false && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400 font-medium leading-relaxed">
          서버에 세션 암호화 키(COMMERCE_SESSION_KEY)가 없어 로그인 세션을 등록할 수 없습니다.
          평문으로 저장하지 않으므로, 키를 설정하기 전까지 등록 버튼은 막혀 있습니다.
        </div>
      )}
      {enabled === false && (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-700 dark:text-amber-400 font-medium leading-relaxed">
          상품 링크 기능이 꺼져 있습니다 — 연결해 두어도 발행 설명란에는 반영되지 않습니다.
        </div>
      )}

      {loading ? (
        <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-6 shadow-md shadow-slate-900/5 dark:shadow-none text-xs text-center text-[var(--color-text-muted)]">
          불러오는 중…
        </div>
      ) : !account ? (
        /* 미등록 — 원본에는 이 상태가 없다(항상 연결된 1행). 네이버의 액션 배너 구조를 그대로 쓴다. */
        <div className="bg-[var(--color-bg-card)] border-none p-3.5 rounded-2xl flex items-center justify-between text-xs shadow-md shadow-slate-900/5 dark:shadow-none">
          {adding ? (
            <div className="flex flex-wrap items-end gap-3 w-full">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--color-text-muted)] font-medium">계정 이름 (우리가 알아볼 이름)</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="예: ENA 법인"
                  autoFocus
                  className="w-64 h-9 px-4 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none"
                />
              </label>
              <button type="button" style={{ boxShadow: "none" }} onClick={handleAdd} disabled={!label.trim() || busy === "add"} className={BTN_PRIMARY}>
                {busy === "add" ? "등록 중…" : "등록"}
              </button>
              <button type="button" style={{ boxShadow: "none" }} onClick={() => { setAdding(false); setLabel(""); }} className={BTN}>
                취소
              </button>
            </div>
          ) : (
            <>
              <span className="text-xs text-[var(--color-text-muted)]">
                <b className="text-[var(--color-text-primary)]">연결된 계정이 없습니다.</b> 커미션은{" "}
                <b className="text-[var(--color-text-primary)]">등록된 계정으로 정산</b>되므로, 이 회사 법인 명의의
                파트너스 계정을 연결해야 링크가 발급됩니다. 아이디·비밀번호는 받지 않습니다 — 로그인은 브라우저에서 직접 합니다.
              </span>
              <button type="button" style={{ boxShadow: "none" }} onClick={() => setAdding(true)} className={`${BTN_PRIMARY} shrink-0 ml-4`}>
                + 쿠팡파트너스 연결
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="bg-[var(--color-bg-card)] border-none rounded-2xl p-4 shadow-md shadow-slate-900/5 dark:shadow-none divide-y divide-[var(--color-border-subtle)]/60 text-xs">
          {/* List Header */}
          <div className="hidden sm:grid grid-cols-[38%_16%_22%_24%] items-center text-[11px] font-bold text-[var(--color-text-muted)] pb-2.5 px-3">
            <div className="text-left">계정 정보</div>
            <div className="text-center">상태</div>
            <div className="text-center">등록일시</div>
            <div className="text-right">관리</div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[38%_16%_22%_24%] items-center gap-2 sm:gap-0 px-3 py-2.5">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-8 h-8 rounded-full bg-rose-600 text-white font-extrabold flex items-center justify-center text-[9px] p-1 text-center leading-none shrink-0">
                coupang
              </div>
              <div className="min-w-0">
                <h4 className="font-bold text-sm text-[var(--color-text-primary)] truncate">{account.label}</h4>
                <p className="text-[11px] text-[var(--color-text-muted)] truncate">쿠팡파트너스 연동</p>
              </div>
            </div>

            <div className="hidden sm:flex items-center justify-center text-center">
              {/* 상태는 "세션이 있는가" 가 먼저다 — 세션 없이 연결됐다고 하면 거짓말이다. */}
              {account.status === "disabled" ? (
                <Pill tone="idle" label="비활성" />
              ) : hasSession ? (
                <Pill tone="ok" label="연결됨" />
              ) : account.status === "session_expired" && account.sessionUpdatedAt ? (
                <Pill tone="warn" label="로그인 만료" />
              ) : (
                <Pill tone="warn" label="로그인 필요" />
              )}
            </div>

            <div className="hidden sm:flex items-center justify-center text-center text-[11px] text-[var(--color-text-muted)] font-mono truncate">
              {account.sessionUpdatedAt ? `${when(account.sessionUpdatedAt)} 등록` : "세션 없음"}
              {account.lastIssuedAt ? ` · ${when(account.lastIssuedAt)} 발급` : ""}
            </div>

            <div className="flex items-center justify-end gap-1.5 shrink-0">
              {/* 세션 파일 등록은 label 이어야 한다 — 안에 감춘 file input 을 여는 유일한 방법. */}
              <label
                className={`px-3 py-1.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium shadow-none ${
                  keyReady === false || busy === "session" ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                }`}
                title="로그인한 브라우저에서 내보낸 세션(storageState) JSON 파일"
              >
                {busy === "session" ? "등록 중…" : hasSession ? "세션 갱신" : "로그인 세션 등록"}
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  disabled={keyReady === false || busy === "session"}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";   // 같은 파일을 다시 골라도 change 가 나게
                    if (f) void handleSession(f);
                  }}
                />
              </label>

              {account.sessionUpdatedAt && (
                <button type="button" style={{ boxShadow: "none" }} onClick={handleClear} className={BTN_DEL}>
                  세션 삭제
                </button>
              )}
            </div>
          </div>

          {/* 로그인이 필요한 상태에서만 방법을 펼쳐 둔다 — 네이버 가이드 박스와 같은 구조. */}
          {!hasSession && (
            <div className="px-3 pt-3">
              <div className="p-4 rounded-2xl bg-slate-100 dark:bg-stone-800/60 border-none space-y-3 shadow-none">
                <p className="text-xs text-[#222222] dark:text-slate-200 leading-relaxed">
                  <span className="font-bold text-xs text-[#222222] dark:text-slate-200">로그인하는 법:</span> ① 아래 버튼으로 <span className="font-bold text-xs text-[#222222] dark:text-slate-200">로그인 도우미</span>를 내려받아 실행 → ② 뜨는 브라우저에서 STEP D 로그인 → ③ 쿠팡파트너스 로그인. 끝나면 세션이 자동으로 여기 등록됩니다. 아이디·비밀번호는 브라우저에만 들어가고 서버로 오지 않습니다.
                </p>

                <div>
                  <a
                    style={{ boxShadow: "none" }}
                    href={`${process.env.NEXT_PUBLIC_API_URL ?? "/api"}/commerce/login-tool`}
                    className="flex w-fit items-center gap-2 px-4 py-2.5 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[#222222] dark:text-slate-200 font-bold border border-[var(--color-border-subtle)] cursor-pointer transition-colors shadow-none"
                  >
                    <Download className="w-4 h-4 text-[#1C60FF]" />
                    <span>쿠팡 로그인 도우미 다운로드 (Windows)</span>
                  </a>
                </div>

                <p className="text-xs text-[#222222] dark:text-slate-200 leading-relaxed">
                  ⚠️ 여기서 로그인한 계정으로 <span className="font-bold text-xs text-[#222222] dark:text-slate-200">커미션이 정산</span>됩니다 — 이 회사 법인 계정이 맞는지 확인하세요.
                </p>

                <div className="pt-0.5">
                  <button
                    type="button"
                    onClick={() => setDevOpen((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-[#222222] dark:text-slate-200 font-medium hover:opacity-80 transition-opacity cursor-pointer"
                  >
                    <span>{devOpen ? "▼" : "▶"}</span>
                    <span>개발자용 — 명령줄 / 세션 파일 등록</span>
                  </button>

                  {devOpen && (
                    <div className="mt-3 space-y-2 animate-in fade-in duration-150">
                      <div className="bg-[#0B0F17] p-3.5 rounded-xl border border-stone-800/80 font-mono text-xs overflow-x-auto shadow-none">
                        <code className="text-slate-200 whitespace-nowrap">
                          <span className="text-amber-500 font-bold">pnpm</span> --filter @stepd/server commerce:login -- --api {cmd.api} --web {cmd.web} --label &quot;{account.label}&quot;
                        </code>
                      </div>
                      <p className="text-xs text-[#222222] dark:text-slate-200 leading-normal">
                        또는 위 &quot;로그인 세션 등록&quot; 버튼으로 Playwright storageState JSON 을 직접 올립니다.
                        ⚠️ 화면이 있는 PC 여야 합니다 — 쿠팡은 창 없는 브라우저(headless)를 차단합니다.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 원본 상태 알약(publish-channels D:533). 톤만 갈랐다. */
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
