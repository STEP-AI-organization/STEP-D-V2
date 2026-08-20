/**
 * 말자막(STT)을 **화면 단위**로 끊는다 — 쇼츠 자막의 정본 규칙.
 *
 * STT 한 세그먼트는 40~60자가 예사다. 그대로 구우면 9:16 세로 화면에서 4~5줄이 되어 화면
 * 절반을 자막이 덮는다(2026-08-19 사용자 지적: "쇼츠라서 문제임. 너무 많이 한번에 나옴").
 * 여기서 상한을 두고 쪼갠 뒤 순서대로 띄운다.
 *
 * ⚠️ 이 규칙은 **미리보기(web presets.ts::chunkCaption)와 쌍둥이**다. 상한이 갈라지면 편집
 * 화면에서 본 자막 덩어리와 결과물 덩어리가 달라진다 — overlay-parity.test.ts 가 상한 일치를,
 * caption-chunk.test.ts 가 동작을 고정한다.
 */

export type CaptionWord = { word: string; start: number; end: number };
export type Caption = { start: number; end: number; text: string; words?: CaptionWord[] };

/**
 * 자막 한 화면 최대 글자수(공백 포함).
 * 9:16 에서 자막 기본 크기(화면 높이 4.4%)면 한 줄에 들어가는 한글이 대략 11자 — 11자로 두면
 * **항상 한 줄**로 통일된다(사용자 2026-08-20: "1줄/2줄 왔다갔다 안 되게"). 예전 18(두 줄)은
 * 세그먼트 길이에 따라 1~2줄이 갈렸다. (사용자가 슬라이더로 올리면 여러 줄도 가능.)
 */
export const CAPTION_CHUNK_MAX_CHARS = 11;
/** 청크 최소 노출(초). 이보다 짧게 나뉘면 이웃에 도로 붙인다 — 깜빡이면 오히려 못 읽는다. */
export const CAPTION_CHUNK_MIN_SEC = 0.7;

/**
 * 한 문장을 화면 단위(최대 maxChars)로 끊는다. 경계는 **공백 토큰** 이고, 문장부호로 끝나는
 * 토큰에서 우선 끊는다(의미 단위 = 화면 단위). 단어를 글자 중간에서 자르지 않는다.
 */
export function splitCaptionText(text: string, maxChars: number): string[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const max = Math.max(6, Math.floor(maxChars));
  // 균형 분할 — greedy 로 첫 조각을 max 까지 꽉 채우면 "…대출업자들은 일정" | "부분의 채무가" 처럼
  // 구(phrase)가 중간에서 갈라진다(사용자 2026-08-20 실측). 필요한 조각 수(ceil)로 나눈 균등
  // 목표(target)까지만 채워 조각을 고르게 만들면 구가 덜 갈라지고 꼬리 파편도 준다.
  // (문장부호 강제 끊기·꼬리 병합·단어 안 자름은 그대로. target 은 max 이하라 상한도 유지.)
  const totalChars = tokens.reduce((a, t) => a + [...t].length, 0) + (tokens.length - 1);
  const nChunks = Math.max(1, Math.ceil(totalChars / max));
  const target = Math.max(6, Math.ceil(totalChars / nChunks));
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  const flush = () => { if (cur.length) { out.push(cur.join(" ")); cur = []; len = 0; } };
  for (const tok of tokens) {
    const tl = [...tok].length;
    if (cur.length && len + 1 + tl > target) flush();
    len = cur.length ? len + 1 + tl : tl;
    cur.push(tok);
    // 쉼표는 절반은 채웠을 때만 — 안 그러면 "근데," 같은 두 글자짜리 화면이 나온다.
    if (/[.!?…]$/.test(tok) || (/[,、·]$/.test(tok) && len >= max / 2)) flush();
  }
  flush();
  // 꼬리 한 조각이 너무 짧으면 앞에 붙인다 — 단어 하나가 홀로 깜빡이는 게 제일 눈에 거슬린다.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if ([...last].length <= 4 && [...prev].length + 1 + [...last].length <= max + 4) {
      out.splice(out.length - 2, 2, `${prev} ${last}`);
    }
  }
  return out;
}

/** 글자수 세기 — 공백·문장부호 제외. refine 단계가 문장부호를 덧붙이므로(실측: "아니 나
 *  궁금해" → "아니, 나 궁금해.") 부호를 빼야 words 와 text 의 글자수가 맞는다. */
function coreChars(s: string): number {
  return [...s.replace(/[\s\p{P}\p{S}]/gu, "")].length;
}

