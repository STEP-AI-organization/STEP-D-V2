import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSweepChannel } from "../pipeline/channel-pipeline.ts";

/**
 * 채널 스윕 게이트 — **15분마다 깨는 스윕이 6시간짜리 주기를 상대로 헛돌지 않게** 한다.
 *
 * 실측(2026-08-31 프로덕션 · 채널 12개): `channel.analyze` 누적 **23,121건**.
 * 스윕이 `revoked` 만 거르고 신선도는 잡을 집은 뒤에야 봤기 때문에, 96회/일 × 12채널이
 * 그대로 큐에 들어가고 96회 중 92회가 아무것도 안 하고 끝났다.
 *
 * 아래 케이스는 **그때 실제로 있던 채널들**이다 — 숫자를 지어내지 않았다.
 */
const H = 60 * 60 * 1000;
const NOW = 1_000_000 * H;

/** 실측 채널 상태를 그대로 옮긴 것(시각은 NOW 기준 상대). */
const ch = (o: Partial<Parameters<typeof shouldSweepChannel>[0]>) => ({
  status: "active", lastSyncedAt: NOW - 1 * H, lastAnalyzedAt: NOW - 1 * H, ...o,
});

describe("채널 스윕 게이트", () => {
  // ⚠️ 실측에서 12채널 중 6개가 이 상태였다 — 18일간 동기화 실패인데 계속 큐잉되고 있었다.
  it("disconnected 는 안 돈다 — 사람이 끊은 채널은 절대 성공하지 않는다", () => {
    assert.equal(shouldSweepChannel(ch({ status: "disconnected", lastSyncedAt: NOW - 435 * H, lastAnalyzedAt: NOW - 453 * H }), NOW), false);
  });

  it("revoked 도 안 돈다 (기존 동작 유지)", () => {
    assert.equal(shouldSweepChannel(ch({ status: "revoked" }), NOW), false);
  });

  it("최근에 둘 다 돌았으면 건너뛴다 — 헛돌이의 본체", () => {
    assert.equal(shouldSweepChannel(ch({ lastSyncedAt: NOW - 1 * H, lastAnalyzedAt: NOW - 1 * H }), NOW), false);
  });

  it("영상 동기화가 6시간을 넘기면 돈다", () => {
    assert.equal(shouldSweepChannel(ch({ lastSyncedAt: NOW - 7 * H, lastAnalyzedAt: NOW - 1 * H }), NOW), true);
  });

  it("애널리틱스가 24시간을 넘기면 돈다", () => {
    assert.equal(shouldSweepChannel(ch({ lastSyncedAt: NOW - 1 * H, lastAnalyzedAt: NOW - 25 * H }), NOW), true);
  });

  // ⚠️ 이게 깨지면 **새로 연결한 채널이 영영 안 돈다** — 연동 직후 화면이 비어 보인다.
  it("한 번도 안 돈 채널은 즉시 돈다", () => {
    assert.equal(shouldSweepChannel(ch({ lastSyncedAt: null, lastAnalyzedAt: null }), NOW), true);
  });

  // 실측 2개가 이 상태였다(`needs re-consent for analytics scope`). 사람이 재동의해야 풀리는
  // 상태라 여기서 막으면 **재동의한 뒤에도 안 도는** 더 나쁜 실패가 된다 — 계속 도는 게 맞다.
  it("애널리틱스 재동의가 필요한 채널은 계속 돈다 (의도)", () => {
    assert.equal(shouldSweepChannel(ch({ lastSyncedAt: NOW - 1 * H, lastAnalyzedAt: null }), NOW), true);
  });

  // 실측 12채널을 그대로 넣어 "몇 개가 남는가" 를 고정한다.
  it("실측 12채널 기준 — 매 스윕 12개 → 2개 (83%↓)", () => {
    const real = [
      ch({ lastSyncedAt: NOW - 0 * H, lastAnalyzedAt: NOW - 22 * H }),
      ch({ lastSyncedAt: NOW - 4 * H, lastAnalyzedAt: NOW - 21 * H }),
      ch({ lastSyncedAt: NOW - 5 * H, lastAnalyzedAt: NOW - 1 * H }),
      ch({ lastSyncedAt: NOW - 6 * H, lastAnalyzedAt: NOW - 22 * H }),   // 6h 도달 → due
      ch({ lastSyncedAt: NOW - 6 * H, lastAnalyzedAt: null }),           // 재동의 필요 → due
      ...Array.from({ length: 6 }, () =>
        ch({ status: "disconnected", lastSyncedAt: NOW - 440 * H, lastAnalyzedAt: NOW - 453 * H })),
      ch({ status: "revoked", lastSyncedAt: NOW - 453 * H, lastAnalyzedAt: NOW - 453 * H }),
    ];
    // 도는 것: ① 동기화 6시간 도달 ② 애널리틱스 재동의 대기(항상 due).
    // 나머지 10개는 disconnected 6 · revoked 1 · 최근에 이미 돈 것 3.
    assert.equal(real.filter((c) => shouldSweepChannel(c, NOW)).length, 2);
  });
});
