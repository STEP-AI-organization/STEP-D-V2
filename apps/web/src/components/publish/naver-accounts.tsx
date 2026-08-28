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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
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
    <section id="naver-accounts" className="mb-10 scroll-mt-24">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">네이버 연결 계정</h2>
        <span className="text-[11px] text-muted-foreground/70">
          (네이버 클립 — 공개 업로드 API 가 없어 로그인 세션으로 발행합니다)
        </span>
      </div>

      {msg && (
        <div className="mb-3 rounded-md border border-border bg-muted px-4 py-3 text-sm text-foreground">
          {msg}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-md border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          {err}
        </div>
      )}
      {storeReady === false && (
        <div className="mb-3 rounded-md border border-status-warn/40 bg-status-warn/10 px-4 py-3 text-sm text-status-warn">
          서버에 세션 암호화 키(NAVER_SESSION_KEY)가 없어 로그인 세션을 등록할 수 없습니다.
          평문으로 저장하지 않으므로, 키를 설정하기 전까지 등록 버튼은 막혀 있습니다.
        </div>
      )}

      <Card className="mb-3 p-4">
        {adding ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">계정 이름 (우리가 알아볼 이름)</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="예: JTBC 공식 채널"
                autoFocus
                className="w-64 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">쓸 곳</span>
              {/* 네이버 TV 는 제품에서 제외 (2026-08-13) — 새 계정은 클립 전용으로만 만든다.
                  기존 tv·both 계정은 데이터에 남아 있고 라벨 표시는 유지된다. */}
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value as NaverAccount["target"])}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
              >
                <option value="clip">네이버 클립 전용</option>
              </select>
            </label>
            <Button size="sm" onClick={handleAdd} disabled={!label.trim() || busy === "add"}>
              {busy === "add" ? "추가 중…" : "추가"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setAdding(false); setLabel(""); }}>
              취소
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              고객사 채널마다 계정을 하나씩 등록합니다. 네이버 아이디·비밀번호는 받지 않습니다 —
              로그인은 브라우저에서 직접 하고, 그 결과 세션만 등록합니다.
            </div>
            <Button size="sm" onClick={() => setAdding(true)}>+ 네이버 계정 추가</Button>
          </div>
        )}
      </Card>

      {loading ? (
        <div className="text-sm text-muted-foreground">불러오는 중...</div>
      ) : accounts.length === 0 ? (
        <Card className="p-6">
          <div className="text-sm text-muted-foreground">
            등록된 네이버 계정이 없습니다. 위 &quot;+ 네이버 계정 추가&quot; 로 시작하세요.
          </div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {accounts.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <img
                    src="/channel-icons/naver.png"
                    alt="네이버"
                    className="size-10 rounded-full"
                    draggable={false}
                  />
                  <div>
                    <div className="text-sm font-medium text-foreground">{a.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {TARGET_LABEL[a.target]}
                      {a.sessionUpdatedAt ? ` · ${when(a.sessionUpdatedAt)} 로그인 등록` : ""}
                      {a.lastPublishAt ? ` · ${when(a.lastPublishAt)} 발행` : ""}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* 상태는 "세션이 있는가"가 먼저다 — 세션 없이 활성이라고 하면 거짓말이다. */}
                  {a.status === "disabled" ? (
                    <StatusBadge tone="idle">비활성</StatusBadge>
                  ) : a.hasSession ? (
                    <StatusBadge tone="done">로그인됨</StatusBadge>
                  ) : (
                    <StatusBadge tone="warn">로그인 필요</StatusBadge>
                  )}

                  <label
                    className={`rounded-md border border-border px-2 py-1 text-xs text-foreground transition ${
                      storeReady === false || busy === a.id
                        ? "cursor-not-allowed opacity-70"
                        : "cursor-pointer hover:bg-accent/40"
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

                  {a.hasSession && (
                    <button
                      onClick={() => handleClearSession(a)}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                    >
                      세션 삭제
                    </button>
                  )}
                  <button
                    onClick={() => handleToggleDisabled(a)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    {a.status === "disabled" ? "사용" : "사용 중지"}
                  </button>
                  <button
                    onClick={() => handleDelete(a)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:text-status-error"
                  >
                    삭제
                  </button>
                </div>
              </div>

              {/* 자동 로그인(아이디·비번) — 세션 만료마다 사람이 붙는 걸 없애는 자리. */}
              <NaverCredentials accountId={a.id} label={a.label} />

              {/* 편집자용 정상 경로 — 로그인 도우미 다운로드 (pnpm·리포 불필요, 더블클릭).
                  세션이 이미 있으면 접어둔다. */}
              {!a.hasSession && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    <b className="text-foreground">로그인하는 법.</b>{" "}
                    ① 아래 버튼으로 <b className="text-foreground">로그인 도우미</b>를 내려받아 실행
                    → ② 뜨는 브라우저에서 STEP D 로그인 → ③ 네이버 로그인. 끝나면 세션이 자동으로
                    여기 등록됩니다. 아이디·비밀번호는 브라우저에만 들어가고 서버로 오지 않습니다.
                  </p>
                  {/* ⚠️ **계정별로 받아야 한다.** 파일명에 이 계정 키가 박혀 나가고, 도우미가
                      그걸 읽어 자동 선택한다 — 계정이 둘 이상일 때 도우미가 "어느 계정인가요?"
                      를 다시 묻지 않게 하는 유일한 연결고리다(잘못 고르면 세션이 남의 계정에
                      들어간다). account 를 빼면 그 옛 동작으로 돌아간다. */}
                  <a
                    href={`${process.env.NEXT_PUBLIC_API_URL ?? "/api"}/naver/login-tool?account=${encodeURIComponent(a.id)}`}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-accent/40"
                  >
                    ⬇ &lsquo;{a.label}&rsquo; 로그인 도우미 다운로드 (Windows)
                  </a>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    받은 파일이 이 계정에 묶여 있습니다 — 도우미를 켜면{" "}
                    <b className="text-foreground">계정: {a.label}</b> 로 바로 진행합니다.
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">
                      개발자용 — 명령줄 / 세션 파일 등록
                    </summary>
                    <code className="mt-1.5 block overflow-x-auto rounded-md bg-muted px-2.5 py-2 text-[11px] text-foreground">
                      pnpm --filter @stepd/server naver:login:upload -- --account {a.id}{" "}
                      --api {cmdTargets().api} --web {cmdTargets().web}
                    </code>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      또는 위 &quot;로그인 세션 등록&quot; 버튼으로 Playwright storageState JSON 을 직접 올립니다.
                    </p>
                  </details>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
