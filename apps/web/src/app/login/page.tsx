"use client";

/**
 * 로그인 — **디자이너 산출물 이식 1호** (2026-09-03).
 *
 * 원본: `STEPD_SaaS_UI_V1/src/app/page.tsx` (디자이너는 로그인을 루트 `/` 에 뒀다).
 * 우리는 `/login` 이 정본 경로다 — `(app)/page.tsx` 는 리다이렉트라 자리를 못 내준다.
 *
 * ## 보존 원칙
 * **디자인·문구는 한 글자도 바꾸지 않는다**(사용자 2026-09-03). 색·간격·hover 동작·
 * 검증 문구 전부 원본 그대로다. hex 를 우리 토큰으로 옮기지 않은 것도 의도다 —
 * 이 화면은 앱 셸 밖이라 테마 토큰을 안 쓰고, 옮기면 색이 미묘하게 달라진다.
 *
 * ## 원본과 **다른** 곳은 셋뿐이고, 전부 "목업이라 비어 있던 배선"이다
 *  1. `router.push('/dashboard')` → 실제 `login()` 호출. 성공 시 **전체 리로드**로 보낸다.
 *     SessionProvider 가 루트 레이아웃에 있어 클라이언트 라우팅으로는 언마운트되지 않고,
 *     그러면 `/auth/me` 를 다시 안 읽어 세션이 빈 채로 남아 AuthGuard 가 로그인으로
 *     되돌려 **무한 루프**가 된다(2026-08-11 실제로 겪음). `router.refresh()` 도 안 된다.
 *  2. "서비스 소개 보기" → 원본은 `/dashboard`(자리표시). 실제 소개 화면은 `/landing` 이다.
 *  3. 서버 오류 자리 추가 — 원본에는 필드 검증만 있고 "비밀번호 틀림"·"회사 정지" 를
 *     보여줄 데가 없었다. **원본의 rose 오류 스타일을 그대로** 써서 시각 언어를 맞췄다.
 *
 * 계정 열거는 서버가 막는다(없는 이메일에도 더미 해시로 같은 시간을 쓴다). 화면도 같은
 * 태도라 "없는 계정"과 "비밀번호 틀림"을 구분하지 않는다 — 문구는 api.ts 가 정한다.
 */
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, Eye, EyeOff } from "lucide-react";
import { Suspense, useState } from "react";

import { login } from "@/lib/data/api";

