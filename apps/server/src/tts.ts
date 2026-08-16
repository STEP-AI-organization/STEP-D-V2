/**
 * 한국어 TTS — 쇼츠 **첫 3초 훅**에 얹는 내레이션.
 *
 * 왜: 숏폼은 첫 1~2초에 넘어간다. 훅 구간의 원음만으로는 무슨 상황인지 안 잡히는 경우가
 * 많아서, 어그로 한 줄을 읽어 주면 이탈 전에 맥락이 꽂힌다(사용자 방향 2026-08-16).
 *
 * **실패는 훅을 막지 않는다.** API 미활성화·쿼터·네트워크 중 무엇이든 null 을 돌려주고,
 * 렌더는 TTS 없이 그대로 진행한다 — 목소리 하나 때문에 영상이 안 나가는 게 더 나쁘다.
 *
 * 비용: Google Cloud TTS Neural2 기준 100만 자당 약 $16. 훅 한 줄(20~30자)이면 회차당
 * 사실상 ₩0 이다. 그래도 렌더마다 부르므로 같은 문구는 캐시한다.
 *
 * 인증은 gemini.ts 와 같은 방식(GoogleAuth · cloud-platform 스코프) — Cloud Run 에서는
 * 서비스 계정, 로컬에서는 ADC 가 붙는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoogleAuth } from "google-auth-library";

const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
/** 기본 목소리 — 한국어 여성 Neural2. 방송 클립 내레이션에 무난하다. */
const DEFAULT_VOICE = process.env.TTS_VOICE || "ko-KR-Neural2-A";
/** 훅은 3초 안에 끝나야 한다 — 조금 빠르게 읽는다. */
const DEFAULT_RATE = Number(process.env.TTS_RATE || 1.15);

let _auth: GoogleAuth | null = null;
function auth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  return _auth;
}

/** 같은 문구를 렌더마다 다시 합성하지 않는다. /tmp 는 RAM 이므로 파일만 두고 크기는 작다. */
function cachePath(text: string, voice: string, rate: number): string {
  const key = crypto.createHash("sha1").update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "stepd-tts");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.mp3`);
}

/**
 * 한 줄을 읽어 mp3 파일로 떨어뜨린다. 경로를 돌려주고, 못 만들면 **null**.
 * 호출부는 null 을 정상 경로로 다뤄야 한다(훅은 TTS 없이도 나간다).
 */
export async function synthesizeHookNarration(
  text: string,
  opts: { voice?: string; rate?: number } = {},
): Promise<string | null> {
  const line = String(text ?? "").trim();
  if (!line) return null;
  // 너무 길면 3초를 넘긴다 — 앞부분만 읽는다(자르는 편이 잘리는 것보다 낫다).
  const say = line.length > 60 ? `${line.slice(0, 58)}…` : line;
  const voice = opts.voice || DEFAULT_VOICE;
  const rate = opts.rate && opts.rate > 0 ? opts.rate : DEFAULT_RATE;

  const dest = cachePath(say, voice, rate);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;

  try {
    const client = await auth().getClient();
    const token = (await client.getAccessToken()).token;
    if (!token) return null;
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text: say },
        voice: { languageCode: "ko-KR", name: voice },
        audioConfig: { audioEncoding: "MP3", speakingRate: rate },
      }),
    });
    if (!res.ok) {
      // 미활성화(403 SERVICE_DISABLED)가 가장 흔하다 — 사유를 남기되 렌더는 막지 않는다.
      console.warn(`[tts] 합성 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const body = await res.json() as { audioContent?: string };
    if (!body.audioContent) return null;
    fs.writeFileSync(dest, Buffer.from(body.audioContent, "base64"));
    return dest;
  } catch (e) {
    console.warn("[tts] 합성 실패:", e instanceof Error ? e.message.slice(0, 200) : e);
    return null;
  }
}
