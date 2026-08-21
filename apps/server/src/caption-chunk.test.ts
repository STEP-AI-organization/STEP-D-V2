import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTION_CHUNK_MAX_CHARS, CAPTION_CHUNK_MIN_SEC, captionMaxCharsOf, chunkCaption, splitCaptionText,
} from "./caption-chunk.ts";

const chars = (s: string) => [...s].length;

describe("splitCaptionText — 화면 단위로 끊기", () => {
  it("상한을 넘는 문장을 여러 조각으로 나눈다 (단어 중간에서 자르지 않는다)", () => {
    // 실제 사례(c_80796436) — 통짜로 뜨면 9:16 에서 4~5줄이 된다.
    const line = "이거는 액수 가지고 과다를 논해서 송영길 후보처럼 왜 50조나 더 버는데 1조 가지고 이 난리냐";
    const parts = splitCaptionText(line, CAPTION_CHUNK_MAX_CHARS);
    assert.ok(parts.length >= 3, `${parts.length} 조각 — 50자짜리가 안 쪼개졌다`);
    for (const p of parts) {
      assert.ok(chars(p) <= CAPTION_CHUNK_MAX_CHARS + 4,
        `조각이 상한을 크게 넘는다(${chars(p)}자): ${p}`);
    }
    // 원문 복원 — 글자를 잃거나 순서가 바뀌면 안 된다.
    assert.equal(parts.join(" "), line);
  });

  it("상한 이하 문장은 그대로 한 조각", () => {
    assert.deepEqual(splitCaptionText("짧은 자막입니다", 18), ["짧은 자막입니다"]);
  });

  it("문장부호에서 우선 끊는다 (의미 단위 = 화면 단위)", () => {
    const parts = splitCaptionText("진짜요? 그럼 어떻게 되는 건데요", 18);
    assert.equal(parts[0], "진짜요?");
  });

  it("한 단어가 상한보다 길어도 자르지 않는다", () => {
    const parts = splitCaptionText("대한민국헌법제일조제일항대한민국은민주공화국이다", 18);
    assert.equal(parts.length, 1);
  });

  it("빈 문자열·공백은 빈 배열", () => {
    assert.deepEqual(splitCaptionText("", 18), []);
    assert.deepEqual(splitCaptionText("   ", 18), []);
  });

  it("꼬리 한 단어는 앞 조각에 붙인다 (혼자 깜빡이는 게 제일 거슬린다)", () => {
    const parts = splitCaptionText("어제 저녁에 친구랑 같이 밥을 먹었는데 진짜", 18);
    assert.ok(!/^진짜$/.test(parts[parts.length - 1]), `꼬리가 홀로 남았다: ${JSON.stringify(parts)}`);
  });
});