export default function LoginPage() {
  // useSearchParams 를 쓰는 페이지는 Suspense 로 감싸야 프리렌더가 통과한다(apps/web/CLAUDE.md).
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // 원본은 체크박스가 상태에 안 묶여 있었다(목업). 서버가 remember 를 받으므로 묶는다 —
  // 해제하면 만료 없는 세션 쿠키라 브라우저를 닫을 때 로그아웃된다.
  const [remember, setRemember] = useState(true);

  const [isServiceBtnHovered, setIsServiceBtnHovered] = useState(false);

  // Custom Validation Error States (STEP D Tone & Manner)
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    let hasError = false;
    setEmailError("");
    setPasswordError("");
    setFormError("");

    if (!email.trim()) {
      setEmailError("이 입력란을 작성하세요.");
      hasError = true;
    } else if (!email.includes("@")) {
      setEmailError("올바른 이메일 형식을 입력하세요.");
      hasError = true;
    }

    if (!password) {
      setPasswordError("이 입력란을 작성하세요.");
      hasError = true;
    }

    if (hasError) return;

    setBusy(true);
    try {
      await login(email.trim(), password, remember);
      // 성공 후에는 busy 를 안 푼다 — 아래 전체 리로드가 이 화면을 통째로 버린다.
      window.location.assign(next.startsWith("/") ? next : "/dashboard");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="sd-ui-font relative min-h-screen w-screen bg-[#05060A] text-slate-100 select-none overflow-hidden flex">
      {/* Background image: login_background_image1.jpg from public folder with blur 15 */}
      <div
        className="absolute inset-0 w-full h-full bg-cover bg-center pointer-events-none z-0 opacity-90 blur-[15px] scale-105"
        style={{ backgroundImage: `url('/login_background_image1.jpg')` }}
      />

      {/* Ambient Radial Background Glows */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#1C60FF]/20 rounded-full blur-3xl pointer-events-none z-0" />

      {/* Exact 5:5 (50% / 50%) Split Screen Container */}
      <div className="relative z-10 flex w-full min-h-screen">
        {/* Left 50% Section: STEP D Brand / Hero Showcase */}
        <div className="hidden lg:flex w-1/2 relative flex-col justify-between p-12 xl:p-16">
          {/* Top Header Logo */}
          <div className="flex items-center gap-2">
            <span className="font-['Outfit',sans-serif] font-black text-2xl tracking-wider text-white">
              STEP D
            </span>
          </div>

          {/* Center Hero Content Area */}
          <div className="my-auto max-w-2xl space-y-6">
            {/* Headline: '미디어 OS' with White -> Blue (#1C60FF) Gradient */}
            <div>
              <h1 className="text-4xl xl:text-5xl 2xl:text-6xl font-black text-white leading-tight tracking-tight whitespace-nowrap">
                방송을 위한{" "}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-blue-100 to-[#1C60FF]">
                  미디어 OS
                </span>
              </h1>
            </div>

            {/* Subcopy text in pure white color (text-white) */}
            <p className="text-sm md:text-base text-white font-normal leading-relaxed max-w-xl">
              소재 입고부터 채널 발행까지,<br />
              방송 콘텐츠 운영 전 과정이 하나의 시스템 위에서 움직입니다.
            </p>

            {/* '서비스 소개 보기' button: Hover turns bg-white -> bg-[#1C60FF] text-white & stroke to blue & arrow slides right */}
            <div className="pt-2">
              <button
                type="button"
                // ⚠️ `router.push` 를 쓰지 않는다. `/landing` 은 라우트가 아니라
                // **정적 HTML 리라이트**다(next.config.ts `beforeFiles` → step-d-landing.html · 4.2MB).
                // 클라이언트 라우팅은 RSC 를 먼저 부르는데 그 응답도 같은 4.2MB HTML 이라,
                // 페이로드가 아님을 깨닫고 하드 내비게이션으로 폴백한다 — **4.2MB 를 두 번** 받는다.
                // 프로덕션 웹은 /api/proxy 경유라 바이트가 곧 과금이다(2026-08-31 하루 276GB 사고).
                // 처음부터 전체 이동으로 보낸다. (`<Link>` 는 더 나쁘다 — 프리페치까지 붙는다.)
                onClick={() => { window.location.href = "/landing"; }}
                onMouseEnter={() => setIsServiceBtnHovered(true)}
                onMouseLeave={() => setIsServiceBtnHovered(false)}
                style={{
                  backgroundColor: isServiceBtnHovered ? "#1C60FF" : "#FFFFFF",
                  borderColor: isServiceBtnHovered ? "#1C60FF" : "transparent",
                  borderWidth: "1.5px",
                  borderStyle: "solid",
                  color: isServiceBtnHovered ? "#FFFFFF" : "#0F172A",
                  outline: "none",
                  boxShadow: isServiceBtnHovered ? "0 10px 25px -5px rgba(28, 96, 255, 0.4)" : "none",
                }}
                className="group flex items-center gap-2.5 px-6 py-3 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer active:scale-95"
              >
                <span>서비스 소개 보기</span>
                <ArrowRight
                  className="w-4 h-4 transition-all duration-300"
                  style={{
                    color: isServiceBtnHovered ? "#FFFFFF" : "#0F172A",
                    transform: isServiceBtnHovered ? "translateX(4px)" : "none",
                  }}
                />
              </button>
            </div>
          </div>

          {/* Bottom Footer Info */}
          <div className="text-xs text-slate-400 font-medium font-['Outfit',sans-serif]">
            © 2026 STEP D. All rights reserved.
          </div>
        </div>

        {/* Right 50% Section: Full Height White Panel filling 50% (w-1/2) width with subtle margin */}
        <div className="w-full lg:w-1/2 p-2 my-2 mr-2 ml-2 lg:ml-0 flex">
          <div className="w-full bg-white text-slate-900 rounded-2xl p-6 md:p-10 xl:p-14 shadow-2xl flex flex-col justify-center relative z-10 border border-[#F1F5F9]">
            {/* Centered Login Content Container with reduced width (max-w-sm) */}
            <div className="w-full max-w-sm mx-auto space-y-7 my-auto py-4">
              {/* Main Copy: 'STEP D에 로그인하여/작업을 시작하세요.' */}
              <div className="space-y-2">
                <h2 className="text-xl md:text-2xl font-black text-slate-900 leading-snug tracking-tight">
                  STEP D에 로그인하여<br />
                  작업을 시작하세요.
                </h2>
              </div>

              {/* Form with noValidate to disable ugly native HTML browser tooltip */}
              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                {/* Email Field */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-slate-800" htmlFor="login-email">
                    이메일
                  </label>

                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailError) setEmailError("");
                      if (formError) setFormError("");
                    }}
                    placeholder="email@company.com"
                    className={`w-full bg-slate-50 text-xs text-slate-900 px-4 py-3.5 rounded-xl border border-[#E2E8F0] transition-colors font-medium placeholder:text-slate-400 focus:bg-white focus:outline-none ${
                      emailError
                        ? "border-rose-400 ring-2 ring-rose-100 bg-rose-50/20"
                        : "focus:border-[#1C60FF] focus:ring-2 focus:ring-[#1C60FF]/20"
                    }`}
                  />

                  {/* Inline Error Message directly under Email Input */}
                  {emailError && (
                    <p className="flex items-center gap-1 text-[11px] font-semibold text-rose-500 pt-0.5 animate-in fade-in slide-in-from-top-1">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-500" />
                      <span>{emailError}</span>
                    </p>
                  )}
                </div>

                {/* Password Field */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-slate-800" htmlFor="login-password">
                    비밀번호
                  </label>

                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (passwordError) setPasswordError("");
                        if (formError) setFormError("");
                      }}
                      placeholder="비밀번호 입력"
                      className={`w-full bg-slate-50 text-xs text-slate-900 px-4 py-3.5 rounded-xl border border-[#E2E8F0] transition-colors font-medium placeholder:text-slate-400 pr-10 focus:bg-white focus:outline-none ${
                        passwordError
                          ? "border-rose-400 ring-2 ring-rose-100 bg-rose-50/20"
                          : "focus:border-[#1C60FF] focus:ring-2 focus:ring-[#1C60FF]/20"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors p-1 cursor-pointer"
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {/* Inline Error Message directly under Password Input */}
                  {passwordError && (
                    <p className="flex items-center gap-1 text-[11px] font-semibold text-rose-500 pt-0.5 animate-in fade-in slide-in-from-top-1">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-500" />
                      <span>{passwordError}</span>
                    </p>
                  )}
                </div>

                {/* Remember Me Option */}
                <div className="flex items-center justify-between text-xs pt-1">
                  <label className="flex items-center gap-2 cursor-pointer select-none text-slate-600 font-medium">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      className="w-4 h-4 rounded border-[#CBD5E1] accent-[#1C60FF] cursor-pointer"
                    />
                    <span>로그인 상태 유지</span>
                  </label>
                </div>

                {/* 서버가 돌려준 실패 사유 — 필드 검증과 같은 rose 언어를 쓴다.
                    "비밀번호 틀림"(401)과 "회사 정지"(403)는 사용자가 할 일이 다르므로
                    문구를 뭉뚱그리지 않는다(사유는 api.ts 가 정한다). */}
                {formError && (
                  <p
                    role="alert"
                    className="flex items-start gap-1.5 rounded-xl border border-rose-400 bg-rose-50/60 px-3 py-2.5 text-[11px] font-semibold text-rose-600 animate-in fade-in slide-in-from-top-1"
                  >
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px text-rose-500" />
                    <span>{formError}</span>
                  </p>
                )}

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full py-4 rounded-xl bg-[#0F172A] hover:bg-[#1E293B] text-white text-xs font-bold transition-all shadow-lg hover:shadow-xl cursor-pointer active:scale-[0.99] mt-2 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {busy ? "확인 중…" : "로그인"}
                </button>
              </form>

              {/* Footer info text */}
              <div className="pt-5 border-t border-[#F1F5F9] text-xs text-slate-500 leading-relaxed">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  계정은 초대받아야 만들어집니다.<br />
                  초대 메일의 링크로 들어오면 비밀번호로 설정할 수 있습니다.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
