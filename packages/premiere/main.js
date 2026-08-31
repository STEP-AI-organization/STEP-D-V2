/**
 * STEP-D 프리미어 패널 — 첫 기능: **렌더한 완성본을 STEP-D 로 올린다.**
 *
 * 왜 이것부터인가: 편집자는 하루 두 번 렌더 결과를 STEP-D 에 올려야 하는데, 지금은
 * 프리미어를 나가 브라우저를 열고 파일을 찾아 끌어다 놓는다. 그 왕복을 없애는 게 이 패널의
 * 첫 값이다. 추천 마커·시퀀스 조작은 다음 단계다(docs/plans/active/premiere-plugin-plan.md).
 *
 * 서버 API 는 하나도 새로 만들지 않는다 — 웹이 쓰는 길을 그대로 탄다:
 *   POST /api/media/upload-init  → GCS resumable 세션
 *   PUT  sessionUrl              → 청크 업로드 (308 이어받기)
 *   POST /api/media/clip-finalize→ 배포 가능한 클립
 *
 * ⚠️ UXP 는 브라우저가 아니다. 두 가지가 다르고, 그 둘이 이 파일 구조를 정한다:
 *   1. **쿠키 저장소가 없다.** fetch 가 Set-Cookie 를 보관·재전송하지 않는다 →
 *      세션을 `x-stepd-session` 헤더로 직접 싣는다(서버 index.ts `sessionToken`).
 *   2. **File 객체·Blob slice 가 웹과 다르다.** 그래서 파일을 직접 읽어 청크를 만든다.
 */

const uxp = require("uxp");
const localFs = uxp.storage.localFileSystem;
const formats = uxp.storage.formats;

const CLIENT = "premiere/0.1.0";
const DEFAULT_API_BASE = "https://stepd.stepai.kr/api/proxy/api";

/** 청크 크기 — 웹(api.ts)과 같은 8MB. 크게 잡으면 재시도 때 버리는 양이 커진다. */
const CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_RETRIES = 5;

// ── 저장소 ────────────────────────────────────────────────────────────────────
// 자동 재인증(사용자 요구 2026-08-28: "세션 만료되면 자동으로 인증 · 재로그인해서 다시 세션
// 리프레시")을 하려면 자격증명을 패널이 들고 있어야 한다. UXP secureStorage 는 OS 키체인
// (Windows DPAPI / macOS Keychain)에 암호화해 넣는다 — 평문 파일로는 절대 두지 않는다.
const secure = uxp.storage.secureStorage;

const store = {
  async set(key, value) {
    try {
      await secure.setItem(key, value);
      return true;
    } catch (_) {
      return false;
    }
  },
  async get(key) {
    try {
      const raw = await secure.getItem(key);
      if (!raw) return null;
      // secureStorage 는 Uint8Array 로 돌려준다(문자열로 넣었어도).
      return typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    } catch (_) {
      return null;
    }
  },
  async remove(key) {
    try {
      await secure.removeItem(key);
    } catch (_) {
      /* 없으면 그만 */
    }
  },
};

// ── 세션 ──────────────────────────────────────────────────────────────────────
/**
 * 세션은 서버 TTL 이 지나면 죽는다. 편집자가 렌더 한 번에 수십 분을 쓰는 도구라 "업로드를
 * 누르니 401" 이 흔하다 — 그때 로그인 화면으로 되돌리지 않고 **저장된 자격증명으로 조용히
 * 다시 로그인해 토큰을 갈아끼우고, 하던 요청을 그대로 재시도한다.**
 */
const session = {
  token: null,
  email: null,
  password: null,
  user: null,

  async restore() {
    this.email = await store.get("stepd.email");
    this.password = await store.get("stepd.password");
    this.token = await store.get("stepd.token");
    if (!this.email || !this.password) return false;
    // 토큰이 있으면 그걸 먼저 써 본다(로그인 왕복 절약). 죽었으면 api() 가 알아서 갱신한다.
    if (this.token) return true;
    return this.login(this.email, this.password).then(() => true).catch(() => false);
  },

  async login(email, password) {
    const res = await fetch(`${apiBase()}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-stepd-client": CLIENT },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 서버가 이유를 구분해 준다 — 비밀번호 오류인지 회사 정지인지 그대로 보여 준다.
      const msg = data.message || (data.error === "invalid_credentials"
        ? "이메일 또는 비밀번호가 올바르지 않습니다."
        : data.error || `로그인 실패 (${res.status})`);
      throw new Error(msg);
    }
    if (!data.token) throw new Error("서버가 세션 토큰을 주지 않았습니다 — 서버 배포본을 확인하세요.");

    this.token = data.token;
    this.email = email;
    this.password = password;
    this.user = data.user || null;
    await store.set("stepd.token", data.token);
    await store.set("stepd.email", email);
    await store.set("stepd.password", password);
    return data.user;
  },

  /** 만료 감지 시 호출. 자격증명이 없으면(=수동 로그아웃 후) 되살릴 수 없다. */
  async refresh() {
    if (!this.email || !this.password) return false;
    try {
      await this.login(this.email, this.password);
      return true;
    } catch (_) {
      return false;
    }
  },

  async clear() {
    this.token = null;
    this.password = null;
    this.user = null;
    await store.remove("stepd.token");
    await store.remove("stepd.password");
  },
};

function apiBase() {
  return DEFAULT_API_BASE;
}

/**
 * 인증이 붙은 요청 한 번. **401 이면 한 번만** 재로그인하고 같은 요청을 재시도한다.
 * (무한 재시도 금지 — 비밀번호가 바뀐 경우 로그인도 401 이라 루프가 된다)
 */
async function api(path, init = {}, allowRetry = true) {
  const headers = Object.assign({ "x-stepd-client": CLIENT }, init.headers || {});
  if (session.token) headers["x-stepd-session"] = session.token;
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";

  const res = await fetch(`${apiBase()}${path}`, Object.assign({}, init, { headers }));

  if (res.status === 401 && allowRetry) {
    const ok = await session.refresh();
    if (ok) return api(path, init, false);
  }
  return res;
}

async function apiJson(path, init) {
  const res = await api(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `요청 실패 (${res.status})`);
  return data;
}

// ── 파일 읽기 ─────────────────────────────────────────────────────────────────
/**
 * 완성본은 수 GB 다. 통째로 메모리에 올리면 프리미어까지 같이 느려지므로 **부분 읽기**를
 * 먼저 시도하고(UXP fs 모듈), 안 되는 버전에서만 전체 읽기로 물러난다.
 */
function makeReader(entry, nativePath, size) {
  let nodeFs = null;
  let fd = null;
  try {
    nodeFs = require("fs");
    if (nodeFs && typeof nodeFs.openSync === "function" && typeof nodeFs.readSync === "function") {
      fd = nodeFs.openSync(nativePath, "r");
      // **열자마자 한 번 실제로 읽어 본다.** UXP 버전마다 fs 구현이 조금씩 달라서, 여는 데
      // 성공하고 readSync 에서 처음 터지는 경우가 있다. 그걸 업로드 중간에 만나면 5회
      // 재시도를 다 태우고 파일을 통째로 실패시킨다 — 여기서 미리 확인하고 물러난다.
      nodeFs.readSync(fd, new Uint8Array(Math.min(16, Math.max(1, size))), 0, Math.min(16, Math.max(1, size)), 0);
    } else {
      nodeFs = null;
    }
  } catch (_) {
    if (fd !== null && nodeFs) { try { nodeFs.closeSync(fd); } catch (__) { /* 무시 */ } }
    nodeFs = null;
    fd = null;
  }

  if (nodeFs && fd !== null) {
    return {
      mode: "chunked",
      async slice(start, end) {
        const len = end - start;
        const buf = new Uint8Array(len);
        nodeFs.readSync(fd, buf, 0, len, start);
        return buf.buffer;
      },
      close() {
        try { nodeFs.closeSync(fd); } catch (_) { /* 이미 닫힘 */ }
      },
    };
  }

  // 폴백: 한 번에 다 읽는다. 큰 파일에서는 메모리를 먹지만, 못 올리는 것보다는 낫다.
  let whole = null;
  return {
    mode: "whole",
    async slice(start, end) {
      if (!whole) whole = await entry.read({ format: formats.binary });
      return whole.slice(start, end);
    },
    close() {
      whole = null;
    },
  };
}

// ── GCS resumable 업로드 ──────────────────────────────────────────────────────
/**
 * XHR 로 보낸다 — fetch 는 308(Resume Incomplete)을 리다이렉트로 삼켜 이어받기 위치를 못
 * 읽는다. 웹(api.ts putChunk)이 같은 이유로 XHR 을 쓴다.
 */
function putChunk(sessionUrl, buffer, start, endInclusive, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${endInclusive}/${total}`);
    xhr.onload = () => resolve({
      status: xhr.status,
      range: xhr.getResponseHeader("Range"),
      body: xhr.responseText,
    });
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(buffer);
  });
}