/**
 * 조각 경계를 **실제 STT 타이밍**에 맞춘다 — 각 조각의 끝 시각 배열을 돌려준다(실패 시 null).
 *
 * ⚠️ word 단위를 가정하지 않는다. 프로덕션 Soniox 는 words 가 **음절 단위**고(실측: 13토큰
 * 문장의 words 가 35개), whisper 는 어절 단위다. 둘 다 `word` 를 이어 붙이면 원문이 되므로
 * **글자수를 누적해** 조각 경계까지 소비하는 방식이면 입자 크기와 무관하게 맞는다.
 * (예전 구현은 words.length === 토큰수 일 때만 썼는데, 그러면 프로덕션에선 한 번도 안 걸려
 *  전부 비례배분으로 떨어진다 — 침묵 구간에서 자막이 통째로 밀린다.)
 */
function alignChunkEnds(words: CaptionWord[], parts: string[]): number[] | null {
  if (!Array.isArray(words) || !words.length) return null;
  const wlen = words.map((w) => coreChars(String(w?.word ?? "")));
  const totalW = wlen.reduce((a, b) => a + b, 0);
  const totalP = parts.reduce((a, p) => a + coreChars(p), 0);
  // 글자수가 크게 어긋나면 다른 텍스트다(refine 재작성 등) — 신뢰하지 않고 비례배분으로 간다.
  if (!totalW || !totalP || Math.abs(totalW - totalP) > Math.max(2, totalP * 0.2)) return null;
  const ends: number[] = [];
  let wi = 0;
  let cum = 0;
  let target = 0;
  for (const p of parts) {
    target += coreChars(p);
    while (wi < words.length && cum < target) { cum += wlen[wi]; wi++; }
    const w = words[Math.max(0, wi - 1)];
    const e = Number(w?.end);
    if (!Number.isFinite(e)) return null;
    ends.push(e);
  }
  return ends;
}

/**
 * 세그먼트 하나(STT 한 발화)를 화면 단위 자막 여러 개로 쪼갠다 — 시간과 word 타이밍까지 분배.
 *
 * 시간 배분: STT 타이밍(음절·어절 무관)이 있으면 그 경계에 맞추고, 없으면 음절 수 비례로
 * 나눈다. 조각은 **빈틈 없이 이어 붙인다** — 사이가 벌어지면 발화 중간에 자막이 사라진다.
 */
export function chunkCaption(cap: Caption, maxChars: number): Caption[] {
  const text = String(cap.text ?? "").trim();
  const dur = cap.end - cap.start;
  if (!text || !(dur > 0)) return [];
  const parts = splitCaptionText(text, maxChars);
  if (parts.length <= 1) return [{ ...cap, text }];

  const words = Array.isArray(cap.words) ? cap.words : [];
  const aligned = alignChunkEnds(words, parts);
  const weights = parts.map((p) => Math.max(1, [...p.replace(/\s+/g, "")].length));
  const total = weights.reduce((a, b) => a + b, 0);

  const split: Caption[] = [];
  let t = cap.start;
  parts.forEach((p, i) => {
    const raw = i === parts.length - 1
      ? cap.end
      : aligned
        ? aligned[i]
        : t + (weights[i] / total) * dur;
    const end = Math.max(t + 0.05, Math.min(cap.end, raw));
    // 이 조각 구간에 걸치는 word 만 싣는다(카라오케용). 입자가 음절이어도 그대로 동작한다.
    const slice = words.filter((w) => Number(w.end) > t && Number(w.start) < end);
    const c: Caption = { start: t, end, text: p };
    if (slice.length) c.words = slice;
    split.push(c);
    t = end;
  });

  // 너무 짧은 조각은 앞 조각에 병합(첫 조각은 앞이 없으니 뒤 조각에 병합).
  const merged: Caption[] = [];
  for (const c of split) {
    const prev = merged[merged.length - 1];
    if (prev && c.end - c.start < CAPTION_CHUNK_MIN_SEC) {
      prev.end = c.end;
      prev.text = `${prev.text} ${c.text}`;
      if (prev.words && c.words) prev.words = [...prev.words, ...c.words];
      else delete prev.words;
      continue;
    }
    merged.push({ ...c });
  }
  if (merged.length >= 2 && merged[0].end - merged[0].start < CAPTION_CHUNK_MIN_SEC) {
    const [a, b] = merged;
    const head: Caption = { start: a.start, end: b.end, text: `${a.text} ${b.text}` };
    if (a.words && b.words) head.words = [...a.words, ...b.words];
    merged.splice(0, 2, head);
  }
  return merged;
}

/** editorState.captionMaxChars 오버라이드 → 유효한 상한. 오타·빈값·과소는 기본값으로. */
export function captionMaxCharsOf(es: unknown): number {
  const v = es && typeof es === "object" ? (es as { captionMaxChars?: unknown }).captionMaxChars : undefined;
  return Number.isFinite(v) && Number(v) >= 6 ? Math.round(Number(v)) : CAPTION_CHUNK_MAX_CHARS;
}
