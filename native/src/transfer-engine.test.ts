import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { NativeUploadJob } from "./contract.js";
import { fingerprintFile } from "./fingerprint.js";
import { JobStore, type SecretCodec, type StoredUploadJob } from "./job-store.js";
import type { ApiResult, ChunkInput, HttpResult, TransferNetwork } from "./transfer-network.js";
import { TransferEngine, scrubPaths } from "./transfer-engine.js";

const codec: SecretCodec = {
  async encrypt(value) { return Buffer.from(value).toString("base64"); },
  async decrypt(value) { return Buffer.from(value, "base64").toString(); },
};

class FakeNetwork implements TransferNetwork {
  committed = 0;
  starts: number[] = [];
  initCount = 0;
  /** 켜면 finalize 가 실패한다. 422 를 쓰는 이유는 아래 테스트 주석 참고. */
  failFinalize = false;
  finalizeCalls = 0;

  async api<T>(route: string): Promise<ApiResult<T>> {
    if (route === "/media/upload-init") {
      this.initCount += 1;
      return this.result(200, {
        mode: "resumable",
        mediaId: "m-test",
        objectPath: "uploads/m-test.mp4",
        sessionUrl: "https://storage.test/session",
      } as T);
    }
    if (route === "/media/finalize") {
      this.finalizeCalls += 1;
      if (this.failFinalize) return this.result(422, { error: "finalize_failed" } as T);
      return this.result(202, { episode: { id: "e-test" } } as T);
    }
    return this.result(200, { clip: { id: "c-test" } } as T);
  }

  async queryOffset(_url: string, total: number): Promise<HttpResult> {
    if (this.committed >= total) return { status: 200, headers: {}, body: "" };
    return {
      status: 308,
      headers: this.committed > 0 ? { range: `bytes=0-${this.committed - 1}` } : {},
      body: "",
    };
  }

  async putChunk(input: ChunkInput): Promise<HttpResult> {
    this.starts.push(input.start);
    const length = input.endInclusive - input.start + 1;
    input.onProgress(length);
    this.committed = input.total;
    return { status: 200, headers: {}, body: "" };
  }

  async cancelSession(): Promise<void> {}

  private result<T>(status: number, json: T): ApiResult<T> {
    return { status, headers: {}, body: JSON.stringify(json), json };
  }
}

