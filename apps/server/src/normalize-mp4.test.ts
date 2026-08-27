/**
 * 원본 정규화 (MXF 등 → mp4) — 사용자 결정 2026-08-27:
 * **"웹에서는 오로지 MXF 를 mp4 로 전환 후 다룬다."**
 *
 * 이 파일이 지키는 것 셋:
 *  1. **판정이 보수적이어야 한다.** 이미 웹 호환(mp4/h264/aac 단일 트랙 progressive)인 파일을
 *     다시 인코딩하면 화질만 깎고 시간·비용만 든다.
 *  2. **방송 원본은 반드시 걸러야 한다.** 컨테이너·코덱·다중 오디오·인터레이스 중 하나라도
 *     걸리면 변환한다 — 안 하면 브라우저 검은 화면·반쪽 소리·빗살무늬가 결과물까지 간다.
 *  3. **원본을 지우거나 덮어쓰지 않는다.** 방송사 소재라 되돌릴 수 없다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { audioMapArgs, needsMp4Normalize, NORMALIZE_MAX_HEIGHT } from "./ffmpeg.ts";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

/** 이미 웹 호환인 표준 mp4 — 이 조합만 "변환 불필요" 다. */
const webReady = {
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  codec: "h264", audioCodec: "aac", audioStreams: 1, interlaced: false, hasAudio: true,
};

describe("정규화 판정 (needsMp4Normalize)", () => {
  it("표준 mp4 는 건드리지 않는다 — 재인코딩은 화질 손해다", () => {
    const v = needsMp4Normalize(webReady);
    assert.equal(v.needed, false);
    assert.deepEqual(v.reasons, []);
  });

  it("MXF 컨테이너는 변환한다", () => {
    const v = needsMp4Normalize({ ...webReady, formatName: "mxf" });
    assert.equal(v.needed, true);
    assert.match(v.reasons.join(" "), /컨테이너 mxf/);
  });

  it("방송 코덱(MPEG-2·DNxHD·ProRes)은 변환한다", () => {
    for (const codec of ["mpeg2video", "dnxhd", "prores"]) {
      assert.equal(needsMp4Normalize({ ...webReady, formatName: "mxf", codec }).needed, true, codec);
    }
  });

  it("PCM 오디오는 변환한다 — mp4 로 copy 가 안 된다", () => {
    const v = needsMp4Normalize({ ...webReady, audioCodec: "pcm_s24le" });
    assert.equal(v.needed, true);
    assert.match(v.reasons.join(" "), /오디오 pcm_s24le/);
  });

  it("오디오 트랙이 여럿이면 변환한다 — 안 하면 첫 트랙(모노 반쪽)만 나간다", () => {
    const v = needsMp4Normalize({ ...webReady, audioStreams: 8 });
    assert.equal(v.needed, true);
    assert.match(v.reasons.join(" "), /오디오 트랙 8개/);
  });

  it("인터레이스(1080i)는 변환한다 — 빗살무늬가 결과물에 박힌다", () => {
    const v = needsMp4Normalize({ ...webReady, interlaced: true });
    assert.equal(v.needed, true);
    assert.match(v.reasons.join(" "), /인터레이스/);
  });

  it("무음 영상도 판정이 성립한다 — 오디오 코덱 없음을 이유로 삼지 않는다", () => {
    const v = needsMp4Normalize({ ...webReady, hasAudio: false, audioCodec: "", audioStreams: 0 });
    assert.equal(v.needed, false);
  });

  it("hevc 는 변환한다 — 브라우저·플랫폼 지원이 갈린다", () => {
    assert.equal(needsMp4Normalize({ ...webReady, codec: "hevc" }).needed, true);
  });
});

describe("오디오 트랙 접기 (audioMapArgs)", () => {
  it("단일 트랙은 그대로 스테레오로", () => {
    assert.deepEqual(audioMapArgs({ hasAudio: true, audioStreams: 1, audioChannels: 2 }),
      ["-map", "0:a:0", "-ac", "2"]);
  });

  it("모노 여러 트랙은 앞의 둘을 L/R 로 합친다 — 방송 표준(1=L·2=R)", () => {
    const args = audioMapArgs({ hasAudio: true, audioStreams: 8, audioChannels: 1 });
    assert.deepEqual(args,
      ["-filter_complex", "[0:a:0][0:a:1]amerge=inputs=2[aout]", "-map", "[aout]", "-ac", "2"]);
  });

  it("첫 트랙이 스테레오면 그 트랙만 쓴다 — 나머지는 M&E·예비다", () => {
    assert.deepEqual(audioMapArgs({ hasAudio: true, audioStreams: 4, audioChannels: 2 }),
      ["-map", "0:a:0", "-ac", "2"]);
  });

  it("오디오가 없으면 -an — 무음 영상도 변환은 된다", () => {
    assert.deepEqual(audioMapArgs({ hasAudio: false, audioStreams: 0, audioChannels: 0 }), ["-an"]);
  });
});

describe("변환 명령의 불변식 (소스 스캔)", () => {
  const src = read("ffmpeg.ts");

  it("인터레이스일 때만 yadif — progressive 에 걸면 디테일이 깎인다", () => {
    assert.match(src, /if \(p\.interlaced\) vf\.push\("yadif=0:-1:0"\);/);
  });

  it("1080p 상한 · 짝수 해상도 보정 · yuv420p — 플랫폼이 받는 모양으로 고정", () => {
    assert.equal(NORMALIZE_MAX_HEIGHT, 1080);
    assert.match(src, /scale=-2:\$\{NORMALIZE_MAX_HEIGHT\}/);
    assert.match(src, /"-pix_fmt", "yuv420p"/);
    assert.match(src, /\+faststart/);
  });

  it("길이에 비례한 타임아웃 — 60분 트랜스코드가 기본 5분에 잘리면 안 된다", () => {
    assert.match(src, /Math\.round\(p\.durationSec \* 3\) \* 1000/);
  });
});

describe("워커 배선 (소스 스캔)", () => {
  const src = read("worker.ts");

  it("프로브 → 판정 → 변환 순서 · 서명 URL 을 입력으로 준다(원본을 RAM 에 안 받는다)", () => {
    assert.match(src, /const normalize = needsMp4Normalize\(meta\);/);
    assert.match(src, /await normalizeToMp4\(readUrl, mp4Tmp, \{ probe: meta \}\)/,
      "로컬 파일을 입력으로 쓰면 20~50GB 를 tmpfs(RAM) 에 내려받게 된다");
  });

  it("원본을 덮어쓰지 않는다 — 확장자만 바꾼 **새 경로**에 올린다", () => {
    assert.match(src, /const mp4ObjectPath = objectPath\.replace\(\/\\\.\[\^\.\/\]\+\$\/, ""\) \+ "\.mp4";/,
      "원본 경로에 덮어쓰면 방송사 소재가 사라진다");
    assert.match(src, /uploadFile\(mp4ObjectPath, mp4Tmp\)/);
  });

  it("변환 뒤 메타를 다시 잡고, DB 는 변환본을 가리킨다", () => {
    assert.match(src, /meta = await probe\(readUrl\);[\s\S]{0,200}normalized probe returned duration/);
    assert.match(src, /path: storedMediaPath,/);
    assert.match(src, /mime: mediaMime,/);
  });

  it("이미 mp4 인 파일은 종전 경로(작으면 faststart 리먹스) 그대로", () => {
    assert.match(src, /REMUX_MAX_MB/);
    assert.match(src, /remuxFaststart\(readUrl, webTmp\)/);
  });
});
