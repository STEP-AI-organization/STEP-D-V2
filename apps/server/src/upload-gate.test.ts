/**
 * 업로드 게이트 — 불변식 고정.
 *
 * FLOWS F3 는 "게이트를 통과하지 않은 미디어는 어떤 경로로도 게시되지 않는다"를 요구하고,
 * 그런 규칙은 UI 가 아니라 **서버에서** 막혀야 한다. 이 파일은 그 원칙을 지금 존재하는
 * 유일한 게이트(YouTube 실업로드)에 대해 먼저 고정한다.
 *
 * 여기서 확인하는 건 "켜면 켜진다"가 아니라 **꺼지는 방향**이다. env 를 잘못 써서
 * 실수로 업로드되는 일이 없어야 한다 — 오타·빈값·미설정·이상한 값은 전부 OFF.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  assertUploadEnabled,
  UPLOAD_DISABLED_CODE,
  UploadDisabledError,
  youtubeUploadEnabled,
} from "./upload-gate.ts";

const KEY = "YOUTUBE_UPLOAD_ENABLED";
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

function withEnv(value: string | undefined, run: () => void): void {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  run();
}

describe("업로드 게이트", () => {
  it("미설정이면 꺼져 있다 — 배포만 해서는 아무것도 게시되지 않는다", () => {
    withEnv(undefined, () => assert.equal(youtubeUploadEnabled(), false));
  });

  it("명시적 truthy 값에서만 켜진다", () => {
    for (const v of ["true", "1", "on", "yes", "enabled", "TRUE", " On "]) {
      withEnv(v, () => assert.equal(youtubeUploadEnabled(), true, `${JSON.stringify(v)} 는 ON 이어야 한다`));
    }
  });

  it("오타·빈값·유사값은 전부 꺼진다 (실패 방향이 '안 나감' 이어야 한다)", () => {
    // "trรue" 같은 오타뿐 아니라, 사람이 켰다고 착각하기 쉬운 값들을 함께 고정한다.
    for (const v of ["", " ", "ture", "tru", "y", "Y", "ok", "0", "false", "off", "no", "disabled", "2", "null"]) {
      withEnv(v, () => assert.equal(youtubeUploadEnabled(), false, `${JSON.stringify(v)} 는 OFF 여야 한다`));
    }
  });

  it("꺼져 있으면 assertUploadEnabled 가 던지고, 구분 가능한 코드를 갖는다", () => {
    withEnv(undefined, () => {
      assert.throws(() => assertUploadEnabled(), (err: unknown) => {
        assert.ok(err instanceof UploadDisabledError, "전용 예외 클래스여야 한다");
        // '막았다'와 '업로드가 실패했다'를 호출부가 구분할 수 있어야 한다.
        assert.equal((err as UploadDisabledError).code, UPLOAD_DISABLED_CODE);
        return true;
      });
    });
  });

  it("켜져 있으면 통과한다", () => {
    withEnv("true", () => assert.doesNotThrow(() => assertUploadEnabled()));
  });

  it("호출 시점에 env 를 읽는다 — 재배포로 끌 수 있어야 한다", () => {
    // 모듈 로드 시점에 캡처하면, 켜진 채 뜬 프로세스를 끌 방법이 없어진다.
    withEnv("true", () => assert.equal(youtubeUploadEnabled(), true));
    withEnv("false", () => assert.equal(youtubeUploadEnabled(), false));
  });
});