async function waitFor(engine: TransferEngine, predicate: (jobs: NativeUploadJob[]) => boolean): Promise<NativeUploadJob[]> {
  // ⚠️ 3초였다가 15초로 올렸다(2026-09-01). 잡 저장이 매번 **fsync** 를 하도록 바꾼 뒤로
  // 실제 디스크 왕복이 생겼고, `pnpm check` 는 서버 테스트 1300여 개와 **동시에** 돈다 —
  // 그 부하에서 3초를 넘겨 이 파일만 간헐적으로 빨갛게 됐다. 관문이 흔들리면 사람이
  // 무시하게 되므로, 여유는 넉넉히 두고 실패는 진짜 실패일 때만 나게 한다.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const jobs = engine.list();
    if (predicate(jobs)) return jobs;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for jobs: ${JSON.stringify(engine.list())}`);
}

test("episode upload initializes, transfers, finalizes, and persists the result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stepd-native-engine-"));
  assert.ok(directory.startsWith(os.tmpdir()));
  try {
    const file = path.join(directory, "episode.mp4");
    await writeFile(file, Buffer.alloc(4096, 7));
    const network = new FakeNetwork();
    const store = new JobStore(path.join(directory, "jobs"), codec);
    const engine = new TransferEngine(store, network);
    await engine.init();
    await engine.enqueue(file, {
      kind: "episode",
      programId: "p1",
      title: "1화",
      episodeNumber: 1,
      broadDate: "2026-09-01",
      track: "variety",
      hasSubtitle: true,
      fast: false,
    });
    const jobs = await waitFor(engine, (all) => all[0]?.status === "completed");
    assert.equal(jobs[0].progress, 100);
    assert.equal(jobs[0].result?.episodeId, "e-test");
    assert.deepEqual(network.starts, [0]);
    assert.equal(network.initCount, 1);
    await engine.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a restored job asks GCS for its committed offset before resuming", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stepd-native-resume-"));
  assert.ok(directory.startsWith(os.tmpdir()));
  try {
    const file = path.join(directory, "episode.mp4");
    await writeFile(file, Buffer.alloc(4096, 9));
    const store = new JobStore(path.join(directory, "jobs"), codec);
    const fingerprint = await fingerprintFile(file);
    const timestamp = new Date().toISOString();
    const restored: StoredUploadJob = {
      id: "resume-job-1",
      kind: "episode",
      filename: "episode.mp4",
      size: fingerprint.size,
      uploadedBytes: 0,
      progress: 0,
      status: "uploading",
      createdAt: timestamp,
      updatedAt: timestamp,
      request: {
        kind: "episode", programId: "p1", title: "1화", episodeNumber: 1,
        broadDate: "2026-09-01", track: "variety", hasSubtitle: true, fast: false,
      },
      filePath: file,
      fingerprint,
      contentType: "video/mp4",
      mediaId: "m-test",
      objectPath: "uploads/m-test.mp4",
      encryptedSessionUrl: await codec.encrypt("https://storage.test/session"),
      sessionCreatedAt: timestamp,
    };
    await store.save(restored);
    const network = new FakeNetwork();
    network.committed = 2048;
    const engine = new TransferEngine(store, network);
    await engine.init();
    await waitFor(engine, (all) => all[0]?.status === "completed");
    assert.deepEqual(network.starts, [2048]);
    assert.equal(network.initCount, 0);
    await engine.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * ⚠️ **바이트가 GCS 에 올라간 뒤 finalize 가 실패하면, 그건 "끝난 작업" 이 아니다.**
 *
 * 예전엔 FINALIZE 오류가 `failed` 로 떨어졌고 `hasUnfinishedJobs()` 가 `failed` 를 제외해서,
 * 트레이에 숨어 있던 앱이 "전송을 모두 마쳤습니다" 알림을 띄우고 스스로 종료하며 자동 기동
 * 등록까지 해제했다. 10GB 는 GCS 에 있고 회차 행은 없는데 아무도 재시도하지 않는 상태 —
 * 사람이 앱을 직접 열기 전까지 영상이 사라진 것과 같다.
 *
 * 프록시 502(Vercel thaw 후 ECONNRESET)·Cloud Run 콜드스타트는 이 리포에서 상시 재발하는
 * 일시 장애이고, 서버 finalize 는 멱등이라 **한 번만 더 부르면 복구된다.**
 */
test("finalize 가 실패해도 '끝난 작업' 이 아니다 — 앱이 종료·자동기동 해제를 하면 안 된다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stepd-native-finalize-"));
  try {
    const file = path.join(directory, "episode.mp4");
    await writeFile(file, Buffer.alloc(4096, 3));
    const network = new FakeNetwork();
    // 실제로 자주 나는 건 프록시 502·Cloud Run 콜드스타트 5xx 인데, 그건 재시도 대상이라
    // 백오프가 ~17초다(MAX_RETRIES 6 · 600ms 배증). **버그는 재시도가 아니라 그 뒤의 분류**라,
    // 즉시 반환되는 4xx 로 같은 분기(TransferError("FINALIZE"))를 태워 빠르게 검증한다.
    network.failFinalize = true;
    const engine = new TransferEngine(new JobStore(path.join(directory, "jobs"), codec), network);
    await engine.init();
    await engine.enqueue(file, {
      kind: "episode", programId: "p1", title: "1화", episodeNumber: 1,
      broadDate: "2026-09-01", track: "variety", hasSubtitle: true, fast: false,
    });
    const jobs = await waitFor(engine, (all) => all[0]?.status === "needs_attention" || all[0]?.status === "failed");
    assert.equal(jobs[0].status, "needs_attention", "failed 로 떨어지면 재시도 대상에서 빠진다");
    assert.equal(jobs[0].errorCode, "FINALIZE");
    assert.equal(engine.hasUnfinishedJobs(), true,
      "바이트가 GCS 에 있는데 '끝났다' 고 세면 앱이 조용히 종료하고 영상이 사라진다");
    await engine.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * ⚠️ finalize 만 남은 작업은 **로컬 원본을 다시 보지 않는다.**
 * 업로드가 끝난 걸 보고 원본을 아카이브로 옮긴 편집자가 있으면 FILE_MISSING 이 되고,
 * '파일 다시 찾기' 는 mtime 이 달라졌다는 이유로 GCS 세션을 지우고 0바이트부터 다시 올린다 —
 * finalize 한 번이면 끝날 일에 10GB 를 다시 태운다.
 */
test("바이트가 다 올라간 작업은 원본이 없어도 finalize 로 복구된다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stepd-native-finonly-"));
  try {
    const file = path.join(directory, "episode.mp4");
    await writeFile(file, Buffer.alloc(4096, 5));
    const fingerprint = await fingerprintFile(file);
    const store = new JobStore(path.join(directory, "jobs"), codec);
    const stamp = new Date().toISOString();
    const landed: StoredUploadJob = {
      id: "finalize-only-1",
      kind: "episode",
      filename: "episode.mp4",
      contentType: "video/mp4",
      size: fingerprint.size,
      uploadedBytes: fingerprint.size,   // 전송은 끝났다
      progress: 100,
      status: "needs_attention",
      errorCode: "FINALIZE",
      createdAt: stamp,
      updatedAt: stamp,
      filePath: file,
      fingerprint,
      mediaId: "m-test",
      objectPath: "uploads/m-test.mp4",
      bytesComplete: true,                // GCS 가 객체를 다 받았다고 확인해 준 상태
      request: {
        kind: "episode", programId: "p1", title: "1화", episodeNumber: 1,
        broadDate: "2026-09-01", track: "variety", hasSubtitle: true, fast: false,
      },
    };
    await store.save(landed);
    await rm(file, { force: true });          // 편집자가 원본을 아카이브로 옮겼다

    const network = new FakeNetwork();
    const engine = new TransferEngine(store, network);
    await engine.init();
    const jobs = await waitFor(engine, (all) => ["completed", "needs_attention", "failed"].includes(all[0]?.status ?? ""));
    assert.equal(jobs[0].status, "completed", "원본이 없다고 FILE_MISSING 이 되면 10GB 를 다시 올리게 된다");
    assert.equal(jobs[0].result?.episodeId, "e-test");
    assert.deepEqual(network.starts, [], "바이트를 다시 올리면 안 된다");
    await engine.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * 진행률은 **디스크에서 읽어 소켓에 써 넣은 바이트**라 GCS 가 커밋하기 전에 이미 size 에
 * 닿는다. 그 순간 회선이 끊기면 예외 경로가 부풀려진 값을 저장하는데, 이때 재기동이
 * "다 올라갔다" 고 오판하면 업로드를 건너뛰고 finalize 만 무한 반복한다 — GCS 에 객체가
 * 없으니 서버는 영원히 400 을 주고, 남은 바이트는 **영원히 전송되지 않는다.**
 * 탈출구가 취소 후 전량 재업로드뿐이라 10GB 짜리에선 그대로 손실이다.
 */
test("uploadedBytes 가 size 여도 GCS 확인이 없으면 다시 올린다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stepd-native-optimistic-"));
  try {
    const file = path.join(directory, "episode.mp4");
    await writeFile(file, Buffer.alloc(4096, 7));
    const fingerprint = await fingerprintFile(file);
    const store = new JobStore(path.join(directory, "jobs"), codec);
    const stamp = new Date().toISOString();
    await store.save({
      id: "optimistic-1",
      kind: "episode",
      filename: "episode.mp4",
      contentType: "video/mp4",
      size: fingerprint.size,
      uploadedBytes: fingerprint.size,   // ⚠️ 소켓에 써 넣기만 한 값 — GCS 는 아직 아무것도 커밋 안 했다
      progress: 100,
      status: "needs_attention",
      errorCode: "NETWORK",
      createdAt: stamp,
      updatedAt: stamp,
      filePath: file,
      fingerprint,
      mediaId: "m-test",
      objectPath: "uploads/m-test.mp4",
      // bytesComplete 없음 = 확인된 적 없음
      request: {
        kind: "episode", programId: "p1", title: "1화", episodeNumber: 1,
        broadDate: "2026-09-01", track: "variety", hasSubtitle: true, fast: false,
      },
    } as StoredUploadJob);

    const network = new FakeNetwork();   // committed = 0 — GCS 에는 아무것도 없다
    const engine = new TransferEngine(store, network);
    await engine.init();
    const jobs = await waitFor(engine, (all) => ["completed", "needs_attention", "failed"].includes(all[0]?.status ?? ""));

    assert.deepEqual(network.starts, [0], "확인 안 된 바이트는 0부터 다시 올려야 한다");
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].result?.episodeId, "e-test");
    await engine.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * 웹은 원격 콘텐츠다 — **로컬 경로를 돌려주지 않는다**는 규칙은 `getPathForFile` 반환값뿐
 * 아니라 오류 메시지에도 적용된다. Node 의 fs 오류는 메시지에 전체 경로를 담는다.
 */
test("오류 문구에서 로컬 경로를 지우고 파일명만 남긴다", () => {
  const B = String.fromCharCode(92);
  const win = `ENOENT: no such file or directory, open '${"C:" + B + "Users" + B + "hkj" + B + "Videos" + B}master.mxf'`;
  const unc = `EBUSY: resource busy, open "${B + B}nas01${B}share${B}2026${B}ep12.mxf"`;
  const posix = "EACCES: permission denied, open '/home/hkj/media/ep01.mxf'";

  for (const [label, message] of [["win", win], ["unc", unc], ["posix", posix]] as const) {
    const out = scrubPaths(message);
    assert.ok(!out.includes("Users") && !out.includes("nas01") && !out.includes("/home/"),
      `${label}: 경로가 남았다 — ${out}`);
    assert.match(out, /\.mxf/, `${label}: 파일명까지 지우면 어느 파일인지 알 수 없다`);
  }
  assert.equal(scrubPaths("네트워크 오류"), "네트워크 오류", "경로가 없으면 문구를 바꾸지 않는다");
});