/** GCS 가 어디까지 받았는지 되묻는다 — 끊긴 자리에서 이어 올리기 위한 기준점. */
function queryCommitted(sessionUrl, total) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Content-Range", `bytes */${total}`);
    xhr.onload = () => {
      if (xhr.status === 308) {
        const end = parseRangeEnd(xhr.getResponseHeader("Range"));
        resolve(end !== null ? end + 1 : 0);
      } else if (xhr.status === 200 || xhr.status === 201) resolve(total);
      else resolve(null);
    };
    xhr.onerror = () => resolve(null);
    xhr.send();
  });
}

function parseRangeEnd(range) {
  if (!range) return null;
  const m = /bytes=\d+-(\d+)/.exec(range);
  return m ? Number(m[1]) : null;
}

async function uploadResumable(sessionUrl, reader, total, onProgress) {
  let offset = 0;
  while (offset < total) {
    let end = Math.min(offset + CHUNK_SIZE, total);
    let res = null;
    let lastErr = null;

    for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
      end = Math.min(offset + CHUNK_SIZE, total);
      try {
        const buf = await reader.slice(offset, end);
        res = await putChunk(sessionUrl, buf, offset, end - 1, total);
        break;
      } catch (err) {
        lastErr = err;
        // 끊긴 뒤엔 우리 offset 이 아니라 **GCS 가 받은 위치**가 진실이다.
        const committed = await queryCommitted(sessionUrl, total);
        if (committed !== null && committed > offset) {
          offset = committed;
          if (offset >= total) return;
        }
        if (attempt < CHUNK_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, Math.min(8000, 600 * 2 ** attempt)));
        }
      }
    }
    if (!res) throw new Error(`업로드 실패 (재시도 소진): ${lastErr ? lastErr.message : "알 수 없음"}`);

    if (res.status === 200 || res.status === 201) {
      offset = total;
    } else if (res.status === 308) {
      const next = parseRangeEnd(res.range);
      offset = next !== null ? next + 1 : end;
    } else {
      throw new Error(`업로드 거부됨: ${res.status} ${res.body || ""}`);
    }
    if (onProgress) onProgress(Math.min(99, Math.round((offset / total) * 100)));
  }
  if (onProgress) onProgress(100);
}

// ── 화면 ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const views = {
  login: () => $("loginView"),
  upload: () => $("uploadView"),
};

let picked = null; // { entry, name, size, nativePath }
let busy = false;

function show(which) {
  views.login().className = which === "login" ? "" : "hidden";
  views.upload().className = which === "upload" ? "" : "hidden";
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function setProgress(pct) {
  $("progress").style.width = `${pct}%`;
}

/** 업로드 가능 조건: 파일 O · 프로그램 O · 진행 중 아님. */
function syncUploadButton() {
  $("uploadBtn").disabled = busy || !picked || !$("program").value;
}

async function loadPrograms() {
  const sel = $("program");
  sel.innerHTML = "";
  try {
    const data = await apiJson("/programs");
    const list = (data.programs || []).filter((p) => p.status !== "archived");
    if (!list.length) {
      const opt = document.createElement("option");
      opt.textContent = "등록된 프로그램이 없습니다";
      opt.value = "";
      sel.appendChild(opt);
    }
    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.title;
      sel.appendChild(opt);
    }
    const saved = await store.get("stepd.lastProgram");
    if (saved && list.some((p) => p.id === saved)) sel.value = saved;
  } catch (err) {
    setStatus($("status"), `프로그램 목록을 불러오지 못했습니다: ${err.message}`, "err");
  }
  syncUploadButton();
}

async function doLogin() {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    setStatus($("loginStatus"), "이메일과 비밀번호를 입력하세요.", "err");
    return;
  }
  $("loginBtn").disabled = true;
  setStatus($("loginStatus"), "로그인 중…");
  try {
    await session.login(email, password);
    $("password").value = "";
    setStatus($("loginStatus"), "");
    show("upload");
    await loadPrograms();
    await refreshSequenceLabel();
    startHandoffPolling();
  } catch (err) {
    setStatus($("loginStatus"), err.message, "err");
  } finally {
    $("loginBtn").disabled = false;
  }
}

async function pickFile() {
  try {
    const entry = await localFs.getFileForOpening({
      types: ["mp4", "mov", "m4v", "mxf"],
    });
    if (!entry) return;
    const meta = await entry.getMetadata();
    picked = {
      entry,
      name: entry.name,
      size: Number(meta.size) || 0,
      nativePath: entry.nativePath,
    };
    const box = $("fileBox");
    box.className = "file picked";
    box.textContent = `${picked.name} · ${(picked.size / (1024 * 1024)).toFixed(1)} MB`;
    setStatus($("status"), "");
    setProgress(0);
    syncUploadButton();
  } catch (err) {
    setStatus($("status"), `파일을 열지 못했습니다: ${err.message}`, "err");
  }
}

// ── 프리미어 제어 (내보내기) ──────────────────────────────────────────────────
/**
 * **여기부터가 진짜 플러그인이다.** 위쪽은 프리미어 안에 얹힌 웹 화면일 뿐이지만, 이 절은
 * 프리미어의 프로젝트·시퀀스를 직접 만진다.
 *
 * 사용자가 원하는 동선(2026-08-28): *"편집 끝났으면 원래 내보내기를 누르는데, 그걸 우리
 * 걸로 — 딸깍 누르면 지금 편집창에 떠 있는 그 영상이 렌더돼서 올라가면 좋겠다."*
 * 그래서 **활성 시퀀스 → H.264 렌더 → 그대로 업로드**를 한 버튼에 묶는다.
 * 파일 선택 경로는 폴백으로 남긴다(이미 렌더해 둔 파일, 다른 도구로 만든 완성본).
 *
 * ⚠️ UXP 의 프리미어 API 는 버전마다 이름이 조금씩 다르다. 그래서 **호출을 감싸고, 실패하면
 * 모듈이 실제로 무엇을 갖고 있는지 콘솔에 쏟는다** — 한 번의 실패로 정확한 이름을 알아내려고.
 */
