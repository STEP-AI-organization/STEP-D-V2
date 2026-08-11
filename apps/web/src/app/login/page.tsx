"use client";

/**
 * 로그인.
 *
 * 서버 API 는 병렬 세션이 만들어 뒀는데 화면이 없어서, `AUTH_REQUIRED=1` 을 켜면
 * **아무도 못 들어오는 상태**였다. 그걸 연다.
 *
 * 계정 열거를 막는 게 서버 쪽 설계다(없는 이메일에도 더미 해시 대조로 같은 시간을 쓴다).
 * 화면도 같은 태도를 지킨다 — "없는 계정입니다"와 "비밀번호가 틀렸습니다"를 **구분하지 않는다.**
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { login } from "@/lib/data/api";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      // replace 로 보낸다 — 뒤로가기로 로그인 화면에 돌아오면 이미 로그인된 채라 혼란스럽다.
      router.replace(next.startsWith("/") ? next : "/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="grid min-h-screen place-items-center p-6"
      style={{ background: "var(--sd-app-bg)" }}
    >
      <form onSubmit={submit} className="sd-card w-full max-w-[360px] p-6">
        <div className="mb-4 flex items-center gap-2">
          <span
            className="grid size-[22px] place-items-center rounded-[4px] text-[12px] font-bold text-white"
            style={{ background: "var(--sd-accent)" }}
            aria-hidden
          >
            D
          </span>
          <span className="sd-serif text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            STEP-D
          </span>
        </div>

        <label className="mb-2 block">
          <span className="mb-1 block text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            이메일
          </span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="sd-input w-full"
            required
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>
            비밀번호
          </span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="sd-input w-full"
            required
          />
        </label>

        {error && (
          <p
            className="mb-3 rounded-[4px] px-2.5 py-2 text-[11.5px]"
            style={{
              border: "1px solid var(--sd-danger-border)",
              background: "var(--sd-danger-bg)",
              color: "var(--sd-danger-strong)",
            }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          className="sd-btn sd-btn-primary w-full"
          disabled={busy || !email.trim() || !password}
        >
          {busy ? "확인 중…" : "로그인"}
        </button>

        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--sd-mut)" }}>
          계정은 초대로만 만들어집니다. 초대 메일의 링크로 들어오면 비밀번호를 정할 수 있습니다.
        </p>
      </form>
    </div>
  );
}
