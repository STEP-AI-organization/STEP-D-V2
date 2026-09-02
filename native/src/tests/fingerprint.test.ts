import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fingerprintFile, fingerprintsMatch } from "../transfer/fingerprint.js";

test("file fingerprint detects replacement with the same byte length", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stepd-native-fingerprint-"));
  assert.ok(directory.startsWith(os.tmpdir()));
  try {
    const file = path.join(directory, "video.mp4");
    await writeFile(file, Buffer.alloc(4096, 1));
    const before = await fingerprintFile(file);
    await writeFile(file, Buffer.alloc(4096, 2));
    const after = await fingerprintFile(file);
    assert.equal(before.size, after.size);
    assert.equal(fingerprintsMatch(before, after), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
