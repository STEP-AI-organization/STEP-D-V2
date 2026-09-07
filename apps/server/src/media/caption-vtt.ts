/**
 * 자막 세그먼트 → WebVTT — 유튜브 캡션 트랙(`captions.insert`) 업로드용 (2026-09-07).
 *
 * 번인(ASS)과 목적이 다르다. 번인은 화면에 굽는 것이라 한 화면 글자수·폰트·위치가 전부
 * 걸리지만, 캡션 트랙은 **플레이어가 알아서 그린다** — 우리는 시간과 텍스트만 정확하면 된다.
 * 그래서 `chunkCaption`(한 화면 11자/16자 규칙)을 태우지 않는다. 조각을 잘게 쪼개면 오히려
 * 플레이어에서 자막이 깜빡이고, 자동 줄바꿈은 플레이어가 자기 폭에 맞춰 하는 게 낫다.
 *
 * WebVTT 를 쓰는 이유는 SRT 와 달리 **UTF-8 이 규격에 박혀 있어서**다. SRT 는 인코딩 선언이
 * 없어 수신측이 latin-1 로 읽으면 한글·베트남어 성조가 통째로 깨진다.
 */

export interface VttCue {
  start: number;
  end: number;
  text: string;
}

/**
 * 마스터 절대초 자막 → 클립 구간 기준 큐.
 *
 * ⚠️ **`windowCaptions`(번인용)와 일부러 다르다.** 저쪽은 경계에 걸친 문장의 *텍스트까지*
 * 비율로 잘라낸다 — 화면에 굽는 자막은 노출 구간 밖 글자가 보이면 안 되기 때문이다.
 * 캡션 트랙은 반대다: 잘린 문장("그건 진짜 말도")이 자막 메뉴에 남으면 그냥 오역처럼 보인다.
 * 여기서는 **문장을 통째로 싣고 시간만 구간 안으로 클램프**한다.
 */
export function clipCues(segments: unknown[], start: number, end: number): VttCue[] {
  if (!Array.isArray(segments)) return [];
  const dur = end - start;
  if (!(dur > 0)) return [];
  const out: VttCue[] = [];
  for (const s of segments) {
    const st = Number((s as any)?.start);
    const en = Number((s as any)?.end);
    const text = String((s as any)?.text ?? "").trim();
    if (!text || !Number.isFinite(st) || !Number.isFinite(en)) continue;
    if (en <= start || st >= end) continue;
    const rs = Math.max(0, st - start);
    const re = Math.min(dur, en - start);
    if (re <= rs + 0.05) continue;
    out.push({ start: rs, end: re, text });
  }
  return out;
}

/** 초 → `HH:MM:SS.mmm` (WebVTT 타임스탬프). 음수는 0 으로 — 잘못된 값이 파일을 깨지 않게. */
function stamp(sec: number): string {
  const t = Math.max(0, Number(sec) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

/**
 * 큐 배열 → WebVTT 본문.
 *
 * - 시간이 뒤집혔거나 빈 텍스트인 큐는 버린다 — 하나만 깨져도 트랙 전체가 거부된다.
 * - 겹치는 큐는 앞 큐의 끝을 당겨 붙인다. 유튜브는 겹침을 허용하지만 플레이어가 두 줄을
 *   동시에 띄워 읽기 어려워진다(STT 세그먼트는 경계가 겹치는 일이 흔하다).
 * - `-->` 는 VTT 문법이라 텍스트 안에 있으면 큐가 갈라진다 → 유니코드 화살표로 바꾼다.
 */
export function toWebVtt(cues: VttCue[]): string {
  const clean = cues
    .map((c) => ({
      start: Number(c.start),
      end: Number(c.end),
      text: String(c.text ?? "").trim(),
    }))
    .filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const lines: string[] = ["WEBVTT", ""];
  for (let i = 0; i < clean.length; i++) {
    const cue = clean[i];
    const next = clean[i + 1];
    const end = next && next.start < cue.end ? Math.max(cue.start + 0.05, next.start) : cue.end;
    const text = cue.text.replace(/-->/g, "⟶");
    lines.push(`${stamp(cue.start)} --> ${stamp(end)}`, text, "");
  }
  return lines.join("\n");
}
