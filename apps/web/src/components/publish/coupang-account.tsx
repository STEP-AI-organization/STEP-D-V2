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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
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

  const hasSession = !!account?.sessionUpdatedAt && account.status !== "session_expired";
  const cmd = cmdTargets();

  return (
    <section id="coupang-account" className="mb-10 scroll-mt-24">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">쿠팡파트너스 연결</h2>
        <span className="text-[11px] text-muted-foreground/70">
          (영상 속 상품 링크 — 공개 API 가 최종승인 후에야 나와 로그인 세션으로 발급합니다)
        </span>
      </div>

      {msg && (
        <div className="mb-3 rounded-md border border-border bg-muted px-4 py-3 text-sm text-foreground">{msg}</div>
      )}
      {err && (
        <div className="mb-3 rounded-md border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm text-status-error">{err}</div>
      )}
      {keyReady === false && (
        <div className="mb-3 rounded-md border border-status-warn/40 bg-status-warn/10 px-4 py-3 text-sm text-status-warn">
          서버에 세션 암호화 키(COMMERCE_SESSION_KEY)가 없어 로그인 세션을 등록할 수 없습니다.
          평문으로 저장하지 않으므로, 키를 설정하기 전까지 등록 버튼은 막혀 있습니다.
        </div>
      )}
      {enabled === false && (
        <div className="mb-3 rounded-md border border-status-warn/40 bg-status-warn/10 px-4 py-3 text-sm text-status-warn">
          상품 링크 기능이 꺼져 있습니다 — 연결해 두어도 발행 설명란에는 반영되지 않습니다.
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">불러오는 중...</div>
      ) : !account ? (
        <Card className="p-4">
          {adding ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">계정 이름 (우리가 알아볼 이름)</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="예: ENA 법인"
                  autoFocus
                  className="w-64 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
                />
              </label>
              <Button size="sm" onClick={handleAdd} disabled={!label.trim() || busy === "add"}>
                {busy === "add" ? "등록 중…" : "등록"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setAdding(false); setLabel(""); }}>취소</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                <b className="text-foreground">연결된 계정이 없습니다.</b> 커미션은{" "}
                <b className="text-foreground">등록된 계정으로 정산</b>되므로, 이 회사 법인 명의의
                파트너스 계정을 연결해야 링크가 발급됩니다. 아이디·비밀번호는 받지 않습니다 —
                로그인은 브라우저에서 직접 합니다.
              </div>
              <Button size="sm" onClick={() => setAdding(true)}>+ 쿠팡파트너스 연결</Button>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <img
                src="https://www.google.com/s2/favicons?domain=coupang.com&sz=64"
                alt="쿠팡"
                className="size-10 rounded-full bg-muted"
                draggable={false}
              />
              <div>
                <div className="text-sm font-medium text-foreground">{account.label}</div>
                <div className="text-xs text-muted-foreground">
                  쿠팡파트너스
                  {account.sessionUpdatedAt ? ` · ${when(account.sessionUpdatedAt)} 로그인 등록` : ""}
                  {account.lastIssuedAt ? ` · ${when(account.lastIssuedAt)} 발급` : ""}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* 상태는 "세션이 있는가" 가 먼저다 — 세션 없이 연결됐다고 하면 거짓말이다. */}
              {account.status === "disabled" ? (
                <StatusBadge tone="idle">비활성</StatusBadge>
              ) : hasSession ? (
                <StatusBadge tone="done">연결됨</StatusBadge>
              ) : account.status === "session_expired" && account.sessionUpdatedAt ? (
                <StatusBadge tone="warn">로그인 만료</StatusBadge>
              ) : (
                <StatusBadge tone="warn">로그인 필요</StatusBadge>
              )}

              <label
                className={`rounded-md border border-border px-2 py-1 text-xs text-foreground transition ${
                  keyReady === false || busy === "session"
                    ? "cursor-not-allowed opacity-70"
                    : "cursor-pointer hover:bg-accent/40"
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
                <button
                  onClick={handleClear}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  세션 삭제
                </button>
              )}
            </div>
          </div>

          {/* 로그인이 필요한 상태에서만 방법을 펼쳐 둔다. */}
          {!hasSession && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                <b className="text-foreground">로그인하는 법.</b> ① 아래 버튼으로{" "}
                <b className="text-foreground">로그인 도우미</b>를 내려받아 실행 → ② 뜨는
                브라우저에서 STEP D 로그인 → ③ 쿠팡파트너스 로그인. 끝나면 세션이 자동으로 여기
                등록됩니다. 아이디·비밀번호는 브라우저에만 들어가고 서버로 오지 않습니다.
              </p>
              <a
                href={`${process.env.NEXT_PUBLIC_API_URL ?? "/api"}/commerce/login-tool`}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent/40"
              >
                ⬇ 쿠팡 로그인 도우미 다운로드 (Windows)
              </a>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                ⚠️ 여기서 로그인한 계정으로 <b className="text-foreground">커미션이 정산</b>됩니다 —
                이 회사 법인 계정이 맞는지 확인하세요.
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                  개발자용 — 명령줄 / 세션 파일 등록
                </summary>
                <code className="mt-1.5 block overflow-x-auto rounded-md bg-muted px-2.5 py-2 text-[11px] text-foreground">
                  pnpm --filter @stepd/server commerce:login -- --api {cmd.api} --web {cmd.web} --label &quot;{account.label}&quot;
                </code>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  또는 위 &quot;로그인 세션 등록&quot; 버튼으로 Playwright storageState JSON 을 직접 올립니다.
                  ⚠️ 화면이 있는 PC 여야 합니다 — 쿠팡은 창 없는 브라우저(headless)를 차단합니다.
                </p>
              </details>
            </div>
          )}
        </Card>
      )}
    </section>
  );
}
