"use client";

/**
 * 초대 수락 — 비밀번호를 정하고 바로 로그인된다.
 *
 * 계정은 초대로만 생긴다(가입 폼이 없다). 토큰이 없거나 만료면 **왜 안 되는지** 말한다 —
 * "실패했습니다"만 띄우면 초대한 쪽에 다시 물어볼 수도 없다.
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { acceptInvite } from "@/lib/data/api";

export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <InviteInner />
    </Suspense>
  );
}

function InviteInner() {
  const token = useSearchParams().get("token") ?? "";

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = Boolean(token) && Boolean(password) && !mismatch && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token, { password, name: name.trim() || undefined });
      // 로그인과 같은 이유로 전체 리로드 (SessionProvider 재실행).
      window.location.assign("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center p-6" style={{ background: "var(--sd-app-bg)" }}>
      <form onSubmit={submit} className="sd-card w-full max-w-[360px] p-6">
        <h1 className="sd-serif mb-1 text-[16px] font-semibold" style={{ color: "var(--sd-fg)" }}>
          초대 수락
        </h1>
        <p className="mb-4 text-[11.5px]" style={{ color: "var(--sd-mut)" }}>
          비밀번호를 정하면 바로 시작합니다.
        </p>

        {!token && (
          <p
            className="mb-3 rounded-[4px] px-2.5 py-2 text-[11.5px]"
            style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
          >
            초대 토큰이 없습니다 — 초대 메일의 링크를 그대로 열어야 합니다.
          </p>
        )}

        <label className="mb-2 block">
          <span className="mb-1 block text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>이름 (선택)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="sd-input w-full" autoComplete="name" />
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>비밀번호</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="sd-input w-full"
            required
          />
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-[11.5px] font-semibold" style={{ color: "var(--sd-fg)" }}>비밀번호 확인</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="sd-input w-full"
            required
          />
          {mismatch && (
            <span className="mt-1 block text-[10.5px]" style={{ color: "var(--sd-danger-strong)" }}>
              두 번 입력한 비밀번호가 다릅니다
            </span>
          )}
        </label>

        {error && (
          <p
            className="mb-3 rounded-[4px] px-2.5 py-2 text-[11.5px]"
            style={{ border: "1px solid var(--sd-danger-border)", background: "var(--sd-danger-bg)", color: "var(--sd-danger-strong)" }}
          >
            {error}
          </p>
        )}

        <button type="submit" className="sd-btn sd-btn-primary w-full" disabled={!canSubmit}>
          {busy ? "처리 중…" : "시작하기"}
        </button>
      </form>
    </div>
  );
}
