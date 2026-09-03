"use client";

/**
 * 네이버 자동 로그인 설정 — 계정 카드 안의 한 블록.
 *
 * ## 왜 있는가
 * 네이버 세션은 만료된다(실측 2026-08-28: 9일 된 세션이 죽어 있었고, 그동안 화면은
 * "로그인됨" 이라고 말했다 — 발행이 실패해야만 상태가 바뀌기 때문). 만료마다 사람이
 * 브라우저를 여는 게 부담이라, 아이디·비번을 한 번 저장해 두면 **워커가 스스로 되살린다.**
 *
 * ## 취급
 *  - 입력값은 **보내고 즉시 지운다.** state 에 남기지 않는다(devtools·에러리포트로 샌다).
 *  - 서버는 세션과 **다른 키**로 봉인하고 값을 절대 돌려주지 않는다 — 여기서 볼 수 있는 건
 *    "있다/없다 + 검증상태" 뿐이다.
 *  - 저장은 곧 검증이다: 워커가 실제로 로그인해 보고 **틀리면 지운다**(틀린 비번으로 반복
 *    시도하면 계정이 잠긴다).
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  fetchNaverCredentialState,
  saveNaverCredentials,
  clearNaverCredentials,
  reloginNaverAccount,
  type NaverCredentialState,
} from "@/lib/data/api";

function when(ts: number | null): string {
  if (!ts) return "";
  return new Date(Number(ts)).toLocaleString("ko-KR", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** 원본 드로어의 알약 버튼들 (publish-channels/page.tsx D:348·362). */
const BTN = "px-3 py-1 rounded-full bg-[var(--color-bg-input)] hover:bg-[var(--color-bg-card-hover)] text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_ALT = "px-3.5 py-1 rounded-full bg-[var(--color-bg-card)] border border-[var(--color-border-subtle)] text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-bg-card-hover)] font-medium cursor-pointer shadow-none disabled:opacity-50 disabled:cursor-not-allowed";

export function NaverCredentials({
  accountId,
  label,
  extraActions,
}: {
  accountId: string;
  label: string;
  /** 계정 카드가 같은 줄에 얹는 버튼(세션 삭제·사용 중지) — 원본 드로어가 한 줄에 모은다. */
  extraActions?: ReactNode;
}) {
  const [state, setState] = useState<NaverCredentialState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");

  const load = useCallback(async () => {
    try { setState(await fetchNaverCredentialState(accountId)); }
    catch { /* 계정 카드가 이미 오류를 보여준다 */ }
  }, [accountId]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!id.trim() || !pw) return;
    setBusy("save"); setErr(null); setMsg(null);
    try {
      const r = await saveNaverCredentials(accountId, id.trim(), pw);
      // ⚠️ 보내자마자 비운다 — 화면 어디에도 남기지 않는다.
      setId(""); setPw(""); setOpen(false);
      setMsg(`${r.maskedId} 저장됨 — 워커가 실제로 로그인해 확인합니다 (잠시 뒤 새로고침).`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };

  const drop = async () => {
    if (!confirm(`'${label}' 의 저장된 아이디·비밀번호를 지울까요?\n\n세션은 남아 발행은 계속되지만, 만료되면 자동 복구가 안 됩니다.`)) return;
    setBusy("clear");
    try { await clearNaverCredentials(accountId); setMsg("자격증명을 지웠습니다."); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const relogin = async () => {
    setBusy("relogin"); setErr(null);
    try { await reloginNaverAccount(accountId); setMsg("다시 로그인 요청됨 — 잠시 뒤 새로고침하세요."); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  /** 원본 배지(D:343)는 회색 하나뿐이다 — 상태 4종으로 톤만 갈랐다. */
  const badge = () => {
    const [text, cls] = !state?.hasCred
      ? ["자동 로그인 꺼짐", "bg-slate-200/70 text-slate-600 dark:bg-stone-700 dark:text-stone-300"]
      : state.status === "verified"
        ? ["자동 로그인 켜짐", "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400"]
        : state.status === "failed"
          ? ["자동 로그인 실패", "bg-rose-500/15 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400"]
          : ["확인 중", "bg-[#1C60FF]/10 text-[#1C60FF] dark:text-[#60A5FA]"];
    return <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${cls}`}>{text}</span>;
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-xs text-[var(--color-text-primary)]">자동 로그인</span>
          {badge()}
          {state?.hasCred && state.reloginAt && (
            <span className="text-[11px] text-[var(--color-text-muted)]">{when(state.reloginAt)} 갱신</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {extraActions}
          {state?.hasCred && state.status === "verified" && (
            <button type="button" style={{ boxShadow: "none" }} disabled={busy === "relogin"} onClick={() => void relogin()} className={BTN}>
              {busy === "relogin" ? "요청 중…" : "지금 다시 로그인"}
            </button>
          )}
          <button
            type="button"
            style={{ boxShadow: "none" }}
            disabled={state?.credKeyReady === false}
            onClick={() => setOpen((v) => !v)}
            className={BTN_ALT}
          >
            {state?.hasCred ? "아이디·비번 변경" : "아이디·비번 저장"}
          </button>
          {state?.hasCred && (
            <button
              type="button"
              style={{ boxShadow: "none" }}
              onClick={() => void drop()}
              disabled={busy === "clear"}
              className="px-3 py-1 rounded-full bg-[var(--color-bg-input)] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 dark:hover:bg-rose-950/60 dark:hover:text-rose-400 dark:hover:border-rose-900 text-xs text-[var(--color-text-primary)] border border-[var(--color-border-subtle)] font-medium cursor-pointer shadow-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              지우기
            </button>
          )}
        </div>
      </div>

      {state?.credKeyReady === false && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
          서버에 자격증명 암호화 키(NAVER_CRED_KEY)가 없어 저장할 수 없습니다 (평문 저장은 하지 않습니다).
        </p>
      )}
      {state?.status === "failed" && state.error && (
        <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">{state.error}</p>
      )}
      {msg && <p className="text-[11px] text-[var(--color-text-muted)]">{msg}</p>}
      {err && <p className="text-[11px] text-rose-600 dark:text-rose-400 font-medium">{err}</p>}

      {open && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--color-text-muted)]">네이버 아이디 ({label})</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              className="w-44 h-8 px-3 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10.5px] text-[var(--color-text-muted)]">비밀번호</span>
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
              className="w-44 h-8 px-3 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] focus:border-[#1C60FF] text-xs text-[var(--color-text-primary)] focus:outline-none"
            />
          </label>
          <button type="button" style={{ boxShadow: "none" }} disabled={!id.trim() || !pw || busy === "save"} onClick={() => void save()} className={BTN_ALT}>
            {busy === "save" ? "저장 중…" : "저장하고 로그인 확인"}
          </button>
          <button type="button" style={{ boxShadow: "none" }} onClick={() => { setOpen(false); setId(""); setPw(""); }} className={BTN}>
            취소
          </button>
        </div>
      )}

      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
        저장해 두면 세션이 만료돼도 <b className="text-[var(--color-text-primary)]">워커가 스스로 다시 로그인</b>합니다.
        값은 서버에서 암호화되어 다시 조회되지 않고, 로그인에 실패하면 자동으로 삭제됩니다.
        2차인증이 걸린 계정은 자동 로그인이 안 되니 도우미로 한 번 로그인하세요.
      </p>
    </div>
  );
}