function ppro() {
  try {
    return require("premierepro");
  } catch (_) {
    return null;
  }
}

/** Windows 기본 H.264 프리셋 (실측 2026-08-28 · Media Encoder 2026 동봉). */
const PRESET_PATH =
  "C:\\Program Files\\Adobe\\Adobe Media Encoder 2026\\MediaIO\\systempresets\\4E49434B_48323634\\YouTube 1080p HD.epr";

/** 값이 함수면 부르고, 아니면 그대로 — `name` 이 속성인 버전과 `getName()` 인 버전이 있다. */
async function readMaybe(obj, ...names) {
  for (const n of names) {
    if (!obj || !(n in obj)) continue;
    const v = obj[n];
    return typeof v === "function" ? await v.call(obj) : v;
  }
  return null;
}

async function activeSequence() {
  const api = ppro();
  if (!api) throw new Error("이 프리미어에서는 시퀀스 내보내기를 쓸 수 없습니다 (premierepro 모듈 없음).");
  const project = await readMaybe(api.Project, "getActiveProject");
  if (!project) throw new Error("열려 있는 프로젝트가 없습니다.");
  const sequence = await readMaybe(project, "getActiveSequence");
  if (!sequence) throw new Error("활성 시퀀스가 없습니다 — 타임라인에서 시퀀스를 여세요.");
  const name = (await readMaybe(sequence, "name", "getName")) || "sequence";
  return { api, project, sequence, name: String(name) };
}

/**
 * 내보내기 즉시 실행 상수 — `Constants.ExportType.IMMEDIATELY`(다른 값은 `QUEUE_TO_AME`).
 * 버전에 따라 자리가 달라질 수 있어 후보를 훑는다.
 */
function immediateExportType(api) {
  const c = api.Constants || api;
  const t = c.ExportType || c.EXPORT_TYPE || {};
  const v = t.IMMEDIATELY ?? t.Immediately ?? t.IMMEDIATE ?? t.immediately;
  // ⚠️ **0 으로 폴백하면 안 된다.** 공식 선언(@adobe/premierepro 26.3.0)의 enum 순서가
  //   QUEUE_TO_AME=0 · QUEUE_TO_APP=1 · IMMEDIATELY=2 라, 상수를 못 찾았을 때 0 을 넘기면
  //   "즉시 렌더" 가 아니라 **AME 큐로 보낸다.** 그러면 우리는 나오지도 않을 파일을 기다리다
  //   "렌더 결과 파일이 비어 있습니다" 로 죽는다 — 원인과 증상이 멀어지는 최악의 형태다.
  //   못 찾으면 조용히 틀린 값을 쓰지 말고 그 자리에서 말한다.
  if (v === undefined) {
    throw new Error("내보내기 방식 상수(Constants.ExportType.IMMEDIATELY)를 찾지 못했습니다 — 프리미어 버전을 확인하세요.");
  }
  return v;
}

/** 실패했을 때 "무엇이 있었는지" 를 남긴다 — 다음 시도를 추측이 아니라 사실로 하려고. */
function dumpApi(api, sequence) {
  try {
    console.log("[STEP-D] premierepro keys:", Object.keys(api).join(", "));
    if (api.EncoderManager) console.log("[STEP-D] EncoderManager keys:", Object.keys(api.EncoderManager).join(", "));
    if (api.Constants) console.log("[STEP-D] Constants keys:", Object.keys(api.Constants).join(", "));
    if (sequence) console.log("[STEP-D] sequence keys:", Object.keys(sequence).join(", "));
  } catch (err) {
    console.log("[STEP-D] api dump 실패", err);
  }
}

/**
 * 활성 시퀀스를 임시 폴더에 mp4 로 렌더하고, 그 파일을 업로드 가능한 형태로 돌려준다.
 * 렌더는 프리미어가 직접 한다(AME 큐에 넘기지 않는다) — 큐에 넘기면 언제 끝났는지 알 수 없어
 * "딸깍 한 번에 올라간다" 가 성립하지 않는다. 대신 렌더 동안 프리미어가 바쁘다(내보내기와 같다).
 */
async function exportActiveSequence(onStage) {
  const { api, sequence, name } = await activeSequence();
  onStage(`"${name}" 렌더 준비 중…`);

  const tmp = await localFs.getTemporaryFolder();
  const safe = name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  const outName = `${safe}.mp4`;
  const outPath = `${tmp.nativePath}\\${outName}`;

  const manager = (await readMaybe(api.EncoderManager, "getManager")) || api.EncoderManager;
  if (!manager || typeof manager.exportSequence !== "function") {
    dumpApi(api, sequence);
    throw new Error("내보내기 API 를 찾지 못했습니다 — UDT 디버그 콘솔의 [STEP-D] 로그를 보내 주세요.");
  }

  onStage(`"${name}" 렌더 중… (프리미어가 내보내는 동안 잠시 멈춘 것처럼 보입니다)`);
  try {
    // 서명(Adobe UXP 문서 확인 2026-08-28):
    //   exportSequence(sequence, exportType, outputFile, presetFile, exportFull): Promise<boolean>
    // ⚠️ 마지막 `exportFull` 을 빼면 **작업 영역(work area)만** 나갈 수 있다 — 편집자가
    //    "다 올렸는데 앞 5분만 올라갔다" 를 겪는 자리다. 항상 true(시퀀스 전체).
    // ⚠️ 실패를 예외가 아니라 **false 로** 알린다. 안 보면 0바이트를 업로드하러 간다.
    const ok = await manager.exportSequence(sequence, immediateExportType(api), outPath, PRESET_PATH, true);
    if (ok === false) throw new Error("프리미어가 내보내기를 거부했습니다 (프리셋·디스크 공간 확인)");
  } catch (err) {
    dumpApi(api, sequence);
    throw new Error(`렌더 실패: ${err && err.message ? err.message : err}`);
  }

  const entry = await tmp.getEntry(outName);
  const meta = await entry.getMetadata();
  const size = Number(meta.size) || 0;
  if (!size) throw new Error("렌더 결과 파일이 비어 있습니다 — 프리셋·시퀀스 설정을 확인하세요.");
  return { entry, name: outName, size, nativePath: entry.nativePath || outPath };
}

// ── 추천 구간 (서버 → 프리미어 방향) ──────────────────────────────────────────
/**
 * 여기까지 오면 패널이 "올리는 곳" 에서 "보고 작업하는 곳" 이 된다. 서버가 만든 추천을
 * 프리미어 안에서 보고, 한 줄을 누르면 **플레이헤드가 그 구간으로 간다.**
 *
 * ⚠️ 시간 기준이 둘이라는 걸 잊으면 1프레임씩 어긋난다:
 *   STEP-D `startTime` = **원본 파일 0초 기준 초**
 *   Premiere            = **시퀀스 타임라인 기준**
 * 원본을 통째로 시퀀스에 얹어 편집하는 보통의 경우엔 둘이 같아서 그냥 맞는다. 방송 원본처럼
 * 시작 타임코드가 01:00:00:00 인 소재를 그대로 얹었으면 어긋나므로, 서버가 함께 주는
 * `fps`·`startTimecode` 로 환산해야 한다 — **그건 다음 단계다.** 지금은 "같다" 고 보고
 * 이동하되, 환산이 필요한 회차는 **화면에 그렇다고 적는다**(조용히 틀리지 않게).
 */