describe("chunkCaption — 시간 분배", () => {
  it("조각이 빈틈 없이 이어지고 원래 구간을 벗어나지 않는다", () => {
    const cap = { start: 10, end: 16, text: "이거는 액수 가지고 과다를 논해서 송영길 후보처럼 왜 50조나 더 버는데 1조 가지고 이 난리냐" };
    const out = chunkCaption(cap, CAPTION_CHUNK_MAX_CHARS);
    assert.ok(out.length >= 2);
    assert.equal(out[0].start, cap.start);
    assert.equal(out[out.length - 1].end, cap.end);
    for (let i = 1; i < out.length; i++) {
      assert.equal(out[i].start, out[i - 1].end, "조각 사이가 벌어지면 발화 중간에 자막이 사라진다");
      assert.ok(out[i].end > out[i].start);
    }
  });

  it("어절 단위 word 타이밍(whisper 모양)에 경계를 맞춘다", () => {
    const text = "가나다 라마바 사아자 차카타 파하가 나다라";
    const tokens = text.split(" ");
    // 앞 세 단어가 0~1초에 몰리고 뒤가 길게 늘어지는 발화.
    const spans = [[0, 0.3], [0.3, 0.6], [0.6, 1.0], [1.0, 4.0], [4.0, 7.0], [7.0, 10]];
    const words = tokens.map((w, i) => ({ word: w, start: spans[i][0], end: spans[i][1] }));
    const out = chunkCaption({ start: 0, end: 10, text, words }, 12);
    assert.ok(out.length >= 2);
    // 음절 비례였다면 첫 조각이 10초의 1/3(≈3.3초)에서 끝난다 — word 경계를 썼다면 1.0초.
    assert.equal(out[0].end, 1.0);
    assert.deepEqual(out[0].words?.map((w) => w.word), ["가나다", "라마바", "사아자"]);
  });

  it("음절 단위 word 타이밍(프로덕션 Soniox 모양)에도 경계를 맞춘다", () => {
    // ⚠️ 이게 프로덕션 경로다. Soniox 토큰은 음절 단위이고 어절 시작에 leading space 가 붙는다
    // (실측: 13토큰 문장의 words 가 35개). 어절 수 == word 수를 요구하면 여기서 절대 안 걸려
    // 전부 비례배분으로 떨어진다 — 침묵 구간에서 자막이 통째로 밀린다.
    const text = "가나다 라마바 사아자 차카타";
    const syl: { word: string; start: number; end: number }[] = [];
    // 앞 두 어절은 0~1초에 몰리고, 뒤 두 어절은 5초 침묵 뒤에 나온다.
    const plan: [string, number, number][] = [
      [" 가", 0, 0.1], ["나", 0.1, 0.2], ["다", 0.2, 0.3],
      [" 라", 0.3, 0.5], ["마", 0.5, 0.7], ["바", 0.7, 1.0],
      [" 사", 6.0, 6.2], ["아", 6.2, 6.4], ["자", 6.4, 6.6],
      [" 차", 6.6, 6.8], ["카", 6.8, 7.0], ["타", 7.0, 10],
    ];
    for (const [w, s, e] of plan) syl.push({ word: w, start: s, end: e });
    const out = chunkCaption({ start: 0, end: 10, text, words: syl }, 8);
    assert.equal(out.length, 2);
    // 비례배분이었다면 5초에서 끊긴다(글자수 반반) — 음절 타이밍을 썼다면 1.0초.
    assert.equal(out[0].end, 1.0);
    assert.equal(out[0].text, "가나다 라마바");
  });

  it("words 가 텍스트와 크게 어긋나면 신뢰하지 않고 비례배분으로 간다", () => {
    const text = "가나다 라마바 사아자 차카타 파하가 나다라";
    const out = chunkCaption(
      { start: 0, end: 10, text, words: [{ word: "가나다", start: 0, end: 1 }] },
      12,
    );
    assert.ok(out.length >= 2);
    // 음절 비례 = 글자수 비례. 첫 조각(9자)/전체(18자) → 5초.
    assert.ok(Math.abs(out[0].end - 5) < 0.01, `비례배분이 아니다: ${out[0].end}`);
  });

  it("문장부호가 refine 으로 덧붙어도 정렬이 깨지지 않는다", () => {
    // 실측: refine 이 "아니 나 궁금해" → "아니, 나 궁금해." 로 부호를 넣는다. words 엔 없다.
    const text = "가나다, 라마바. 사아자 차카타";
    const words = [
      { word: "가나다", start: 0, end: 1.0 },
      { word: " 라마바", start: 1.0, end: 2.0 },
      { word: " 사아자", start: 6.0, end: 7.0 },
      { word: " 차카타", start: 7.0, end: 10 },
    ];
    const out = chunkCaption({ start: 0, end: 10, text, words }, 9);
    assert.ok(out.length >= 2);
    assert.equal(out[0].end, 2.0, "부호 때문에 글자수가 어긋나 비례배분으로 떨어졌다");
  });

  it("짧게 나뉜 조각은 이웃에 병합한다 — 단 한 줄 예산 안에서만 (최소 노출 보장)", () => {
    // 1.2초짜리 발화를 2조각으로 나누면 각 0.6초 — 최소(0.7초) 미달이라 도로 하나가 된다.
    // **병합 결과가 한 줄에 들어갈 때만** 합친다.
    const out = chunkCaption({ start: 0, end: 1.2, text: "가나다 라마바" }, 6);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "가나다 라마바");
    assert.ok(out[0].end - out[0].start >= CAPTION_CHUNK_MIN_SEC);
  });

  it("한 줄 예산을 넘기면 병합하지 않는다 — 짧은 구간도 여러 줄로 뭉치지 않는다 (사용자 2026-08-21)", () => {
    // 트림인을 걸친 자막: 2.5초 문장이 클립엔 0.4초만 들어오면 예전엔 최소노출 병합이 전부
    // 뭉쳐 한 덩어리(렌더가 \q1 로 3줄)로 구웠다. 이제는 예산 초과 병합을 막아 **어떤 조각도
    // 한 줄(max+4)을 넘지 않는다** — 사용자의 "항상 1줄" 이 최소노출보다 우선.
    const out = chunkCaption({ start: 0, end: 0.4, text: "한 달여 줄다리기 끝에 노사가 다시 손을 잡았습니다" }, CAPTION_CHUNK_MAX_CHARS);
    const budget = CAPTION_CHUNK_MAX_CHARS + 4;
    assert.ok(out.length >= 2, "전부 한 덩어리로 뭉쳤다 — 여러 줄이 된다");
    for (const c of out) {
      assert.ok([...c.text].length <= budget, `조각이 한 줄 예산 초과(${[...c.text].length}): "${c.text}"`);
    }
  });

  it("빈 텍스트·역전 구간은 아무 것도 만들지 않는다", () => {
    assert.deepEqual(chunkCaption({ start: 5, end: 5, text: "가나다" }, 18), []);
    assert.deepEqual(chunkCaption({ start: 0, end: 3, text: "  " }, 18), []);
  });
});

describe("captionMaxCharsOf — editorState 오버라이드", () => {
  it("유효한 값만 쓴다 (오타·빈값·과소는 기본값)", () => {
    assert.equal(captionMaxCharsOf({ captionMaxChars: 24 }), 24);
    assert.equal(captionMaxCharsOf({ captionMaxChars: 24.6 }), 25);
    assert.equal(captionMaxCharsOf({}), CAPTION_CHUNK_MAX_CHARS);
    assert.equal(captionMaxCharsOf(null), CAPTION_CHUNK_MAX_CHARS);
    assert.equal(captionMaxCharsOf({ captionMaxChars: "24" }), CAPTION_CHUNK_MAX_CHARS);
    assert.equal(captionMaxCharsOf({ captionMaxChars: 2 }), CAPTION_CHUNK_MAX_CHARS);
  });
});
