/**
 * 원본 자막 블러 — 순수 헬퍼 + 배선 불변식.
 *
 * 시간축이 이 기능의 함정이다: 이벤트는 **마스터 절대 초**, 렌더 enable 창은 **렌더 창 상대
 * 초**다. 되베이스(windowSubBlurEvents)가 틀리면 블러가 엉뚱한 시간에 앉는데, 결과물을 눈으로
 * 보기 전까지 아무 에러도 없다 — 그래서 산수를 여기 고정한다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  clipSubBlurState,
  subBlurFingerprint,
  windowSubBlurEvents,
} from "../media/subblur.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("windowSubBlurEvents — 마스터 절대 → 렌더 창 상대", () => {
  const ev = (start: number, end: number) => ({ x: 100, y: 800, w: 900, h: 160, start, end });

  it("창 안 이벤트는 상대 초로 되베이스된다", () => {
    const out = windowSubBlurEvents([ev(95, 98)], 90, 110);
    assert.equal(out.length, 1);
    assert.equal(out[0].start, 5);
    assert.equal(out[0].end, 8);
  });

  it("창에 걸친 이벤트는 경계로 잘린다 (앞은 0, 뒤는 창 길이)", () => {
    const out = windowSubBlurEvents([ev(85, 95), ev(105, 130)], 90, 110);
    assert.equal(out.length, 2);
    assert.equal(out[0].start, 0);       // 85 는 창 앞 — 0 으로
    assert.equal(out[0].end, 5);
    assert.equal(out[1].end, 20);        // 130 은 창 뒤 — 창 길이(20)로
  });

  it("창 밖 이벤트·퇴화 사각형은 떨어진다", () => {
    const out = windowSubBlurEvents(
      [ev(10, 20), ev(200, 210), { x: 0, y: 0, w: 4, h: 4, start: 95, end: 98 }],
      90, 110,
    );
    assert.equal(out.length, 0);
  });

  it("배열이 아니면 빈 목록 — 렌더가 블러 없이라도 돌아야 한다", () => {
    assert.deepEqual(windowSubBlurEvents(undefined, 0, 10), []);
  });
});

describe("clipSubBlurState — 모양이 어긋나면 없는 것으로", () => {
  it("정상 상태는 그대로 통과", () => {
    const s = clipSubBlurState({ subBlur: {
      status: "ready", requestId: "sb_1", fingerprint: "m:0:10:0.72",
      zoneTop: 0.72, requestedAt: 1, updatedAt: 2,
    } });
    assert.equal(s?.status, "ready");
  });

  it("status·requestId·fingerprint 가 깨지면 null", () => {
    assert.equal(clipSubBlurState({ subBlur: { status: "??", requestId: "r", fingerprint: "f" } }), null);
    assert.equal(clipSubBlurState({ subBlur: { status: "ready" } }), null);
    assert.equal(clipSubBlurState({}), null);
    assert.equal(clipSubBlurState(null), null);
  });
});

describe("subBlurFingerprint — 구간·소스가 지문이다", () => {
  it("같은 입력 = 같은 지문, 구간이 바뀌면 다른 지문", () => {
    const a = subBlurFingerprint({ sourceMediaId: "m1", startTime: 10, endTime: 30 });
    const b = subBlurFingerprint({ sourceMediaId: "m1", startTime: 10, endTime: 30 });
    const c = subBlurFingerprint({ sourceMediaId: "m1", startTime: 10, endTime: 31 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("소스 없음·역전 구간은 던진다", () => {
    assert.throws(() => subBlurFingerprint({ startTime: 0, endTime: 10 }));
    assert.throws(() => subBlurFingerprint({ sourceMediaId: "m1", startTime: 10, endTime: 5 }));
  });
});

/**
 * 배선 불변식(소스 스캔): renderShort 의 **네 경로 전부**(basic · 훅 프리롤 · AI 본문 ·
 * AI 프리롤)가 sourceBlur 를 소비한다. 경로 하나가 빠지면 그 조합의 결과물만 블러 없이
 * 나가는데 — 전부 초록인 채 해외 채널에 원본 자막이 노출되는, 이 리포 최악의 조용한 실패다.
 */
describe("sourceBlur 배선 — 렌더 경로 네 곳 전부", () => {
  it("ffmpeg.ts 에 sourceBlurRects 소비처가 4곳 있다", () => {
    const src = fs.readFileSync(path.join(SRC, "media", "ffmpeg.ts"), "utf-8");
    const uses = src.match(/sourceBlurRects\(opts\)/g) ?? [];
    assert.equal(uses.length, 4,
      `sourceBlurRects(opts) 소비처가 ${uses.length}곳 — 렌더 경로(basic·프리롤·AI 본문·AI 프리롤) ` +
      "네 곳 전부여야 한다. 경로를 추가/제거했으면 블러 배선과 이 숫자를 같이 고칠 것.");
  });

  it("export 라우트가 켜짐 상태에서 미검출이면 409 를 낸다 (조용히 블러 없이 굽지 않는다)", () => {
    const src = fs.readFileSync(path.join(SRC, "index.ts"), "utf-8");
    assert.match(src, /subblur_not_ready/,
      "export 라우트에 subblur_not_ready 게이트가 없다 — 검출 전 내보내기가 블러 없이 나간다.");
    // 계획(planOnly) 직렬화가 sourceBlur 를 싣는다 — 빠지면 편집자 PC 렌더만 블러가 빠진다.
    assert.match(src, /sourceBlur:\s*plan\.sourceBlur/,
      "serializeRenderPlan 이 sourceBlur 를 싣지 않는다 — 로컬 렌더가 조용히 어긋난다.");
  });
});