const TICKS_PER_SECOND = 254016000000;

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n) => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

/** 플레이헤드를 초 위치로 옮긴다. 이름이 버전마다 달라 후보를 훑고, 없으면 구성을 쏟는다. */
async function seekActiveSequence(sec) {
  const { api, sequence } = await activeSequence();
  let pos = null;
  if (api.TickTime) {
    if (typeof api.TickTime.createWithSeconds === "function") pos = api.TickTime.createWithSeconds(sec);
    else if (typeof api.TickTime.createWithTicks === "function") {
      pos = api.TickTime.createWithTicks(String(Math.round(sec * TICKS_PER_SECOND)));
    }
  }
  if (pos === null) pos = String(Math.round(sec * TICKS_PER_SECOND));

  // 정본은 `setPlayerPosition(TickTime): Promise<boolean>` (Adobe UXP 문서 확인 2026-08-28).
  // 뒤의 둘은 옛 이름 폴백이다.
  for (const m of ["setPlayerPosition", "setPlayheadPosition", "setCurrentPosition"]) {
    if (typeof sequence[m] === "function") {
      const ok = await sequence[m](pos);
      if (ok === false) throw new Error("재생위치를 옮기지 못했습니다 — 시퀀스가 열려 있는지 확인하세요.");
      return;
    }
  }
  dumpApi(api, sequence);
  throw new Error("재생위치 이동 API 를 찾지 못했습니다 — UDT 콘솔의 [STEP-D] 로그를 보내 주세요.");
}

/**
 * 추천 구간을 **시퀀스 마커**로 꽂는다 — 편집자가 마커를 따라가며 자르기만 하면 되게.
 *
 * 공식 선언(@adobe/premierepro 26.3.0) 대조:
 *   `Markers.getMarkers(sequence): Promise<Markers>`
 *   `markers.createAddMarkerAction(Name, markerType?, startTime?, duration?, comments?): Action`
 *   `project.executeTransaction(cb => cb.addAction(action), undoString?): boolean`
 *
 * 마커는 **액션 패턴**이다 — 만들기만 하면 아무 일도 안 일어나고, 트랜잭션에 담아 실행해야
 * 반영된다. 트랜잭션 하나에 다 담는 이유: 편집자가 **Ctrl+Z 한 번으로 전부 되돌릴 수 있다.**
 * 스무 개를 따로 넣으면 스무 번 눌러야 한다.
 */
async function addMarkersForRecs(recs) {
  const { api, project, sequence, name } = await activeSequence();
  if (!api.Markers || typeof api.Markers.getMarkers !== "function") {
    dumpApi(api, sequence);
    throw new Error("마커 API 를 찾지 못했습니다 — UDT 콘솔의 [STEP-D] 로그를 보내 주세요.");
  }
  const markers = await api.Markers.getMarkers(sequence);
  // 코멘트 마커(기본). 상수를 못 찾으면 문자열 폴백 — 여기서 틀려도 마커가 안 생길 뿐,
  // 내보내기처럼 엉뚱한 동작을 하지는 않는다.
  const type = (api.Marker && api.Marker.MARKER_TYPE_COMMENT) || "Comment";

  const ok = project.executeTransaction((compound) => {
    for (const r of recs) {
      const startSec = Number(r.startTime) || 0;
      const durSec = Math.max(0.1, (Number(r.endTime) || 0) - startSec);
      // 마커 이름은 짧게(타임라인에서 잘린다), 자세한 건 코멘트로.
      const label = `[STEP-D] ${r.title || "추천"}`.slice(0, 80);
      const comment = [
        r.score100 === null || r.score100 === undefined ? null : `점수 ${r.score100}`,
        r.people && r.people.length ? `인물 ${r.people.join(", ")}` : null,
        `${fmtTime(startSec)}–${fmtTime(r.endTime)}`,
        `STEP-D ${r.id}`,   // 어느 추천에서 나온 마커인지 — 나중에 되짚을 유일한 끈이다
      ].filter(Boolean).join(" · ");
      compound.addAction(markers.createAddMarkerAction(
        label, type,
        api.TickTime.createWithSeconds(startSec),
        api.TickTime.createWithSeconds(durSec),
        comment,
      ));
    }
  }, `STEP-D 추천 마커 ${recs.length}개`);

  if (ok === false) throw new Error("마커를 넣지 못했습니다 — 시퀀스가 잠겨 있는지 확인하세요.");
  return { sequenceName: name, count: recs.length };
}

async function doAddMarkers() {
  if (busy || !recRows.length) return;
  busy = true;
  $("markersBtn").disabled = true;
  try {
    setStatus($("recsStatus"), "마커 넣는 중…");
    const { sequenceName, count } = await addMarkersForRecs(recRows);
    setStatus($("recsStatus"),
      `"${sequenceName}" 에 마커 ${count}개를 넣었습니다. 되돌리려면 Ctrl+Z 한 번.`, "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 마커 실패", err);
  } finally {
    busy = false;
    $("markersBtn").disabled = !recRows.length;
  }
}

// ── 추천 → 서브클립 (프로젝트 패널에 잘라 놓기) ───────────────────────────────
/**
 * 마커는 "여기가 좋다" 까지다. 서브클립은 **이미 잘라 놓은 조각**을 준다 — 편집자는 끌어다
 * 놓기만 하면 된다. 러프컷 시퀀스 조립은 다음 단계이고, 그 재료가 이 서브클립들이다.
 *
 * 공식 선언(@adobe/premierepro 26.3.0) 대조:
 *   `FolderItem.getItems(): Promise<ProjectItem[]>` · `ProjectItem.name`(읽기 전용)
 *   `ClipProjectItem.cast(projectItem)` · `getMediaFilePath(): Promise<string>`
 *   `createSubClipAction(name, startTime, endTime, hasHardBoundaries, options?): Action`
 *
 * ⚠️ `createSubClipAction` 은 **지연 액션**이라 만들어진 항목을 돌려주지 않는다. 그래서
 *    이름을 정해진 규칙(`[STEP-D] …`)으로 붙인다 — 다음 단계(시퀀스 조립)가 그 이름으로 찾는다.
 */
/**
 * 서브클립 이름 규칙 — **한 곳에서만 만든다.** 러프컷이 이 이름으로 조각을 되찾으므로,
 * 두 곳에서 각자 만들면 규칙이 갈라지는 순간 조립이 조용히 빈 시퀀스를 낳는다.
 * 끝에 추천 id 를 두는 것이 계약이다(endsWith 로 찾는다).
 */
function subclipName(r) {
  return `[STEP-D] ${String(r.title || "추천").slice(0, 40)} · ${r.id}`;
}

