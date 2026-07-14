"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getYouTubeAuthUrl } from "@/lib/data/api";

export default function RegisterPage() {
  const searchParams = useSearchParams();
  const [channelUrl, setChannelUrl] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const success = searchParams.get("success");
    const error = searchParams.get("error");
    const channelName = searchParams.get("channelName");

    if (success && channelName) {
      setMessage({ type: "success", text: `✅ YouTube 채널 "${channelName}" 등록이 완료되었습니다!` });
    } else if (error) {
      setMessage({ type: "error", text: `❌ 등록에 실패했습니다: ${decodeURIComponent(error)}` });
    }
  }, [searchParams]);

  const handleLogin = () => {
    window.location.href = getYouTubeAuthUrl(channelUrl || undefined);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
      <div className="w-full max-w-md mx-auto p-8">
        <div className="bg-zinc-900/80 backdrop-blur-sm border border-zinc-800 rounded-2xl p-8 shadow-2xl">
          {/* Logo / Header */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white">STEP-D</h1>
            <p className="text-zinc-400 mt-2">YouTube 채널 등록</p>
          </div>

          {/* Message */}
          {message && (
            <div className={`p-4 rounded-xl mb-6 text-sm ${
              message.type === "success"
                ? "bg-emerald-900/40 border border-emerald-800 text-emerald-300"
                : "bg-red-900/40 border border-red-800 text-red-300"
            }`}>
              {message.text}
            </div>
          )}

          {/* Channel URL (optional) */}
          <div className="mb-6">
            <label className="block text-sm text-zinc-400 mb-2">
              YouTube 채널 URL <span className="text-zinc-600">(선택)</span>
            </label>
            <input
              type="url"
              placeholder="https://youtube.com/@yourchannel"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          {/* Login Button */}
          <button
            onClick={handleLogin}
            className="w-full bg-white hover:bg-zinc-100 text-zinc-900 font-semibold rounded-xl px-6 py-3 flex items-center justify-center gap-3 transition shadow-lg"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Google 계정으로 로그인
          </button>

          <p className="text-zinc-500 text-xs text-center mt-6 leading-relaxed">
            Google 로그인 후 선택한 YouTube 채널이<br />
            STEP-D 시스템에 등록됩니다.
          </p>

          {channelUrl && (
            <div className="mt-4 p-3 bg-zinc-800/50 rounded-xl border border-zinc-700/50">
              <p className="text-zinc-400 text-xs">등록할 채널</p>
              <p className="text-white text-sm truncate">{channelUrl}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
