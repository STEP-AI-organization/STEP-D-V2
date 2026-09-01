import assert from "node:assert/strict";
import test from "node:test";

import { isNativeUploadRequest } from "./contract.js";
import { uploadContentType } from "./mime.js";
import { parseCommittedOffset } from "./transfer-network.js";

test("native upload request validates both supported kinds", () => {
  assert.equal(isNativeUploadRequest({
    kind: "episode",
    programId: "p1",
    title: "12화",
    episodeNumber: 12,
    broadDate: "2026-09-01",
    track: "variety",
    hasSubtitle: true,
    fast: false,
  }), true);
  assert.equal(isNativeUploadRequest({
    kind: "finished_clip",
    programId: "p1",
    title: "완성본",
    editKind: "shorts",
  }), true);
  assert.equal(isNativeUploadRequest({ kind: "episode", programId: "p1", episodeNumber: 0 }), false);
});

test("broadcast containers keep their real content type", () => {
  assert.equal(uploadContentType("D:\\master\\episode.MXF"), "application/mxf");
  assert.equal(uploadContentType("D:\\master\\episode.mov"), "video/quicktime");
  assert.equal(uploadContentType("D:\\master\\episode.mp4"), "video/mp4");
});

test("GCS committed offsets follow 308 Range semantics", () => {
  assert.equal(parseCommittedOffset(308, undefined, 100), 0);
  assert.equal(parseCommittedOffset(308, "bytes=0-63", 100), 64);
  assert.equal(parseCommittedOffset(200, undefined, 100), 100);
  assert.equal(parseCommittedOffset(500, undefined, 100), null);
});