async function findMasterItem(filename) {
  const { api, project } = await activeSequence();
  if (!filename) throw new Error("이 추천에 연결된 원본 파일 정보가 없습니다.");
  const root = await project.getRootItem();
  const wanted = String(filename).toLowerCase();

  // 빈을 넓이 우선으로 훑는다. 프로젝트가 큰 경우를 대비해 방문 수를 막아 둔다 —
  // 못 찾는 것보다 나쁜 건 패널이 멈춘 것처럼 보이는 것이다.
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < 2000) {
    const folder = queue.shift();
    let items = [];
    try { items = await folder.getItems(); } catch (_) { continue; }
    for (const item of items) {
      visited += 1;
      // 폴더면 큐에 넣는다(FolderItem.cast 가 실패하면 폴더가 아니다).
      try {
        const asFolder = api.FolderItem && api.FolderItem.cast ? api.FolderItem.cast(item) : null;
        if (asFolder && typeof asFolder.getItems === "function") { queue.push(asFolder); continue; }
      } catch (_) { /* 폴더 아님 — 아래에서 클립으로 본다 */ }

      try {
        const clip = api.ClipProjectItem.cast(item);
        if (!clip || typeof clip.getMediaFilePath !== "function") continue;
        const p = String((await clip.getMediaFilePath()) || "").toLowerCase();
        // 경로 전체가 아니라 **파일명으로** 맞춘다 — NAS·로컬 경로가 PC 마다 다르다.
        if (p && (p.endsWith(`\\${wanted}`) || p.endsWith(`/${wanted}`) || p.includes(wanted))) {
          return { api, project, clip, name: item.name };
        }
      } catch (_) { /* 클립 아님 */ }
    }
  }
  throw new Error(`프로젝트에서 원본을 찾지 못했습니다 (${filename}) — 먼저 프리미어로 가져오세요.`);
}

// ── 원본이 이 PC 에 없을 때 — 받아서 프로젝트에 넣는다 ────────────────────────
/**
 * 편집자 PC 에 원본이 **아예 없을 수 있다**(사용자 지적 2026-08-31). 그러면 마커도 서브클립도
 * 러프컷도 시작조차 못 한다. 그래서 없으면 STEP-D 에서 받아 프로젝트에 넣는다.
 *
 * 세 가지를 지킨다:
 *  1. **한 번만 묻는다** — 저장 폴더는 처음에 한 번 고르고 영구 토큰으로 기억한다.
 *     회차마다 폴더를 묻는 도구는 아무도 안 쓴다.
 *  2. **이미 받아 둔 건 다시 안 받는다** — 같은 이름·같은 크기면 그대로 쓴다. 수 GB 를
 *     두 번 받는 건 그 자체로 사고다.
 *  3. **청크로 받아 이어 쓴다** — 통째로 메모리에 올리면 프리미어까지 같이 죽는다.
 */
const DOWNLOAD_CHUNK = 16 * 1024 * 1024;

async function mediaFolder() {
  const token = await store.get("stepd.mediaFolderToken");
  if (token) {
    try { return await localFs.getEntryForPersistentToken(token); } catch (_) { /* 폴더가 사라졌다 */ }
  }
  const folder = await localFs.getFolder();
  if (!folder) throw new Error("원본을 저장할 폴더를 골라야 합니다.");
  try {
    await store.set("stepd.mediaFolderToken", await localFs.createPersistentToken(folder));
  } catch (_) { /* 토큰을 못 만들면 다음에 다시 묻는다 — 동작 자체는 된다 */ }
  return folder;
}

/** Range 로 한 조각. 첫 조각의 Content-Range 에서 전체 크기를 얻는다(HEAD 왕복 절약). */
function fetchRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
    xhr.onload = () => {
      if (xhr.status !== 206 && xhr.status !== 200) return reject(new Error(`다운로드 실패 ${xhr.status}`));
      const cr = xhr.getResponseHeader("Content-Range") || "";
      const total = Number(/\/(\d+)$/.exec(cr)?.[1] ?? 0);
      resolve({ buffer: xhr.response, total, partial: xhr.status === 206 });
    };
    xhr.onerror = () => reject(new Error("네트워크 오류"));
    xhr.send();
  });
}

async function downloadMaster(mediaId, filename, onStage) {
  const folder = await mediaFolder();

  // 이미 받아 둔 파일이 있으면 그대로 쓴다 — 크기까지 같아야 인정한다(중간에 끊긴 파일 방지).
  const existing = await folder.getEntry(filename).catch(() => null);

  onStage("STEP-D 에서 원본 주소 받는 중…");
  const { url } = await apiJson(`/media/${encodeURIComponent(mediaId)}/stream-url`);
  if (!url) throw new Error("원본 주소를 받지 못했습니다.");

  const first = await fetchRange(url, 0, DOWNLOAD_CHUNK - 1);
  const total = first.total || first.buffer.byteLength;

  if (existing) {
    const meta = await existing.getMetadata().catch(() => null);
    if (meta && Number(meta.size) === total) {
      onStage("이미 받아 둔 원본을 씁니다.");
      return existing;
    }
  }

  const file = await folder.createFile(filename, { overwrite: true });
  const nativePath = file.nativePath;
  let nodeFs = null;
  let fd = null;
  try {
    nodeFs = require("fs");
    if (nodeFs && typeof nodeFs.openSync === "function") fd = nodeFs.openSync(nativePath, "w");
    else nodeFs = null;
  } catch (_) { nodeFs = null; }

  if (!nodeFs || fd === null) {
    // 이어 쓰기를 못 하면 통째로 받는 수밖에 없다 — 큰 파일은 여기서 막고 사람에게 알린다.
    // 조용히 메모리를 터뜨리는 것보다 "이 방법으로는 안 된다" 가 낫다.
    if (total > 512 * 1024 * 1024) {
      throw new Error("이 프리미어 버전에서는 큰 원본을 받을 수 없습니다 — 파일을 직접 프로젝트에 가져오세요.");
    }
    const all = new Uint8Array(total);
    all.set(new Uint8Array(first.buffer), 0);
    let off = first.buffer.byteLength;
    while (off < total) {
      const { buffer } = await fetchRange(url, off, Math.min(off + DOWNLOAD_CHUNK, total) - 1);
      all.set(new Uint8Array(buffer), off);
      off += buffer.byteLength;
      onStage(`원본 받는 중… ${Math.round((off / total) * 100)}%`);
    }
    await file.write(all.buffer, { format: formats.binary });
    return file;
  }

  try {
    let off = 0;
    let buf = first.buffer;
    while (off < total) {
      nodeFs.writeSync(fd, new Uint8Array(buf), 0, buf.byteLength, off);
      off += buf.byteLength;
      onStage(`원본 받는 중… ${Math.round((off / total) * 100)}% (${(total / 1073741824).toFixed(1)}GB)`);
      if (off >= total) break;
      buf = (await fetchRange(url, off, Math.min(off + DOWNLOAD_CHUNK, total) - 1)).buffer;
    }
  } finally {
    try { nodeFs.closeSync(fd); } catch (_) { /* 이미 닫힘 */ }
  }
  return file;
}

/**
 * 원본을 **확보**한다 — 프로젝트에 있으면 그걸, 없으면 받아서 넣고 다시 찾는다.
 * 이게 있어야 "원본이 이미 프로젝트에 있어야 한다" 는 전제가 사라진다.
 */
async function ensureMaster(rec, onStage) {
  const filename = rec.mediaFilename || "";
  try {
    return await findMasterItem(filename);
  } catch (_) {
    // 없다 — 받아서 넣는다.
  }
  if (!rec.mediaId) throw new Error("이 추천에 연결된 원본이 없습니다.");

  const file = await downloadMaster(rec.mediaId, filename || `${rec.mediaId}.mp4`, onStage);
  onStage("프로젝트에 가져오는 중…");
  const { project } = await activeSequence();
  // suppressUI=true — 가져오기 대화상자가 뜨면 자동 흐름이 사람을 기다리며 멈춘다.
  const ok = await project.importFiles([file.nativePath], true);
  if (ok === false) throw new Error("프로젝트로 가져오지 못했습니다.");
  return await findMasterItem(filename || file.name);
}

