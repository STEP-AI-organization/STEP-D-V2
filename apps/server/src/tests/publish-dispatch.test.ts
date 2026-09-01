/**
 * 배포 관문의 시각·정체성 규칙 고정.
 *
 *  - 예약 시각: TZ 없는 문자열은 **KST 로 해석**한다. 화면의 datetime-local 이 만드는
 *    'YYYY-MM-DDTHH:mm' 을 Date.parse(UTC 서버)로 읽으면 예약이 전 채널에서 +9시간
 *    밀린다 — "저녁 7시"가 다음날 새벽 4시에 나가는 실패는 사용자가 되돌릴 수 없다.
 *  - 계정 정체성: record 모드 배포 행에도 남는다. 안 남으면 hasAccountDistribution 의
 *    보수 규칙(정체성 null = 모든 계정 일치)이 같은 플랫폼 2번째 계정을 영구 스킵시킨다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { normalizeReserveDate } from "../publish/publish-dispatch.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("예약 문자열은 KST 로 해석한다", () => {
  it("TZ 없는 datetime-local 문자열에 +09:00 을 부여한다", () => {
    const got = normalizeReserveDate("2026-08-20T19:00");
    assert.equal(got, "2026-08-20T19:00+09:00");
    // KST 19:00 = UTC 10:00 — Date.parse 가 UTC 로 읽던 시절보다 정확히 9시간 앞이다.
    assert.equal(Date.parse(got!), Date.UTC(2026, 7, 20, 10, 0));
  });

  it("자정 경계 — KST 자정은 UTC 로 전날 15시다 (날짜가 하루 밀리는 지점)", () => {
    // 여기가 제일 위험한 경계다: UTC 해석이면 "15일 00:30 예약"이 15일 09:30 에 나가고,
    // 날짜 기반 집계(publishedTodayKst)와도 하루가 어긋난다.
    assert.equal(
      Date.parse(normalizeReserveDate("2026-08-15T00:30")!),
      Date.UTC(2026, 7, 14, 15, 30),
    );
    assert.equal(
      Date.parse(normalizeReserveDate("2026-08-15T23:59")!),
      Date.UTC(2026, 7, 15, 14, 59),
    );
  });

  it("오프셋이 이미 있는 문자열은 손대지 않는다 — 명시된 TZ 는 존중", () => {
    assert.equal(normalizeReserveDate("2026-08-20T19:00Z"), "2026-08-20T19:00Z");
    assert.equal(normalizeReserveDate("2026-08-20T19:00+02:00"), "2026-08-20T19:00+02:00");
    assert.equal(normalizeReserveDate("2026-08-20T19:00-0500"), "2026-08-20T19:00-0500");
  });

  it("날짜만 오면 KST 자정으로 — 그냥 +09:00 을 붙이면 파싱 불가(NaN)가 된다", () => {
    const got = normalizeReserveDate("2026-08-20");
    assert.equal(got, "2026-08-20T00:00+09:00");
    assert.equal(Date.parse(got!), Date.UTC(2026, 7, 19, 15, 0));
  });

  it("빈값·공백은 undefined — 예약 없음으로 처리된다", () => {
    assert.equal(normalizeReserveDate(undefined), undefined);
    assert.equal(normalizeReserveDate(""), undefined);
    assert.equal(normalizeReserveDate("   "), undefined);
  });
});

describe("배포 행의 계정 정체성 — dispatchPublish 소스 스캔", () => {
  const src = fs.readFileSync(path.join(SRC, "publish/publish-dispatch.ts"), "utf-8");

  it("정체성 필드에 upload 모드 조건이 없다 — record 행에도 계정이 남아야 한다", () => {
    // `mode === "upload" && input.tiktokOpenId` 류가 되살아나면 게이트 OFF 의 record
    // 행이 정체성 null 이 되고, 자동 순방의 중복 방지(보수 규칙)가 2번째 계정을
    // 영구 스킵한다 — "계정 A 에는 나갔는데 B 에는 영원히 안 나가는" 조용한 실패.
    for (const field of ["tiktokOpenId", "igUserId", "metaPageId", "youtubeChannelId"]) {
      assert.doesNotMatch(
        src,
        new RegExp(`mode === "upload" && input\\.${field}`),
        `${field} 기록이 upload 모드 조건에 묶여 있다`,
      );
    }
  });

  it("예약 시각은 정규화 한 번 — 채널별 개별 파싱 금지", () => {
    // 채널마다 input.reserveDate 를 따로 읽기 시작하면 한 채널만 +9시간 밀리는
    // 반쪽 수정이 재발한다. dispatchPublish 본문에서는 정규화된 지역변수만 쓴다.
    const body = src.match(/export async function dispatchPublish[\s\S]*?\n\}/)?.[0] ?? "";
    assert.match(body, /normalizeReserveDate\(input\.reserveDate\)/, "정규화 지점이 없다");
    const raw = body.match(/input\.reserveDate/g) ?? [];
    assert.equal(raw.length, 1, "input.reserveDate 직접 사용은 정규화 지점 한 곳이어야 한다");
  });
});