async function makeSubclipsForRecs(recs, onStage) {
  // 원본이 프로젝트에 없으면 **받아서 넣는다** — 편집자 PC 에 파일이 없을 수 있다.
  const withMedia = recs.find((r) => r.mediaFilename || r.mediaId) || recs[0];
  onStage("원본 확인 중…");
  const { api, project, clip, name } = await ensureMaster(withMedia, onStage);

  onStage(`"${name}" 에서 ${recs.length}개 구간 자르는 중…`);
  const ok = project.executeTransaction((compound) => {
    for (const r of recs) {
      const start = api.TickTime.createWithSeconds(Number(r.startTime) || 0);
      const end = api.TickTime.createWithSeconds(Number(r.endTime) || 0);
      // 이름에 추천 id 를 넣는다 — 나중에 시퀀스로 조립할 때 이 이름으로 되찾는다.
      const label = subclipName(r);
      // hasHardBoundaries=true: 편집자가 실수로 구간 밖까지 늘리지 못하게 한다.
      // AI 가 고른 구간이 바깥 경계라는 계약을 프리미어 쪽에서도 지킨다.
      compound.addAction(clip.createSubClipAction(label, start, end, true));
    }
  }, `STEP-D 추천 서브클립 ${recs.length}개`);

  if (ok === false) throw new Error("서브클립을 만들지 못했습니다 — 원본이 오프라인인지 확인하세요.");
  return { sourceName: name, count: recs.length };
}

// ── 러프컷 — 조각을 순서대로 늘어놓은 초벌 타임라인 ───────────────────────────
/**
 * 서브클립이 "오려둔 조각" 이라면 러프컷은 **이미 순서대로 붙여 놓은 초벌**이다.
 * 편집자는 다듬기부터 시작한다 — 찾고 자르고 늘어놓는 일이 통째로 없어진다.
 *
 * 공식 선언 대조: `project.createSequenceFromMedia(name, clipProjectItems?, targetBin?)`
 * — 시퀀스 **생성과 배치가 한 번에** 된다(설정도 소재에 맞춰진다). 그래서 트랙 인덱스·삽입
 * 시각을 우리가 계산하지 않는다. 계산하는 순간 fps·드롭프레임에서 어긋날 자리가 생긴다.
 *
 * ⚠️ 서브클립 생성은 **지연 액션**이라 만들어진 항목을 못 돌려받는다. 그래서 이름 끝에
 *    추천 id 를 박아 두고(makeSubclips 와 같은 규칙) 커밋 뒤에 그 이름으로 되찾는다.
 */
async function findItemsByRecIds(recIds) {
  const { api, project } = await activeSequence();
  const want = new Map(recIds.map((id) => [String(id), null]));
  const root = await project.getRootItem();
  const queue = [root];
  let visited = 0;

  while (queue.length && visited < 4000) {
    const folder = queue.shift();
    let items = [];
    try { items = await folder.getItems(); } catch (_) { continue; }
    for (const item of items) {
      visited += 1;
      try {
        const asFolder = api.FolderItem && api.FolderItem.cast ? api.FolderItem.cast(item) : null;
        if (asFolder && typeof asFolder.getItems === "function") { queue.push(asFolder); continue; }
      } catch (_) { /* 폴더 아님 */ }
      const name = String(item.name || "");
      for (const id of want.keys()) {
        if (!want.get(id) && name.endsWith(id)) {
          try { want.set(id, api.ClipProjectItem.cast(item)); } catch (_) { /* 클립 아님 */ }
        }
      }
    }
  }
  return want;
}

async function buildRoughCut(recs, onStage) {
  const withMedia = recs.find((r) => r.mediaFilename || r.mediaId) || recs[0];
  onStage("원본 확인 중…");
  const { api, project, clip, name } = await ensureMaster(withMedia, onStage);

  // ① 구간마다 조각을 만든다 — 서브클립 버튼과 **같은 규칙**으로 이름 붙인다.
  onStage(`${recs.length}개 구간 자르는 중…`);
  const cut = project.executeTransaction((compound) => {
    for (const r of recs) {
      compound.addAction(clip.createSubClipAction(
        subclipName(r),
        api.TickTime.createWithSeconds(Number(r.startTime) || 0),
        api.TickTime.createWithSeconds(Number(r.endTime) || 0),
        true,
      ));
    }
  }, `STEP-D 러프컷 재료 ${recs.length}개`);
  if (cut === false) throw new Error("구간을 자르지 못했습니다 — 원본이 오프라인인지 확인하세요.");

  // ② 방금 만든 조각을 이름으로 되찾는다(지연 액션이라 반환값이 없다).
  onStage("조각 찾는 중…");
  const found = await findItemsByRecIds(recs.map((r) => r.id));
  // **추천 순서 그대로** 늘어놓는다 — 점수 순으로 온 목록이라 그게 곧 편집 순서다.
  const ordered = recs.map((r) => found.get(String(r.id))).filter(Boolean);
  if (!ordered.length) throw new Error("자른 조각을 프로젝트에서 찾지 못했습니다.");

  // ③ 시퀀스 생성 + 배치 (한 번에). 시퀀스 설정도 소재에 맞춰진다.
  onStage("러프컷 시퀀스 만드는 중…");
  const seqName = `[STEP-D] ${(withMedia.programTitle || name || "러프컷").slice(0, 40)} 러프컷`;
  const seq = await project.createSequenceFromMedia(seqName, ordered);
  if (!seq) throw new Error("시퀀스를 만들지 못했습니다.");
  // 만들고 안 열면 사용자는 "눌렀는데 아무 일도 안 일어났다" 고 느낀다.
  try { await project.setActiveSequence(seq); } catch (_) { /* 열기 실패는 치명적이지 않다 */ }

  return { seqName, placed: ordered.length, missing: recs.length - ordered.length };
}

async function doRoughCut() {
  if (busy || !recRows.length) return;
  busy = true;
  $("roughcutBtn").disabled = true;
  try {
    const { seqName, placed, missing } = await buildRoughCut(recRows, (m) => setStatus($("recsStatus"), m));
    setStatus($("recsStatus"),
      `"${seqName}" 을 만들었습니다 — ${placed}개 구간이 순서대로 놓였습니다.`
      + (missing > 0 ? ` (${missing}개는 조각을 못 찾아 빠졌습니다)` : ""), "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 러프컷 실패", err);
  } finally {
    busy = false;
    $("roughcutBtn").disabled = !recRows.length;
  }
}

async function doMakeSubclips() {
  if (busy || !recRows.length) return;
  busy = true;
  $("subclipBtn").disabled = true;
  try {
    const { sourceName, count } = await makeSubclipsForRecs(recRows, (m) => setStatus($("recsStatus"), m));
    setStatus($("recsStatus"),
      `"${sourceName}" 에서 ${count}개 구간을 잘라 프로젝트에 넣었습니다. 되돌리려면 Ctrl+Z 한 번.`, "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 서브클립 실패", err);
  } finally {
    busy = false;
    $("subclipBtn").disabled = !recRows.length;
    $("roughcutBtn").disabled = !recRows.length;
  }
}

let recRows = [];

function renderRecs() {
  const list = $("recsList");
  list.innerHTML = "";
  for (const r of recRows) {
    const row = document.createElement("div");
    row.className = "rec";

    const title = document.createElement("div");
    title.className = "rec-title";
    title.textContent = r.title || "(제목 없음)";

    const meta = document.createElement("div");
    meta.className = "rec-meta";
    const dur = Math.max(0, Math.round(Number(r.endTime) - Number(r.startTime)));
    const score = r.score100 === null || r.score100 === undefined ? "—" : `${r.score100}점`;
    const ep = r.episodeNumber ? `${r.episodeNumber}회 · ` : "";
    // 프레임 메타가 없는 회차는 여기서 밝힌다 — 정합을 못 맞추는 걸 조용히 넘기지 않는다.
    const warn = r.fps ? "" : " · ⚠ 프레임 정합 불가(원본 메타 없음)";
    meta.textContent = `${ep}${fmtTime(r.startTime)}–${fmtTime(r.endTime)} · ${dur}초 · ${score}${warn}`;

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", () => void jumpToRec(r));
    list.appendChild(row);
  }
}

async function jumpToRec(r) {
  try {
    setStatus($("recsStatus"), `"${r.title}" 구간으로 이동 중…`);
    await seekActiveSequence(Number(r.startTime) || 0);
    setStatus($("recsStatus"), `${fmtTime(r.startTime)} 으로 이동했습니다.`, "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] seek 실패", err);
  }
}

async function loadRecs() {
  const programId = selectedProgram();
  setStatus($("recsStatus"), "불러오는 중…");
  try {
    const q = programId ? `?programId=${encodeURIComponent(programId)}&limit=50` : "?limit=50";
    const data = await apiJson(`/recommendations${q}`);
    recRows = Array.isArray(data.recommendations) ? data.recommendations : [];
    renderRecs();
    $("markersBtn").disabled = !recRows.length;
    $("subclipBtn").disabled = !recRows.length;
    setStatus(
      $("recsStatus"),
      recRows.length
        ? `채택 대기 ${recRows.length}건 · 줄을 누르면 그 구간으로 이동합니다`
        : "이 프로그램에 채택 대기 중인 추천이 없습니다.",
    );
  } catch (err) {
    setStatus($("recsStatus"), `불러오지 못했습니다: ${err.message}`, "err");
  }
}

// ── 웹 → 프리미어 핸드오프 (패널 쪽) ─────────────────────────────────────────
/**
 * 웹에서 "프리미어에서 편집" 을 누르면 그 회차로 따라온다.
 *
 * ⚠️ 브라우저가 패널에 값을 직접 넘길 길이 없어서(UXP 는 OS→패널 입력이 없다) **폴링**이다.
 * 대신 폴링이라서 좋은 점이 하나 있다 — 프리미어가 이미 떠 있으면 **설치물 없이도** 된다.
 * 프리미어를 띄우는 것만 `stepd://` 프로토콜 핸들러 몫이다(launcher/ 참고).
 *
 * 간격은 5초. 더 짧게 하면 편집 중에 서버를 계속 두드리고, 더 길면 "눌렀는데 반응이 없다" 가 된다.
 */
const HANDOFF_POLL_MS = 5000;
let handoffTimer = null;

async function pollHandoff() {
  // 업로드·렌더 중에는 건너뛴다 — 그 사이 화면을 바꾸면 진행 상황이 가려진다.
  if (busy || !session.token) return;
  try {
    const res = await api("/premiere/handoff", { method: "GET" });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const h = data && data.handoff;
    if (!h) return;
    console.log("[STEP-D] handoff", h);
    await applyHandoff(h);
  } catch (_) {
    // 네트워크가 잠깐 끊긴 것 — 다음 폴링에서 다시 본다. 조용히 넘어간다.
  }
}

async function applyHandoff(h) {
  const label = h.label || "웹에서 보낸 회차";
  if (h.programId) {
    const sel = $("program");
    const has = Array.from(sel.options).some((o) => o.value === h.programId);
    if (!has) await loadPrograms();          // 방금 만든 프로그램일 수 있다
    sel.value = h.programId;
    await store.set("stepd.lastProgram", h.programId);
    syncUploadButton();
    void refreshSequenceLabel();
  }
  // 웹에서 "편집" 을 눌렀다는 건 **무엇을 만들지 보러 온 것**이다 — 추천 탭으로 데려간다.
  showTab("recs");
  recRows = [];
  await loadRecs();
  setStatus($("recsStatus"), `웹에서 열었습니다 — ${label}`, "ok");
}

function startHandoffPolling() {
  if (handoffTimer) return;
  handoffTimer = setInterval(() => void pollHandoff(), HANDOFF_POLL_MS);
}

function stopHandoffPolling() {
  if (handoffTimer) clearInterval(handoffTimer);
  handoffTimer = null;
}

// ── 웹 탭 ─────────────────────────────────────────────────────────────────────
/**
 * STEP-D 웹을 패널 안에 그대로 띄운다 — **프리미어와 웹을 왔다갔다 하지 않으려고**
 * (사용자 2026-08-31: "프리미어랑 STEP-D 웹을 왔다갔다 해야 해서").
 *
 * 앱을 새로 만드는 대신 **있는 웹을 그대로** 넣는다. 배포도 지금처럼 웹 배포 한 번이면
 * 프리미어 안의 화면까지 같이 갱신된다 — 플러그인을 다시 깔 필요가 없다.
 *
 * `<webview>` 는 manifest 의 `requiredPermissions.webview` 가 있어야 뜬다(도메인 화이트리스트).
 * 양방향 메시지(`enableMessageBridge`)도 켜 뒀다 — 나중에 웹에서 "이 구간으로 이동"·"마커 꽂기"
 * 를 눌러 패널이 프리미어를 조작하게 만들 자리다(아직 배선 안 함).
 */
const WEB_HOME = "https://stepd.stepai.kr";
let webLoaded = false;

function openWebTab() {
  const wv = $("webview");
  if (!wv) return;
  if (!webLoaded) {
    // 처음 열 때만 로드한다 — 패널을 켜자마자 웹을 띄우면 안 쓰는 사람도 비용을 낸다.
    wv.src = WEB_HOME;
    webLoaded = true;
    setStatus($("webStatus"), "불러오는 중… (패널을 플로팅으로 띄우고 크게 늘리면 편합니다)");
    // 로그인 유지 여부는 WebView 쿠키 정책에 달렸고 문서에 명시가 없다 — 실제로 보고 정한다.
    wv.addEventListener("loadstop", () => setStatus($("webStatus"), ""));
    wv.addEventListener("loaderror", () => setStatus($("webStatus"), "웹을 불러오지 못했습니다 — 네트워크를 확인하세요.", "err"));
  }
}

function showTab(which) {
  const isRecs = which === "recs";
  const isWeb = which === "web";
  $("uploadPane").className = isRecs || isWeb ? "hidden" : "";
  $("recsPane").className = isRecs ? "" : "hidden";
  $("webPane").className = isWeb ? "" : "hidden";
  $("tabUpload").className = isRecs || isWeb ? "tab" : "tab active";
  $("tabRecs").className = isRecs ? "tab active" : "tab";
  $("tabWeb").className = isWeb ? "tab active" : "tab";
  if (isRecs && !recRows.length) void loadRecs();
  if (isWeb) openWebTab();
}

function contentTypeFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "mov") return "video/quicktime";
  if (ext === "mxf") return "application/mxf";
  if (ext === "m4v") return "video/x-m4v";
  return "video/mp4";
}

/** 업로드 본체 — 렌더한 파일이든 사람이 고른 파일이든 여기 하나로 모인다. */
async function runUpload(source, programId) {
  const reader = makeReader(source.entry, source.nativePath, source.size);
  // 어느 읽기 경로로 갔는지 보여 준다. 큰 파일에서 프리미어까지 느려지면 원인이 대개
  // 이것("전체 읽기" = 파일을 통째로 메모리에)이라, 사후에 묻지 않아도 되게 앞에 띄운다.
  const readMode = reader.mode === "chunked" ? "부분 읽기" : "전체 읽기";
  console.log(`[STEP-D] upload start · ${source.name} · ${source.size} bytes · ${reader.mode}`);
  try {
    setStatus($("status"), `업로드 세션 여는 중… (${readMode})`);
    const init = await apiJson("/media/upload-init", {
      method: "POST",
      body: JSON.stringify({
        programId,
        filename: source.name,
        contentType: contentTypeFor(source.name),
      }),
    });

    if (init.mode !== "resumable") {
      throw new Error("이 서버는 대용량 업로드(GCS)가 꺼져 있습니다 — 관리자에게 문의하세요.");
    }

    setStatus($("status"), `업로드 중… (${readMode})`);
    await uploadResumable(init.sessionUrl, reader, source.size, (pct) => {
      setProgress(pct);
      setStatus($("status"), `업로드 중… ${pct}% (${readMode})`);
    });

    setStatus($("status"), "클립 생성 중…");
    // ⚠️ 여기서 세션이 만료돼 있으면 api() 가 조용히 재로그인하고 재시도한다. 업로드에 30분이
    //    걸린 뒤 이 한 줄에서 401 로 전부 날리는 게 가장 뼈아픈 실패라, 그 방어가 여기 있다.
    const done = await apiJson("/media/clip-finalize", {
      method: "POST",
      body: JSON.stringify({
        mediaId: init.mediaId,
        objectPath: init.objectPath,
        programId,
        filename: source.name,
        contentType: contentTypeFor(source.name),
        size: source.size,
        title: source.name.replace(/\.[^.]+$/, ""),
      }),
    });

    await store.set("stepd.lastProgram", programId);
    setProgress(100);
    const clipTitle = done.clip && done.clip.title ? done.clip.title : source.name;
    setStatus($("status"), `업로드 완료 — "${clipTitle}" 등록됐습니다. 배포는 웹에서 진행하세요.`, "ok");
    return true;
  } finally {
    reader.close();
  }
}

/** 공통 진행 잠금 — 렌더든 업로드든 도는 동안 버튼을 다 잠근다. */
async function withBusy(fn) {
  busy = true;
  $("pickBtn").disabled = true;
  $("exportBtn").disabled = true;
  syncUploadButton();
  setProgress(0);
  try {
    await fn();
  } catch (err) {
    setStatus($("status"), `실패: ${err.message}`, "err");
    console.log("[STEP-D] 실패", err);
  } finally {
    busy = false;
    $("pickBtn").disabled = false;
    syncUploadButton();
    // 내보내기 버튼은 무조건 되살리지 않는다 — 시퀀스가 없으면 다시 잠겨야 한다.
    void refreshSequenceLabel();
  }
}

function selectedProgram() {
  return $("program").value;
}

/** ① 사람이 고른 파일 업로드 (이미 렌더해 둔 완성본 · 다른 도구 산출물). */
async function doUpload() {
  if (!picked || busy || !selectedProgram()) return;
  await withBusy(async () => {
    const ok = await runUpload(picked, selectedProgram());
    if (ok) {
      picked = null;
      $("fileBox").className = "file";
      $("fileBox").textContent = "렌더한 MP4 를 선택하세요";
    }
  });
}

/** ② 딸깍 — 지금 타임라인에 떠 있는 시퀀스를 렌더해서 그대로 올린다. */
async function doExportAndUpload() {
  if (busy || !selectedProgram()) return;
  await withBusy(async () => {
    const rendered = await exportActiveSequence((msg) => setStatus($("status"), msg));
    console.log(`[STEP-D] rendered ${rendered.nativePath} · ${rendered.size} bytes`);
    await runUpload(rendered, selectedProgram());
  });
}

/** 무엇이 올라갈지 미리 보여 준다 — 딸깍 전에 "그 시퀀스가 맞나" 를 눈으로 확인하는 자리. */
async function refreshSequenceLabel() {
  const box = $("seqBox");
  if (!box) return;
  try {
    const { name } = await activeSequence();
    box.textContent = `현재 시퀀스: ${name}`;
    box.className = "seq ready";
    $("exportBtn").disabled = busy || !selectedProgram();
  } catch (err) {
    box.textContent = err.message;
    box.className = "seq";
    $("exportBtn").disabled = true;
  }
}

async function doLogout() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  await session.clear();
  stopHandoffPolling();
  picked = null;
  show("login");
  setStatus($("loginStatus"), "");
}

// ── 시작 ──────────────────────────────────────────────────────────────────────
(async function boot() {
  $("loginBtn").addEventListener("click", doLogin);
  $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("pickBtn").addEventListener("click", pickFile);
  $("uploadBtn").addEventListener("click", doUpload);
  $("exportBtn").addEventListener("click", doExportAndUpload);
  $("logoutBtn").addEventListener("click", doLogout);
  $("tabUpload").addEventListener("click", () => showTab("upload"));
  $("tabRecs").addEventListener("click", () => showTab("recs"));
  $("tabWeb").addEventListener("click", () => showTab("web"));
  $("webHome").addEventListener("click", () => { $("webview").src = WEB_HOME; });
  $("webReload").addEventListener("click", () => {
    const wv = $("webview");
    // reload() 가 없는 버전이 있어 src 재지정으로 물러난다.
    if (typeof wv.reload === "function") wv.reload(); else wv.src = wv.src;
  });
  $("recsReload").addEventListener("click", () => void loadRecs());
  $("markersBtn").addEventListener("click", () => void doAddMarkers());
  $("roughcutBtn").addEventListener("click", () => void doRoughCut());
  $("subclipBtn").addEventListener("click", () => void doMakeSubclips());
  $("program").addEventListener("change", () => {
    syncUploadButton();
    void refreshSequenceLabel();
    // 프로그램이 바뀌면 추천도 그 프로그램 것이어야 한다 — 비워 두면 남의 목록을 보게 된다.
    recRows = [];
    renderRecs();
    if ($("recsPane").className !== "hidden") void loadRecs();
  });
  // 시퀀스는 패널 밖에서 바뀐다(사용자가 타임라인에서 다른 걸 연다). 눌러서 다시 읽게 둔다 —
  // 패널이 계속 폴링하면 편집 중에 괜히 프리미어를 건드린다.
  $("seqBox").addEventListener("click", () => void refreshSequenceLabel());

  const restored = await session.restore();
  if (restored) {
    show("upload");
    await loadPrograms();
    await refreshSequenceLabel();
    startHandoffPolling();
  } else {
    show("login");
    const email = await store.get("stepd.email");
    if (email) $("email").value = email;
  }
})();
