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
    warnIfFontsMissing();
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

/**
 * 열린 **프로젝트**만 필요한 자리 — 시퀀스는 없어도 된다.
 *
 * 왜 나눴나: 빈 프로젝트(원본만 가져온 상태)에서 "추천 누르면 시퀀스 만들기" 를 하려는데,
 * activeSequence() 를 쓰면 *"활성 시퀀스가 없습니다"* 로 먼저 막힌다 — 만들어 주려는
 * 기능이 시퀀스가 없다는 이유로 못 도는 셈이다.
 */
/**
 * 프리미어 호스트 객체는 **await 를 건너면 무효가 된다**("The script object is no longer valid").
 * 규칙은 하나 — 객체를 들고 다니지 말고 **쓰기 직전에 다시 얻는다.** 그래도 새는 자리가 있어
 * (프리미어가 우리 모르게 갱신하는 순간들) 한 번은 되풀이해 준다.
 *
 * ⚠️ **한 번만** 재시도한다. 진짜로 깨진 상태에서 무한히 돌면 패널이 멈춘 것처럼 보인다.
 */
function isStaleObjectError(err) {
  return /no longer valid|not valid|invalid/i.test(String((err && err.message) || err || ""));
}

async function retryStale(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isStaleObjectError(err)) throw err;
    console.log(`[STEP-D] ${label}: 객체 무효 — 다시 시도`, err);
    return await fn();
  }
}

/** 실패 메시지에 **어느 단계였는지**를 붙인다 — 원문만 보면 어디서 났는지 알 수 없다. */
async function stage(label, fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = String((err && err.message) || err);
    throw new Error(`${label}: ${msg}`);
  }
}

async function activeProject() {
  const api = ppro();
  if (!api) throw new Error("이 프리미어에서는 프로젝트를 다룰 수 없습니다 (premierepro 모듈 없음).");
  const project = await readMaybe(api.Project, "getActiveProject");
  if (!project) throw new Error("열려 있는 프로젝트가 없습니다.");
  return { api, project };
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
 *   `lockedTransaction(project, cb => cb.addAction(action), undoString?): boolean`
 *
 * 마커는 **액션 패턴**이다 — 만들기만 하면 아무 일도 안 일어나고, 트랜잭션에 담아 실행해야
 * 반영된다. 트랜잭션 하나에 다 담는 이유: 편집자가 **Ctrl+Z 한 번으로 전부 되돌릴 수 있다.**
 * 스무 개를 따로 넣으면 스무 번 눌러야 한다.
 */
async function addMarkersForRecs(recs) {
  return await retryStale("마커", () => addMarkersOnce(recs));
}

/**
 * 마커 꽂기 — **await 를 최소로, 프로젝트를 맨 마지막에.**
 *
 * 실측 2026-08-31: 여기서 "The script object is no longer valid" 가 났다. 이유는 순서였다 —
 * 예전엔 project 를 먼저 얻고, 그 뒤 `await getMarkers(...)` 를 건너고 나서 그 낡은 project 로
 * 트랜잭션을 돌았다. **await 하나를 건너면 앞서 얻은 객체는 못 믿는다.**
 *
 * 그래서 순서를 뒤집었다: 시퀀스 → 마커 목록 → **프로젝트(마지막)** → 곧바로 트랜잭션.
 * 트랜잭션 콜백 안은 전부 동기라 그 사이에 무효가 될 틈이 없다.
 * 각 단계에 이름을 붙여, 또 나면 **어느 호출이** 무효인지 화면에 바로 뜨게 했다.
 */
async function addMarkersOnce(recs) {
  const api = ppro();
  if (!api) throw new Error("이 프리미어에서는 마커를 쓸 수 없습니다 (premierepro 모듈 없음).");
  if (!api.Markers || typeof api.Markers.getMarkers !== "function") {
    dumpApi(api, null);
    throw new Error("마커 API 를 찾지 못했습니다 — UDT 콘솔의 [STEP-D] 로그를 보내 주세요.");
  }

  const sequence = await stage("활성 시퀀스", async () => {
    const p = await readMaybe(api.Project, "getActiveProject");
    if (!p) throw new Error("열려 있는 프로젝트가 없습니다.");
    const s = await readMaybe(p, "getActiveSequence");
    if (!s) throw new Error("활성 시퀀스가 없습니다 — 타임라인에서 시퀀스를 여세요.");
    return s;
  });
  // 이름은 **동기 속성**이다(공식 선언: readonly name: string) — 여기서 await 를 쓰면
  // 방금 얻은 시퀀스를 스스로 무효로 만들 수 있다.
  const name = typeof sequence.name === "string" && sequence.name ? sequence.name : "sequence";

  const markers = await stage("마커 목록", () => api.Markers.getMarkers(sequence));
  // 코멘트 마커(기본). 상수를 못 찾으면 문자열 폴백 — 여기서 틀려도 마커가 안 생길 뿐,
  // 내보내기처럼 엉뚱한 동작을 하지는 않는다.
  const type = (api.Marker && api.Marker.MARKER_TYPE_COMMENT) || "Comment";

  // **프로젝트는 맨 마지막에.** 이 뒤로는 await 가 없다.
  const project = await stage("프로젝트", () => readMaybe(api.Project, "getActiveProject"));
  if (!project) throw new Error("열려 있는 프로젝트가 없습니다.");

  const ok = lockedTransaction(project, (compound) => {
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

/**
 * **프로젝트를 잠근 채** 동기 블록을 돌린다.
 *
 * 공식 선언 그대로: *"Get a read/upgrade locked access to Project, project state will not change
 * during the execution of callback function. **Can call executeTransaction while having locked
 * access.**"* — 즉 이 API 는 정확히 우리가 맞은 문제("The script object is no longer valid")를
 * 위해 있다. 앞서 얻어 둔 markers·sequence 핸들이 트랜잭션 도중 프리미어의 내부 갱신으로
 * 무효가 되는 걸 막는다.
 *
 * ⚠️ 콜백은 **동기**여야 한다(반환값 void). 안에서 await 하면 잠금이 풀린 뒤에 돌아온다.
 * 옛 프리미어에 이 API 가 없으면 그냥 실행한다 — 없다고 기능을 막을 이유는 없다.
 */
function runLocked(project, fn) {
  if (typeof project.lockedAccess !== "function") return fn();
  let out;
  project.lockedAccess(() => { out = fn(); });
  return out;
}

/**
 * 잠근 채로 도는 트랜잭션. **패널의 모든 executeTransaction 은 이걸 쓴다.**
 *
 * 왜 전부인가: "The script object is no longer valid" 는 마커에서만 난 게 아니라 **구조적**이다.
 * 트랜잭션을 부르기까지 우리는 늘 await 를 몇 번 건너고(시퀀스·마커·항목 조회), 그 사이
 * 프리미어가 내부를 갱신하면 앞서 얻은 핸들이 죽는다. 한 군데만 고치면 다음 자리에서 또 난다.
 */
function lockedTransaction(project, build, label) {
  return runLocked(project, () => project.executeTransaction(build, label));
}

// ── 글꼴 확인 ─────────────────────────────────────────────────────────────────
/**
 * **지마켓 산스가 이 PC 에 있나.** 사용자 요구 2026-08-31: "안 깔려 있으면 인식해서 깔게끔도."
 *
 * ⚠️ 범위가 바뀌었다: STEP-D 제목은 이제 **서버가 그린 PNG** 라 이 PC 의 글꼴과 무관하다.
 * 남은 건 편집자가 프리미어에서 **직접 넣는 자막·문구**다 — 그건 로컬 글꼴로 그려지므로,
 * 없으면 같은 영상 안에서 제목과 자막의 글꼴이 갈린다. 조용히 틀리는 쪽이라 먼저 말해 준다.
 *
 * 설치는 패널이 직접 못 한다(레지스트리 등록이 필요하다). 대신 **한 줄 명령**을 안내한다 —
 * launcher/install-fonts.ps1 은 관리자 권한 없이 사용자 폰트로 넣는다.
 */
const FONT_FILES = ["GmarketSansTTFBold.ttf", "GmarketSansTTFMedium.ttf"];

function fontsInstalled() {
  let nodeFs = null;
  try { nodeFs = require("fs"); } catch (_) { return null; }   // 확인 자체가 불가 → 조용히 넘어간다
  if (!nodeFs || typeof nodeFs.openSync !== "function") return null;

  // 경로는 **슬래시로** 쓴다 — Windows 도 받아 주고, 역슬래시 이스케이프에서 나는 사고가 없다.
  const env = (typeof process !== "undefined" && process.env) || {};
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(`${env.LOCALAPPDATA}/Microsoft/Windows/Fonts`);
  dirs.push(`${env.WINDIR || "C:/Windows"}/Fonts`);

  for (const dir of dirs) {
    for (const f of FONT_FILES) {
      try {
        const fd = nodeFs.openSync(`${dir}/${f}`, "r");
        nodeFs.closeSync(fd);
        return true;    // 하나만 있어도 설치된 것으로 본다(Bold 가 제목에 쓰인다)
      } catch (_) { /* 없다 */ }
    }
  }
  return false;
}

/** 없으면 화면에 알린다. 판정 불가(null)면 아무 말도 하지 않는다 — 근거 없는 경고는 소음이다. */
function warnIfFontsMissing() {
  const el = $("fontWarn");
  if (!el) return;
  const ok = fontsInstalled();
  if (ok === false) {
    el.textContent = "⚠ 지마켓 산스가 이 PC 에 없습니다 — STEP-D 제목은 서버 그림이라 그대로지만, "
      + "프리미어에서 직접 넣는 자막·문구는 다른 글꼴로 나갑니다. "
      + "packages/premiere/launcher/install-fonts.ps1 을 한 번 실행하세요 (관리자 권한 불필요 · 이후 프리미어 재시작).";
    el.className = "status err";
  } else {
    el.textContent = "";
    el.className = "status";
  }
}

// ── 제목 그래픽 ──────────────────────────────────────────────────────────────
/**
 * 제목은 **서버가 찍어 준 .mogrt** 로 얹는다 — 프리미어에서 글자를 고칠 수 있어야 하니까.
 *
 * 어떻게 여기까지 왔나 (전부 사용자 요구다):
 *  ① "자동으로 서버에서 내려서"      → 편집자가 자산을 만들지 않는다
 *  ② "글씨 위치 같은 것도 다 빠질 텐데" → 손으로 만든 .mogrt 는 위치·글꼴이 **박제**된다
 *  ③ "편집자가 바꿀 수 있길 원하는데" → 그렇다고 PNG 면 글자를 못 고친다
 *  ④ "우리 서버에서 .MOGRT 만들어서 내려주면 되잖아" ← 이게 셋을 동시에 푼다
 *
 * 그래서 서버가 **요청 때마다** 지금 값(문구·글꼴·크기·색·위치)으로 .mogrt 를 찍어 준다
 * (`GET /api/recommendations/:id/title.mogrt`). 얻는 것: 편집 가능한 진짜 텍스트 레이어이면서
 * 스타일 정본은 서버 하나 — 템플릿을 바꾸면 다음에 받는 것부터 따라온다.
 *
 * ⚠️ 이미 타임라인에 얹은 클립은 **소급 갱신되지 않는다**(프로젝트 안으로 복사되기 때문).
 *    서버에서 제목을 바꿨으면 다시 얹어야 한다.
 *
 * PNG 경로(title.png)는 폴백으로 남는다 — 베이스 템플릿이 없거나 mogrt 삽입이 막히면
 * 최소한 제목이 화면에 나오게. 둘 다 **같은 서버 계산**에서 나오므로 모양은 어긋나지 않는다.
 */
/**
 * 서버가 .mogrt 를 찍으려면 **껍데기 하나**가 필요하다(그래픽 캡슐은 프리미어 산물이라
 * 코드로 처음부터 못 만든다). 그 껍데기를 리포에 박아 두지 않고 **이 PC 의 프리미어에 딸려
 * 온 기본 템플릿**을 한 번 올린다 — 그 프리미어가 만든 캡슐이라 그 프리미어에서 반드시 열린다.
 *
 * 왜 하필 `%APPDATA%` 인가: Program Files 아래에도 같은 파일이 있지만, 사용자 폴더 쪽이
 * 권한 문제가 없고 프리미어가 첫 실행 때 복사해 둔다. 두 줄짜리 하위 3종을 순서대로 찾는다.
 */
const BASE_TEMPLATE_CANDIDATES = [
  "Basic Lower Third.mogrt",                                  // 텍스트 레이어 2개 — 우리 제목 2줄과 맞다
  "Lower Thirds/Classic Lower Third Two Lines.mogrt",
  "Lower Thirds/Film Lower Third Left Two Line.mogrt",
  "Basic Title.mogrt",                                        // 1개 — 두 줄이 한 레이어로 합쳐진다
];

function readLocalFile(nodeFs, p) {
  if (typeof nodeFs.readFileSync === "function") {
    const b = nodeFs.readFileSync(p);
    return b instanceof ArrayBuffer ? b : new Uint8Array(b).buffer;
  }
  // readFileSync 가 없는 UXP 빌드 대비 — 열어서 크기만큼 읽는다.
  const fd = nodeFs.openSync(p, "r");
  try {
    const size = nodeFs.fstatSync ? Number(nodeFs.fstatSync(fd).size) : 4 * 1024 * 1024;
    const buf = new Uint8Array(size);
    nodeFs.readSync(fd, buf, 0, size, 0);
    return buf.buffer;
  } finally {
    try { nodeFs.closeSync(fd); } catch (_) { /* 이미 닫힘 */ }
  }
}

async function uploadBaseTemplate(onStage) {
  let nodeFs = null;
  try { nodeFs = require("fs"); } catch (_) { nodeFs = null; }
  if (!nodeFs || typeof nodeFs.openSync !== "function") {
    throw new Error("이 프리미어에서는 기본 템플릿을 읽을 수 없습니다.");
  }
  const env = (typeof process !== "undefined" && process.env) || {};
  const dir = `${env.APPDATA || ""}/Adobe/Common/Motion Graphics Templates`;
  let last = "";
  for (const name of BASE_TEMPLATE_CANDIDATES) {
    try {
      onStage(`제목 템플릿 준비 중… (${name})`);
      const buf = readLocalFile(nodeFs, `${dir}/${name}`);
      const res = await api("/premiere/base-template", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      last = data.error || `업로드 실패 (${res.status})`;
    } catch (err) {
      last = err.message;
    }
  }
  throw new Error(`제목 템플릿 준비 실패 — ${last}`);
}

/** 추천 하나의 제목 .mogrt. 서버에 베이스가 없으면 한 번 올리고 다시 부른다. */
async function fetchTitleMogrt(rec, folder, aspect, onStage, allowSetup = true) {
  const q = `?aspect=${encodeURIComponent(aspect)}`;
  const res = await api(`/recommendations/${encodeURIComponent(rec.id)}/title.mogrt${q}`, { method: "GET" });
  if (res.status === 409 && allowSetup) {
    await uploadBaseTemplate(onStage);
    return fetchTitleMogrt(rec, folder, aspect, onStage, false);
  }
  if (!res.ok) {
    if (res.status === 404) return null;          // 그릴 제목이 없다
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `제목 그래픽을 받지 못했습니다 (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  const file = await folder.createFile(`stepd-title-${rec.id}.mogrt`, { overwrite: true });
  await file.write(buf, { format: formats.binary });
  return file;
}

async function fetchTitlePng(rec, folder, aspect) {
  const q = `?aspect=${encodeURIComponent(aspect)}`;
  const res = await api(`/recommendations/${encodeURIComponent(rec.id)}/title.png${q}`, { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) return null;          // 그릴 제목이 없다 — 조용히 건너뛴다
    throw new Error(`제목 이미지를 받지 못했습니다 (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  const file = await folder.createFile(`stepd-title-${rec.id}.png`, { overwrite: true });
  await file.write(buf, { format: formats.binary });
  return file;
}

/** 이름으로 프로젝트 항목을 찾아 **그 자리에서** 쓴다(findItemsByRecIds 와 같은 이유). */
async function findItemsByFileNames(names, use) {
  const { api, project } = await activeProject();
  const want = new Map(names.map((n) => [n, null]));
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
      const n = String(item.name || "");
      if (want.has(n) && !want.get(n)) {
        try { want.set(n, api.ClipProjectItem.cast(item)); } catch (_) { /* 클립 아님 */ }
      }
    }
  }
  return await use(want, project, api);
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

/**
 * 시퀀스·조각 이름 끝에 붙여 둔 추천 id 를 되읽는다.
 *
 * 왜 이름에 담나: 프리미어에는 우리가 임의 메타를 붙일 자리가 없다(프로젝트 항목에 커스텀
 * 필드가 없다). 그래서 **이름이 유일한 끈**이다 — subclipName·recSequenceName 이 같은 규칙으로
 * 끝에 id 를 둔다. 편집자가 이름을 바꾸면 끈이 끊기는데, 그때는 그냥 연결이 안 될 뿐
 * 업로드 자체는 된다(끊겨도 망가지지 않는 쪽으로).
 */
function recIdFromName(name) {
  const m = /·\s*([A-Za-z0-9_-]{3,})\s*$/.exec(String(name || ""));
  return m ? m[1] : null;
}

async function findMasterItem(filename, use) {
  return await retryStale("원본 찾기", () => findMasterItemOnce(filename, use));
}

/**
 * 프로젝트에서 원본 클립을 찾아 **찾은 자리에서** 쓴다.
 *
 * ⚠️ 이름부터 맞춘다(2026-08-31 수정). 예전엔 항목마다 `await clip.getMediaFilePath()` 를 불렀는데,
 *    그 await 하나가 **같은 목록의 남은 항목들을 무효로 만든다**("The script object is no longer
 *    valid"). 프로젝트에 빈이 늘어나자(모션 그래픽 템플릿 빈이 생기면서) 바로 터졌다.
 *    항목 이름(`item.name`)은 await 없이 읽히므로, 이름이 맞으면 경로를 물을 이유가 없다.
 *    이름으로 못 찾은 경우에만 경로 대조를 한 번 돈다(그 경로는 여전히 무효화 위험이 있어
 *    retryStale 이 감싼다).
 */
async function findMasterItemOnce(filename, use) {
  const { api, project } = await activeProject();
  if (!filename) throw new Error("이 추천에 연결된 원본 파일 정보가 없습니다.");
  const wanted = String(filename).toLowerCase();
  const base = wanted.replace(/\.[^.]+$/, "");

  // ① 빈 구조를 먼저 다 읽는다 — getItems 만 await 하고, 그 사이 다른 await 는 섞지 않는다.
  const groups = [];       // [{ folder, items }]
  const queue = [await project.getRootItem()];
  let visited = 0;
  while (queue.length && visited < 2000) {
    const folder = queue.shift();
    let items = [];
    try { items = await folder.getItems(); } catch (_) { continue; }
    const clips = [];
    for (const item of items) {
      visited += 1;
      try {
        const asFolder = api.FolderItem && api.FolderItem.cast ? api.FolderItem.cast(item) : null;
        if (asFolder && typeof asFolder.getItems === "function") { queue.push(asFolder); continue; }
      } catch (_) { /* 폴더 아님 */ }
      clips.push(item);
    }
    groups.push(clips);
  }

  // ② 이름으로 — **await 없이** 판정하고 찾자마자 쓴다.
  for (const clips of groups) {
    for (const item of clips) {
      const n = String(item.name || "").toLowerCase();
      if (!n) continue;
      if (n === wanted || n === base || n.startsWith(base + ".") || (base.length > 6 && n.includes(base))) {
        try {
          const clip = api.ClipProjectItem.cast(item);
          if (clip) return await use({ api, project, clip, name: item.name });
        } catch (_) { /* 클립 아님 — 계속 */ }
      }
    }
  }

  // ③ 이름이 다르면(가져오며 바뀐 경우) 경로로 한 번 더. 여기서만 await 가 목록에 섞인다.
  for (const clips of groups) {
    for (const item of clips) {
      try {
        const clip = api.ClipProjectItem.cast(item);
        if (!clip || typeof clip.getMediaFilePath !== "function") continue;
        const path = String((await clip.getMediaFilePath()) || "").toLowerCase();
        // 경로 전체가 아니라 **파일명으로** 맞춘다 — NAS·로컬 경로가 PC 마다 다르다.
        if (path && (path.endsWith(`\${wanted}`) || path.endsWith(`/${wanted}`) || path.includes(wanted))) {
          // ⚠️ 찾자마자 여기서 쓴다 — 돌려주면 호출부의 await 를 건너며 무효가 된다.
          const fresh = api.ClipProjectItem.cast(item);
          return await use({ api, project, clip: fresh || clip, name: item.name });
        }
      } catch (err) {
        if (isStaleObjectError(err)) throw err;   // 위에서 한 번 다시 돈다
      }
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
  // 있는지만 확인한다 — **객체를 들고 나오지 않는다.** 아래 다운로드 대기를 건너는 순간
  // 무효가 되기 때문이다. 실제 사용은 호출부가 findMasterItem(…, use) 로 그때그때 한다.
  const present = await findMasterItem(filename, () => true).catch(() => false);
  if (present) return filename;

  if (!rec.mediaId) throw new Error("이 추천에 연결된 원본이 없습니다.");
  const file = await downloadMaster(rec.mediaId, filename || `${rec.mediaId}.mp4`, onStage);
  onStage("프로젝트에 가져오는 중…");
  const { project } = await activeSequence();
  // suppressUI=true — 가져오기 대화상자가 뜨면 자동 흐름이 사람을 기다리며 멈춘다.
  const ok = await project.importFiles([file.nativePath], true);
  if (ok === false) throw new Error("프로젝트로 가져오지 못했습니다.");
  return filename || file.name;
}

async function makeSubclipsForRecs(recs, onStage) {
  // 원본이 프로젝트에 없으면 **받아서 넣는다** — 편집자 PC 에 파일이 없을 수 있다.
  const withMedia = recs.find((r) => r.mediaFilename || r.mediaId) || recs[0];
  onStage("원본 확인 중…");
  const filename = await ensureMaster(withMedia, onStage);

  // 찾은 객체를 **그 자리에서** 쓴다 — await 를 건너 들고 나가면 무효가 된다.
  return await findMasterItem(filename, ({ api, project, clip, name }) => {
  onStage(`"${name}" 에서 ${recs.length}개 구간 자르는 중…`);
  const ok = lockedTransaction(project, (compound) => {
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
  });
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
async function findItemsByRecIds(recIds, use) {
  const { api, project } = await activeProject();
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
  // 모은 객체도 **여기서 바로** 넘긴다 — 밖으로 돌려주면 그 사이 await 에 무효가 된다.
  return await use(want, project, api);
}

/**
 * 시퀀스를 **세로 쇼츠(1080×1920)** 로 바꾼다 — 사용자 요구 2026-08-31:
 * *"프리미어 딱 누르자마자 쇼츠화되어서 나와줘야 해."*
 *
 * 가로 원본 타임라인을 주면 편집자는 최종 프레이밍을 못 본다. 쇼츠는 세로에서 인물이
 * 어디 걸리는지가 전부라, **처음부터 세로로** 보여 줘야 자를지 말지 판단이 선다.
 *
 * 크롭(Motion 확대)은 **best-effort** 다 — 파라미터 이름이 버전·로케일에 따라 달라서
 * 못 찾을 수 있다. 못 해도 시퀀스는 이미 세로라, 편집자가 "프레임 크기로 설정" 한 번이면 된다.
 * 여기서 실패해도 전체를 실패시키지 않는 이유다.
 */
const SHORTS_W = 1080;
const SHORTS_H = 1920;

/**
 * 이 추천이 **서버에서 어떤 배치로 나가는지** 받아 온다.
 *
 * 숫자를 패널에 복제하지 않는다 — 프리셋을 고치면 프리미어 쪽만 옛 배치로 남는다.
 * 못 받으면 null 을 돌려 예전 동작(세로 꽉 채우기)으로 물러난다. 이것 때문에 전체가
 * 멈추면 안 된다.
 */
async function fetchLayout(rec) {
  if (!rec || !rec.id) return null;
  try {
    const res = await api(`/recommendations/${encodeURIComponent(rec.id)}/layout`, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.canvas && data.video ? data : null;
  } catch (_) {
    return null;      // 옛 서버 배포거나 네트워크 문제 — 폴백이 있다
  }
}

async function makeSequenceVertical(api, project, seq, onStage, layout) {
  try {
    // ① **바꾸기 전에** 지금 프레임 크기를 읽는다 — 마스터에서 만든 시퀀스라 이 값이 곧
    //    원본 해상도다. 서버에 해상도를 물을 필요가 없다.
    let src = null;
    try {
      const r = await seq.getFrameSize();
      const w = Number(r.width) || 0, h = Number(r.height) || 0;
      if (w > 0 && h > 0) src = { w, h };
    } catch (_) { /* 못 읽으면 배율 계산만 건너뛴다 */ }

    const canvas = (layout && layout.canvas) || { w: SHORTS_W, h: SHORTS_H };
    const settings = await seq.getSettings();
    const rect = new api.RectF();
    rect.width = canvas.w;
    rect.height = canvas.h;
    await settings.setVideoFrameRect(rect);
    const ok = lockedTransaction(project, 
      (compound) => { compound.addAction(seq.createSetSettingsAction(settings)); },
      `STEP-D 프레임 ${canvas.w}×${canvas.h}`,
    );
    if (ok === false) throw new Error("시퀀스 설정을 바꾸지 못했습니다.");

    // ② 프레임만 바꾸면 **영상은 원래 크기 그대로 가운데** 남는다(위아래 검은 띠).
    //    그렇다고 꽉 채우면 그것도 틀리다 — 기본 템플릿(9:16-crop-main)은 위 440px 이
    //    제목이 앉는 검은 띠라 영상이 그 아래 사각형에만 들어간다(사용자 2026-08-31:
    //    "영상 꽉 차게 아니고 레이아웃도 받아서 프리미어 재현"). 그래서 **서버가 준 배치**로.
    if (src) await placeClipsByLayout(api, project, seq, src, layout, onStage);
    return true;
  } catch (err) {
    // 전환 실패는 알린다 — 어긋난 채로 편집하면 그게 더 나쁘다.
    console.log("[STEP-D] 프레임 전환 실패", err);
    onStage(`⚠ 세로 전환에 실패했습니다 — 시퀀스 설정에서 직접 바꿔 주세요: ${err.message}`);
    return false;
  }
}

/**
 * 서버 배치를 프리미어에서 재현한다 — 영상이 **어디에 얼마나** 앉는지.
 *
 * layout 이 없으면(서버가 옛 배포거나 조회 실패) 세로 꽉 채우기로 물러난다. 그게 예전 동작이라
 * 나빠지지는 않는다.
 *
 *   fill:"rect"    → rect 사각형에 cover. 배율 = max(rect.w/원본w, rect.h/원본h),
 *                    위치 = rect 중심. (9:16-crop-main = 위 자막 띠 + 아래 큰 영상)
 *   fill:"cover"   → 프레임 전체에 cover, 가운데.
 *   fill:"contain" → 프레임 안에 전부 담기(레터박스), 가운데.
 */
async function placeClipsByLayout(api, project, seq, src, layout, onStage) {
  const canvas = (layout && layout.canvas) || { w: SHORTS_W, h: SHORTS_H };
  const video = (layout && layout.video) || { fill: "cover", rect: { x: 0, y: 0, w: canvas.w, h: canvas.h } };
  const box = video.rect || { x: 0, y: 0, w: canvas.w, h: canvas.h };

  const ratio = video.fill === "contain"
    ? Math.min(box.w / src.w, box.h / src.h)
    : Math.max(box.w / src.w, box.h / src.h);
  const scalePct = ratio * 100;
  // 프리미어의 Motion 위치는 **0..1 정규화**다(0.5,0.5 = 가운데).
  const posX = (box.x + box.w / 2) / canvas.w;
  const posY = (box.y + box.h / 2) / canvas.h;

  const moved = Math.abs(posX - 0.5) > 0.001 || Math.abs(posY - 0.5) > 0.001;
  const resized = Math.abs(scalePct - 100) > 0.5;
  if (!moved && !resized) return 0;

  return await setMotionOnClips(api, project, seq, {
    scale: resized ? scalePct : null,
    position: moved ? { x: posX, y: posY } : null,
  }, onStage);
}

/**
 * V1 클립들의 Motion(배율·위치)을 정한 값으로 맞춘다.
 *
 * 어떻게 찾나: 파라미터는 이름 접근자가 없어 **인덱스**로만 잡는다(0=위치 · 1=배율).
 * 대신 컴포넌트는 `getMatchName()` 이 `AE.ADBE Motion` 으로 **로케일과 무관**하게 고정이라
 * 그걸로 찾는다 — 한국어 프리미어에서 표시 이름은 "동작" 이라 표시 이름으로 찾으면 조용히 실패한다.
 *
 * best-effort 다. 실패해도 시퀀스 프레임은 이미 맞춰져 있고, 편집자가 클립을 골라 손으로
 * 맞출 수 있다 — 전체를 실패시킬 이유가 없다.
 */
const MOTION_MATCH_NAME = "AE.ADBE Motion";
const MOTION_POSITION_PARAM = 0;
const MOTION_SCALE_PARAM = 1;

async function setMotionOnClips(api, project, seq, want, onStage) {
  let touched = 0, seen = 0;
  try {
    const track = await seq.getVideoTrack(0);
    const clipType = (api.Constants && api.Constants.TrackItemType && api.Constants.TrackItemType.CLIP);
    const items = track.getTrackItems(clipType === undefined ? 1 : clipType, false) || [];
    for (const item of items) {
      seen += 1;
      const chain = await item.getComponentChain();
      const count = chain.getComponentCount();
      for (let i = 0; i < count; i += 1) {
        const comp = chain.getComponentAtIndex(i);
        let match = "";
        try { match = await comp.getMatchName(); } catch (_) { continue; }
        if (match !== MOTION_MATCH_NAME) continue;

        const actions = [];
        if (want.scale != null) {
          const p = comp.getParam(MOTION_SCALE_PARAM);
          actions.push(p.createSetValueAction(p.createKeyframe(want.scale), true));
        }
        if (want.position) {
          const p = comp.getParam(MOTION_POSITION_PARAM);
          actions.push(p.createSetValueAction(p.createKeyframe(new api.PointF(want.position.x, want.position.y)), true));
        }
        if (!actions.length) break;
        const ok = lockedTransaction(project, 
          (compound) => { for (const a of actions) compound.addAction(a); },
          "STEP-D 영상 배치",
        );
        if (ok !== false) touched += 1;
        break;
      }
    }
  } catch (err) {
    console.log("[STEP-D] 영상 배치 실패", err);
  }
  if (seen > 0 && touched === 0) {
    onStage("⚠ 프레임은 맞췄지만 영상 배치는 못 했습니다 — 클립의 '동작(Motion)' 에서 직접 맞춰 주세요.");
  }
  return touched;
}

async function buildRoughCut(recs, onStage) {
  const withMedia = recs.find((r) => r.mediaFilename || r.mediaId) || recs[0];
  onStage("원본 확인 중…");
  const filename = await ensureMaster(withMedia, onStage);

  // ① 구간마다 조각을 만든다 — 서브클립 버튼과 **같은 규칙**으로 이름 붙인다.
  //    원본 객체는 **찾은 자리에서 바로** 쓴다(await 를 건너면 무효가 된다).
  onStage(`${recs.length}개 구간 자르는 중…`);
  const srcName = await findMasterItem(filename, ({ api, project, clip, name }) => {
    const cut = lockedTransaction(project, (compound) => {
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
    return name;
  });

  // ② 방금 만든 조각을 이름으로 되찾는다(지연 액션이라 반환값이 없다).
  //    배치는 **미리** 받아 둔다 — 아래 콜백 안에서 await 하면 프리미어 객체가 무효가 된다.
  const layout = await fetchLayout(withMedia);
  onStage("조각 찾는 중…");
  const seqName = `[STEP-D] ${(withMedia.programTitle || srcName || "러프컷").slice(0, 40)} 러프컷`;
  // ②③ 을 한 흐름으로 — 찾은 조각을 **그 자리에서** 시퀀스로 만든다.
  return await findItemsByRecIds(recs.map((r) => r.id), async (found, project, api) => {
    // **추천 순서 그대로** 늘어놓는다 — 점수 순으로 온 목록이라 그게 곧 편집 순서다.
    const ordered = recs.map((r) => found.get(String(r.id))).filter(Boolean);
    if (!ordered.length) throw new Error("자른 조각을 프로젝트에서 찾지 못했습니다.");

    onStage("러프컷 시퀀스 만드는 중…");
    const seq = await project.createSequenceFromMedia(seqName, ordered);
    if (!seq) throw new Error("시퀀스를 만들지 못했습니다.");
    // **누르자마자 쇼츠 형태**로 보여 준다 — 가로로 주면 최종 프레이밍을 못 본다.
    const vertical = await makeSequenceVertical(api, project, seq, onStage, layout);
    // 만들고 안 열면 사용자는 "눌렀는데 아무 일도 안 일어났다" 고 느낀다.
    try { await project.setActiveSequence(seq); } catch (_) { /* 열기 실패는 치명적이지 않다 */ }

    return { seqName, placed: ordered.length, missing: recs.length - ordered.length, vertical };
  });
}

/** ① 원본 확보만 따로 — 러프컷 전에 큰 파일을 미리 받아 두고 진행 상황을 본다. */
async function doFetchSource() {
  const picks = visibleRecs();
  if (busy || !picks.length) return;
  busy = true;
  $("fetchSrcBtn").disabled = true;
  try {
    const withMedia = picks.find((r) => r.mediaFilename || r.mediaId) || picks[0];
    const filename = await ensureMaster(withMedia, (msg) => setStatus($("recsStatus"), msg));
    setStatus($("recsStatus"), `원본 준비 완료 — ${filename}. 이제 러프컷을 만들 수 있습니다.`, "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 원본 확보 실패", err);
  } finally {
    busy = false;
    syncRecButtons();
  }
}

/**
 * **주 동선 (사용자 확정 2026-08-31): 원본 받고 → 추천 구간에 마커.**
 *
 * 왜 마커가 제일 쓸모 있나: 서브클립은 경계가 잠겨(hasHardBoundaries) 앞뒤를 못 늘린다.
 * 편집자는 추천 구간을 **앞뒤로 조금씩 조절**하며 쓰므로, 표시만 해 주는 마커가 맞다.
 * 자른 조각이 필요하면 서브클립·러프컷 버튼이 따로 있다.
 *
 * ⚠️ **마커는 시퀀스에 꽂힌다.** 원본을 방금 받아 왔으면 그 원본이 담긴 타임라인이 아직
 *    없어서 꽂을 데가 없다. 그래서 활성 시퀀스가 없으면 **원본으로 하나 만들어** 준다.
 *    있으면 그걸 쓴다 — 편집자가 이미 작업 중인 타임라인을 빼앗지 않는다.
 */
async function ensureSequenceForMaster(filename, onStage, rec) {
  const layout = await fetchLayout(rec);
  const active = await activeSequence().catch(() => null);
  if (active) {
    // 우리가 만든 타임라인이면 세로로 맞춰 준다(이미 세로면 계산상 배율 100% → 아무 일도 안 한다).
    // 편집자 본인의 타임라인은 **건드리지 않는다** — 남의 작업 프레임을 말없이 바꾸면 안 된다.
    if (String(active.name || "").startsWith("[STEP-D] ")) {
      await makeSequenceVertical(active.api, active.project, active.sequence, onStage, layout);
    }
    return active.name;
  }

  onStage("원본으로 타임라인 만드는 중…");
  return await findMasterItem(filename, async ({ api, project, clip, name }) => {
    const seq = await project.createSequenceFromMedia(`[STEP-D] ${String(name).slice(0, 60)}`, [clip]);
    if (!seq) throw new Error("원본으로 시퀀스를 만들지 못했습니다.");
    // 마커만 꽂는 경로도 **세로로 시작**한다(사용자 2026-08-31) — 러프컷만 세로면
    // 편집자는 가로 화면을 보며 세로 결과물을 상상해야 한다.
    await makeSequenceVertical(api, project, seq, onStage, layout);
    try { await project.setActiveSequence(seq); } catch (_) { /* 열기 실패는 치명적이지 않다 */ }
    return name;
  });
}

/**
 * 고른 구간마다 제목 그래픽을 꽂는다. 값(문구·글꼴·색·위치)은 **서버가 정본**이다.
 *
 * 먼저 편집 가능한 .mogrt 를 시도하고, 그게 안 되면 PNG 로 물러난다. 둘 다 같은 서버 계산에서
 * 나오므로 모양은 같다 — 다른 건 "글자를 고칠 수 있나" 하나뿐이다.
 */
async function addTitlesForRecs(recs, onStage, layout) {
  const { aspect, tracks } = await titleTargetInfo(layout);

  // ① 편집 가능한 경로 먼저.
  let placed = 0;
  try {
    placed = await addTitleMogrts(recs, aspect, onStage);
    if (!placed) onStage("제목 그래픽을 못 얹어 이미지로 대체합니다…");
  } catch (err) {
    console.log("[STEP-D] mogrt 제목 실패 — PNG 로 폴백", err);
    onStage(`제목 그래픽 실패(${err.message}) — 이미지로 대체합니다…`);
  }
  // ② 폴백: 픽셀 그대로. 편집은 못 하지만 화면에는 나온다.
  if (!placed) placed = await addTitlePngs(recs, aspect, tracks, onStage);

  // ③ 제목 외 정적 오버레이(로고·시간박스·채널명) — 사용자 2026-08-31 "로고, 시간박스까지 다 재현".
  //    제목 위 트랙에 얹는다. 실패해도 제목은 이미 올라가 있으므로 조용히 넘어간다.
  try {
    await addDecorationsForRecs(recs, aspect, onStage);
  } catch (err) {
    console.log("[STEP-D] 로고·시간박스 실패", err);
  }
  return placed;
}

/**
 * 제목을 뺀 정적 오버레이(로고·시간박스·채널명)를 **한 장**으로 받아 얹는다.
 *
 * 왜 한 장인가: 서버가 렌더에 쓰는 그 ASS·그 아이콘 파일을 그대로 합성해 준다
 * (`GET /api/recommendations/:id/decorations.png`). 프리미어에서 도형·이미지를 따로 만들면
 * 여백·모서리가 미묘하게 달라지고, 그 어긋남은 나중에 아무도 못 찾는다.
 *
 * 트랙은 **제목보다 위(V3)** 다 — 시간박스가 제목 뒤로 가면 안 된다.
 */
async function addDecorationsForRecs(recs, aspect, onStage) {
  const folder = await mediaFolder();
  onStage("로고·시간박스 받는 중…");

  const files = [];
  for (const r of recs) {
    const q = `?aspect=${encodeURIComponent(aspect)}`;
    const res = await api(`/recommendations/${encodeURIComponent(r.id)}/decorations.png${q}`, { method: "GET" });
    if (res.status === 404 || res.status === 503) continue;   // 그릴 게 없거나 서버가 못 그린다
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const file = await folder.createFile(`stepd-deco-${r.id}.png`, { overwrite: true });
    await file.write(buf, { format: formats.binary });
    files.push({ rec: r, file });
  }
  if (!files.length) return 0;

  const { project } = await activeSequence();
  const ok = await project.importFiles(files.map((f) => f.file.nativePath), true);
  if (ok === false) return 0;

  const byName = new Map(files.map((f) => [f.file.name, f.rec]));
  return await findItemsByFileNames([...byName.keys()], async (found, project2, api2) => {
    const sequence = (await activeSequence()).sequence;
    const editor = api2.SequenceEditor.getEditor(sequence);
    let n = 0;
    for (const [name, rec] of byName) {
      const item = found.get(name);
      if (!item) continue;
      const at = api2.TickTime.createWithSeconds(Number(rec.startTime) || 0);
      const action = editor.createOverwriteItemAction(item, at, DECORATION_TRACK, 0);
      const done = lockedTransaction(project2, (c) => { c.addAction(action); }, `STEP-D 오버레이 ${name}`);
      if (done !== false) n += 1;
    }
    return n;
  });
}

/** V1=영상 · V2=제목 · V3=로고/시간박스 · V4=자막 (0-based 인덱스). */
const TITLE_TRACK = 1;
const DECORATION_TRACK = 2;
const CAPTION_TRACK = 3;

/**
 * 한 번에 얹는 자막 줄 상한. 60초 쇼츠가 보통 25~35줄이라 넉넉하다 —
 * 실수로 회차 전체(수백 줄)를 얹어 프리미어가 멎는 걸 막는 안전선이다.
 */
const CAPTION_MAX_LINES = 200;

/**
 * 자막을 **타임스탬프 그대로** 얹는다 (사용자 2026-08-31: "자막도 타임스탬프 맞춰서 재현").
 *
 * 줄마다 투명 PNG 한 장이다. 왜 이 모양인가:
 *  · 자막은 시간축 위에서 바뀌니 한 장으로 못 담는다.
 *  · 알파 동영상(ProRes 4444)으로 주면 1분에 수 GB 다.
 *  · 프리미어 **캡션 트랙**에는 API 로 얹을 수 없다(공식 선언에 배치 API 가 없다 —
 *    Transcript 는 마스터 클립에 붙는 것이고, 캡션 트랙 배치는 UI 조작뿐이다).
 * 그래서 정지 PNG 를 줄 길이만큼 V4 에 놓는다 — 글꼴·색·위치·시각이 결과물과 같다.
 *
 * ⚠️ 카라오케(단어별 색 스윕)는 재현되지 않는다 — 정지 이미지의 한계다.
 */
async function addCaptionsForRecs(recs, aspect, onStage) {
  // ① 편집 가능한 경로 먼저 — 제목과 같은 원칙이다.
  try {
    const placed = await addCaptionMogrts(recs, aspect, onStage);
    if (placed > 0) return placed;
  } catch (err) {
    console.log("[STEP-D] 자막 mogrt 실패 — PNG 로 폴백", err);
  }
  // ② 폴백: 정지 PNG. 박스형 자막 스타일(서버가 409)도 여기로 온다 — 모양이 정확한 쪽이 낫다.
  return await addCaptionPngs(recs, aspect, onStage);
}

/**
 * 자막 줄마다 **편집 가능한 .mogrt** 를 꽂는다.
 *
 * insertMogrtFromPath 는 넣은 트랙 아이템 배열을 돌려준다 — 그걸로 **끝 시각을 줄 길이에 맞춘다**
 * (안 하면 그래픽 기본 길이로 들어가 자막끼리 겹친다).
 */
async function addCaptionMogrts(recs, aspect, onStage) {
  const folder = await mediaFolder();
  const jobs = await captionJobs(recs, aspect);
  if (!jobs.length) return 0;

  onStage(`자막 ${jobs.length}줄 받는 중…`);
  const files = [];
  for (const job of jobs) {
    const q = `?i=${job.i}&aspect=${encodeURIComponent(aspect)}`;
    const res = await api(`/recommendations/${encodeURIComponent(job.rec.id)}/caption.mogrt${q}`, { method: "GET" });
    if (res.status === 409) return 0;      // 베이스 미등록 · 박스형 스타일 — 통째로 PNG 로 간다
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const file = await folder.createFile(`stepd-cap-${job.rec.id}-${job.i}.mogrt`, { overwrite: true });
    await file.write(buf, { format: formats.binary });
    files.push({ ...job, file });
  }
  if (!files.length) return 0;

  onStage(`자막 ${files.length}줄 얹는 중…`);
  let n = 0;
  for (const job of files) {
    try {
      // 매 줄마다 다시 얻는다 — 앞 줄의 삽입(await) 이 앞서 얻은 객체를 무효로 만든다.
      const { api: api2, project, sequence } = await activeSequence();
      const editor = api2.SequenceEditor.getEditor(sequence);
      const startSec = (Number(job.rec.startTime) || 0) + (Number(job.line.start) || 0);
      const dur = Math.max(0.2, Number(job.line.end) - Number(job.line.start));
      const inserted = await editor.insertMogrtFromPath(
        job.file.nativePath, api2.TickTime.createWithSeconds(startSec), CAPTION_TRACK, 0);
      const item = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!item) continue;
      // 길이 맞추기 — 넣자마자 그 자리에서(await 를 건너면 객체가 무효가 된다).
      if (typeof item.createSetEndAction === "function") {
        const end = api2.TickTime.createWithSeconds(startSec + dur);
        lockedTransaction(project, (c) => { c.addAction(item.createSetEndAction(end)); }, `STEP-D 자막 길이 ${job.i}`);
      }
      n += 1;
    } catch (err) {
      console.log("[STEP-D] 자막 mogrt 삽입 실패", job.i, err);
    }
  }
  return n;
}

/** 자막 줄 목록을 모아 상한까지 자른다 — mogrt·PNG 두 경로가 **같은 줄**을 쓰게. */
async function captionJobs(recs, aspect) {
  const jobs = [];
  for (const rec of recs) {
    const res = await api(`/recommendations/${encodeURIComponent(rec.id)}/captions?aspect=${encodeURIComponent(aspect)}`, { method: "GET" });
    if (!res.ok) continue;
    const data = await res.json().catch(() => null);
    const lines = data && Array.isArray(data.lines) ? data.lines : [];
    for (let i = 0; i < lines.length && jobs.length < CAPTION_MAX_LINES; i += 1) {
      jobs.push({ rec, i, line: lines[i] });
    }
  }
  return jobs;
}

async function addCaptionPngs(recs, aspect, onStage) {
  const folder = await mediaFolder();
  const jobs = await captionJobs(recs, aspect);
  if (!jobs.length) return 0;

  onStage(`자막 이미지 ${jobs.length}줄 받는 중…`);
  const files = [];
  for (const job of jobs) {
    const q = `?i=${job.i}&aspect=${encodeURIComponent(aspect)}`;
    const res = await api(`/recommendations/${encodeURIComponent(job.rec.id)}/caption.png${q}`, { method: "GET" });
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const file = await folder.createFile(`stepd-cap-${job.rec.id}-${job.i}.png`, { overwrite: true });
    await file.write(buf, { format: formats.binary });
    files.push({ ...job, file });
  }
  if (!files.length) return 0;

  const { project } = await activeSequence();
  const ok = await project.importFiles(files.map((f) => f.file.nativePath), true);
  if (ok === false) return 0;

  onStage(`자막 ${files.length}줄 얹는 중…`);
  const byName = new Map(files.map((f) => [f.file.name, f]));
  return await findItemsByFileNames([...byName.keys()], async (found, project2, api2) => {
    const sequence = (await activeSequence()).sequence;
    const editor = api2.SequenceEditor.getEditor(sequence);
    let n = 0;
    for (const [name, job] of byName) {
      const item = found.get(name);
      if (!item) continue;
      const dur = Math.max(0.2, Number(job.line.end) - Number(job.line.start));
      const at = api2.TickTime.createWithSeconds((Number(job.rec.startTime) || 0) + (Number(job.line.start) || 0));
      // **길이를 먼저 정한다.** 안 하면 정지 이미지 기본 길이(환경설정 · 보통 5초)로 들어가
      // 자막이 서로 덮어써진다.
      const inOut = item.createSetInOutPointsAction(
        api2.TickTime.createWithSeconds(0), api2.TickTime.createWithSeconds(dur));
      const place = editor.createOverwriteItemAction(item, at, CAPTION_TRACK, 0);
      const done = lockedTransaction(project2, (c) => { c.addAction(inOut); c.addAction(place); }, `STEP-D 자막 ${name}`);
      if (done !== false) n += 1;
    }
    return n;
  });
}

/**
 * 제목을 어떤 모양으로 받아 어디에 얹을지.
 *
 * 배치를 받아 왔으면 **그 aspect 를 그대로 쓴다** — 타임라인 프레임만 보고 추측하면
 * 위 자막 띠(crop-main)와 위아래 띠(crop-sub)를 구분하지 못해 제목이 엉뚱한 높이에 앉는다.
 */
async function titleTargetInfo(layout) {
  // 세로 러프컷에 가로 그림(또는 그 반대)을 얹으면 프리미어가 프레임에 맞춰 늘리거나 잘라서,
  // 서버 미리보기와 글자 위치가 달라진다.
  const { sequence } = await activeSequence();
  let aspect = (layout && layout.aspect) || "9:16-crop-main";
  let tracks = 0;
  if (!(layout && layout.aspect)) {
    try {
      const size = await sequence.getFrameSize();
      if (Number(size.width) >= Number(size.height)) aspect = "16:9";
    } catch (_) { /* 못 읽으면 쇼츠로 둔다 — 이 패널의 기본 산출물이 세로다 */ }
  }
  try { tracks = Number(await sequence.getVideoTrackCount()) || 0; } catch (_) { /* 판단 보류 */ }
  return { aspect, tracks };
}

/**
 * .mogrt 를 구간 시작마다 꽂는다.
 *
 * PNG 와 달리 **프로젝트로 import 하지 않는다** — `insertMogrtFromPath` 가 파일 경로를 직접
 * 받아 시퀀스에 꽂고, 프리미어가 알아서 프로젝트 안으로 복사한다.
 */
async function addTitleMogrts(recs, aspect, onStage) {
  const folder = await mediaFolder();
  onStage("제목 그래픽 받는 중…");

  const files = [];
  for (const r of recs) {
    const f = await fetchTitleMogrt(r, folder, aspect, onStage);
    if (f) files.push({ rec: r, file: f });
  }
  if (!files.length) return 0;

  let placed = 0;
  for (const { rec, file } of files) {
    try {
      // ⚠️ editor·sequence 를 루프 밖에서 들고 있으면 **첫 삽입 직후 무효**가 된다
      //    (insertMogrtFromPath 가 await 다). 매번 다시 얻는 게 유일하게 안전한 방법이다.
      const { api, sequence } = await activeSequence();
      const editor = api.SequenceEditor.getEditor(sequence);
      const at = api.TickTime.createWithSeconds(Number(rec.startTime) || 0);
      // V2(인덱스 1) — V1 영상 위. 오디오 트랙은 안 쓴다.
      // 반환은 **꽂힌 트랙 아이템 배열**이다(Action 이 아니라 즉시 실행) — 비면 실패다.
      const inserted = await editor.insertMogrtFromPath(file.nativePath, at, TITLE_TRACK, 0);
      if (Array.isArray(inserted) ? inserted.length > 0 : inserted != null && inserted !== false) placed += 1;
    } catch (err) {
      console.log("[STEP-D] mogrt 삽입 실패", rec.id, err);
    }
  }
  return placed;
}

async function addTitlePngs(recs, aspect, tracks, onStage) {
  const folder = await mediaFolder();
  onStage("제목 이미지 받는 중…");

  // 먼저 **전부 받아서** 한 번에 가져온다 — importFiles 를 건마다 부르면 느리다.
  const files = [];
  for (const r of recs) {
    const f = await fetchTitlePng(r, folder, aspect);
    if (f) files.push({ rec: r, file: f });
  }
  if (!files.length) return 0;

  const { project } = await activeSequence();
  const ok = await project.importFiles(files.map((f) => f.file.nativePath), true);
  if (ok === false) throw new Error("제목 이미지를 프로젝트로 가져오지 못했습니다.");

  const byName = new Map(files.map((f) => [f.file.name, f.rec]));
  const placed = await findItemsByFileNames([...byName.keys()], async (found, project2, api2) => {
    const sequence = (await activeSequence()).sequence;
    const editor = api2.SequenceEditor.getEditor(sequence);
    let n = 0;
    for (const [name, rec] of byName) {
      const item = found.get(name);
      if (!item) continue;
      const at = api2.TickTime.createWithSeconds(Number(rec.startTime) || 0);
      // V2(인덱스 1)에 얹는다 — V1 의 영상 위에 있어야 제목이 보인다. 오디오는 없다.
      const action = editor.createOverwriteItemAction(item, at, TITLE_TRACK, 0);
      const done = lockedTransaction(project2, (c) => { c.addAction(action); }, `STEP-D 제목 ${name}`);
      if (done !== false) n += 1;
    }
    return n;
  });

  // 하나도 못 얹었는데 트랙이 하나뿐이면 **그게 이유다.** 프리미어에는 트랙 추가 API 가
  // 없어서(타입 정의 확인) 우리가 만들어 줄 수 없다 — 사람이 할 일을 정확히 말해 준다.
  if (placed === 0 && tracks > 0 && tracks < 2) {
    throw new Error("타임라인에 비디오 트랙이 V1 뿐입니다 — V2 를 하나 추가하고 다시 눌러 주세요.");
  }
  return placed;
}

/** ① 원본 확보 → ② 없으면 타임라인 생성 → ③ 고른 구간에 마커. 편집자는 여기서부터 다듬는다. */
async function doPrepareAndMark() {
  const picks = chosenRecs();
  if (busy || !picks.length) return;
  busy = true;
  syncRecButtons();
  try {
    const onStage = (m) => setStatus($("recsStatus"), m);
    const withMedia = picks.find((r) => r.mediaFilename || r.mediaId) || picks[0];

    // 단계마다 이름을 붙인다 — 프리미어 오류 원문("The script object is no longer valid")만
    // 보면 **어디서 났는지** 알 수 없다. 화면에 뜨는 한 줄이 곧 다음 수리의 출발점이다.
    onStage("원본 확인 중…");
    const filename = await stage("원본 확인", () => ensureMaster(withMedia, onStage));
    await stage("타임라인 준비", () => ensureSequenceForMaster(filename, onStage, withMedia));

    onStage(`마커 ${picks.length}개 꽂는 중…`);
    const { sequenceName, count } = await stage("마커 꽂기", () => addMarkersForRecs(picks));

    // 제목 그래픽은 **선택적 단계**다 — 서버 렌더가 막혀도(캔버스 미가용 등) 마커까지는 남아야 한다.
    // 여기서 실패했다고 앞의 성과를 버리면 편집자는 처음부터 다시 해야 한다.
    let titleNote = "";
    try {
      const placed = await addTitlesForRecs(picks, onStage, await fetchLayout(withMedia));
      titleNote = placed > 0 ? ` · 제목 ${placed}개` : "";
    } catch (err) {
      titleNote = ` · 제목은 건너뜀(${err.message})`;
      console.log("[STEP-D] 제목 삽입 건너뜀", err);
    }

    setStatus($("recsStatus"),
      `"${sequenceName}" 에 마커 ${count}개${titleNote}. 목록에서 제목을 누르면 그 구간으로 이동합니다.`, "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 준비+마커 실패", err);
  } finally {
    busy = false;
    syncRecButtons();
  }
}

async function doRoughCut() {
  const picks = chosenRecs();
  if (busy || !picks.length) return;
  busy = true;
  $("roughcutBtn").disabled = true;
  try {
    const { seqName, placed, missing } = await buildRoughCut(picks, (m) => setStatus($("recsStatus"), m));
    setStatus($("recsStatus"),
      `"${seqName}" 을 만들었습니다 — ${placed}개 구간이 순서대로 놓였습니다.`
      + (missing > 0 ? ` (${missing}개는 조각을 못 찾아 빠졌습니다)` : ""), "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 러프컷 실패", err);
  } finally {
    busy = false;
    syncRecButtons();
  }
}

async function doMakeSubclips() {
  const picks = chosenRecs();
  if (busy || !picks.length) return;
  busy = true;
  $("subclipBtn").disabled = true;
  try {
    const { sourceName, count } = await makeSubclipsForRecs(picks, (m) => setStatus($("recsStatus"), m));
    setStatus($("recsStatus"),
      `"${sourceName}" 에서 ${count}개 구간을 잘라 프로젝트에 넣었습니다. 되돌리려면 Ctrl+Z 한 번.`, "ok");
  } catch (err) {
    setStatus($("recsStatus"), err.message, "err");
    console.log("[STEP-D] 서브클립 실패", err);
  } finally {
    busy = false;
    syncRecButtons();
  }
}

let recRows = [];

/**
 * 편집자 동선(사용자 2026-08-31): *"나는솔로 3화 편집본 만들어야 해"* →
 * **프로그램 → 회차 → 추천을 보고 골라서** 편집. 그래서 회차로 거르고, 줄마다 체크로 고른다.
 *
 * 예전엔 회차가 섞여 나오고 버튼이 **목록 전체**에 작용했다 — 3화를 만들려는데 1·2화 구간이
 * 같이 잘려 들어갔다. 편집자가 쓸 수 없는 도구다.
 */
let selectedIds = new Set();

/** 지금 화면에 보일 추천 — 회차 필터를 지난 것. */
function visibleRecs() {
  const ep = $("episode") ? $("episode").value : "";
  if (!ep) return recRows;
  return recRows.filter((r) => String(r.episodeId || "") === ep);
}

/** 실제로 작업할 대상 — 보이는 것 중 **체크된 것만**. */
function chosenRecs() {
  return visibleRecs().filter((r) => selectedIds.has(String(r.id)));
}

/** 회차 드롭다운을 추천 목록에서 만든다(서버 왕복 없이). 최신 회차가 위로. */
function renderEpisodes() {
  const sel = $("episode");
  if (!sel) return;
  const seen = new Map();
  for (const r of recRows) {
    const id = String(r.episodeId || "");
    if (!id || seen.has(id)) continue;
    seen.set(id, r.episodeNumber ? `${r.episodeNumber}회` : "회차 미상");
  }
  const prev = sel.value;
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = ""; all.textContent = `전체 (${recRows.length}건)`;
  sel.appendChild(all);
  const entries = [...seen.entries()].sort((a, b) => b[1].localeCompare(a[1], "ko", { numeric: true }));
  for (const [id, label] of entries) {
    const n = recRows.filter((r) => String(r.episodeId || "") === id).length;
    const o = document.createElement("option");
    o.value = id; o.textContent = `${label} (${n}건)`;
    sel.appendChild(o);
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function syncRecButtons() {
  const n = chosenRecs().length;
  for (const [id, label] of [
    ["prepMarkBtn", "원본 받고 → 추천 구간에 마커 꽂기"],
    ["roughcutBtn", "러프컷 시퀀스 만들기"],
    ["markersBtn", "마커만 꽂기"],
    ["subclipBtn", "구간을 서브클립으로 자르기"],
  ]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = busy || n === 0;
    el.textContent = n > 0 ? `${label} (${n}건)` : label;
  }
  const fetchBtn = $("fetchSrcBtn");
  if (fetchBtn) fetchBtn.disabled = busy || visibleRecs().length === 0;
}

function renderRecs() {
  const list = $("recsList");
  list.innerHTML = "";
  for (const r of visibleRecs()) {
    const row = document.createElement("div");
    row.className = "rec";

    const head = document.createElement("div");
    head.className = "rec-head";

    // 고르기 — 체크된 것만 작업 대상이다.
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "rec-check";
    box.checked = selectedIds.has(String(r.id));
    box.addEventListener("change", () => {
      if (box.checked) selectedIds.add(String(r.id)); else selectedIds.delete(String(r.id));
      syncRecButtons();
    });

    const title = document.createElement("div");
    title.className = "rec-title";
    title.textContent = r.title || "(제목 없음)";
    // 제목을 누르면 그 구간으로 이동한다(체크박스와 겹치지 않게 제목에만 건다).
    title.addEventListener("click", () => void jumpToRec(r));

    head.appendChild(box);
    head.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "rec-meta";
    const dur = Math.max(0, Math.round(Number(r.endTime) - Number(r.startTime)));
    const score = r.score100 === null || r.score100 === undefined ? "—" : `${r.score100}점`;
    const ep = r.episodeNumber ? `${r.episodeNumber}회 · ` : "";
    // 프레임 메타가 없는 회차는 여기서 밝힌다 — 정합을 못 맞추는 걸 조용히 넘기지 않는다.
    const warn = r.fps ? "" : " · ⚠ 프레임 정합 불가(원본 메타 없음)";
    meta.textContent = `${ep}${fmtTime(r.startTime)}–${fmtTime(r.endTime)} · ${dur}초 · ${score}${warn}`;

    row.appendChild(head);
    row.appendChild(meta);
    list.appendChild(row);
  }
  syncRecButtons();
}

/**
 * 추천을 누르면 **그 구간만의 세로 시퀀스**를 만들어 연다 (사용자 2026-08-31:
 * *"누르면 새 시퀀스 만들어서 틀어주자."*).
 *
 * 왜 이게 이동보다 나은가: 원본 타임라인에서 그 시각으로 점프해 봐야 **가로 원본**이 보인다.
 * 편집자가 판단해야 하는 건 "이 구간이 **쇼츠로** 쓸 만한가" 라, 세로 프레임에 제목까지 얹힌
 * 상태를 봐야 한다. 그래서 누를 때마다 그 구간을 잘라 세로 시퀀스로 만들어 띄운다.
 *
 * 두 번째부터는 **다시 만들지 않는다** — 같은 이름의 시퀀스가 이미 있으면 그걸 연다.
 * (누를 때마다 새로 만들면 프로젝트가 같은 이름 시퀀스로 뒤덮인다)
 *
 * ⚠️ **재생 버튼을 대신 눌러 줄 수는 없다.** UXP 에는 트랜스포트(재생/정지) API 가 없다
 *    (공식 선언 확인 — 있는 건 getPlayerPosition·setPlayerPosition 뿐). 그래서 여기까지가
 *    한계다: 시퀀스를 열고 재생헤드를 0 에 둔다. 스페이스바는 사람이 누른다.
 */
function recSequenceName(r) {
  return `[STEP-D] ${String(r.title || "추천").slice(0, 40)} · ${r.id}`;
}

async function openRecSequence(r) {
  // **활성 시퀀스는 필요 없다** — 우리가 만들 참이다.
  const { api, project } = await activeProject();

  // ① 이미 만들어 둔 게 있으면 그걸 연다.
  const name = recSequenceName(r);
  const existing = await findSequenceByName(project, name);
  if (existing) {
    await project.setActiveSequence(existing);
    try { await existing.setPlayerPosition(api.TickTime.createWithSeconds(0)); } catch (_) { /* 위치는 부가 */ }
    return { name, reused: true };
  }

  // ② 없으면 원본에서 그 구간만 잘라 만든다. 원본이 프로젝트에 있어야 한다 —
  //    없으면 받아오는 데 수 분이 걸리므로 여기서는 시키지 않고 안내만 한다.
  const filename = String(r.mediaFilename || "");
  if (!filename) throw new Error("이 추천에 연결된 원본 파일 정보가 없습니다.");

  await findMasterItem(filename, ({ api: api2, project: project2, clip }) => {
    const ok = lockedTransaction(project2, (compound) => {
      compound.addAction(clip.createSubClipAction(
        subclipName(r),
        api2.TickTime.createWithSeconds(Number(r.startTime) || 0),
        api2.TickTime.createWithSeconds(Number(r.endTime) || 0),
        true,
      ));
    }, `STEP-D 미리보기 조각 ${r.id}`);
    if (ok === false) throw new Error("구간을 자르지 못했습니다 — 원본이 오프라인인지 확인하세요.");
    return true;
  });

  // 배치는 **콜백 밖에서** 미리 받는다 — 안에서 await 하면 프리미어 객체가 무효가 된다.
  const layout = await fetchLayout(r);
  return await findItemsByRecIds([r.id], async (found, project2, api2) => {
    const piece = found.get(String(r.id));
    if (!piece) throw new Error("자른 조각을 프로젝트에서 찾지 못했습니다.");
    const seq = await project2.createSequenceFromMedia(name, [piece]);
    if (!seq) throw new Error("시퀀스를 만들지 못했습니다.");
    await makeSequenceVertical(api2, project2, seq, (m) => setStatus($("recsStatus"), m), layout);
    try { await project2.setActiveSequence(seq); } catch (_) { /* 열기 실패는 치명적이지 않다 */ }
    return { name, reused: false };
  });
}

/** 이름으로 시퀀스를 찾는다. 없으면 null — 만들어야 한다는 뜻이다. */
async function findSequenceByName(project, name) {
  try {
    const seqs = await project.getSequences();
    for (const s of seqs || []) {
      const n = (await readMaybe(s, "name", "getName")) || "";
      if (String(n) === name) return s;
    }
  } catch (_) { /* 목록을 못 읽으면 새로 만든다 */ }
  return null;
}

async function jumpToRec(r) {
  if (busy) return;
  busy = true;
  syncRecButtons();
  try {
    setStatus($("recsStatus"), `"${r.title}" 미리보기 만드는 중…`);
    const { name, reused } = await stage("미리보기 시퀀스", () => retryStale("미리보기", () => openRecSequence(r)));

    // 오버레이는 **선택적**이다 — 실패해도 구간 미리보기는 이미 열려 있다.
    let note = "";
    if (!reused) {
      const onStage = (m) => setStatus($("recsStatus"), m);
      const layout = await fetchLayout(r);
      // 미리보기 시퀀스는 그 구간이 0초에서 시작한다 — 시각을 그렇게 옮겨 넘긴다.
      const local = { ...r, startTime: 0 };
      try {
        const placed = await addTitlesForRecs([local], onStage, layout);
        note += placed > 0 ? " · 제목" : "";
      } catch (err) {
        note += ` · 제목 건너뜀(${err.message})`;
        console.log("[STEP-D] 미리보기 제목 실패", err);
      }
      // 자막은 **미리보기에서만** 얹는다. 원본 전체 타임라인에 얹으면 회차 하나가 수백 줄이라
      // 프리미어가 버겁고, 편집자가 보려는 것도 "이 구간이 쇼츠로 어떻게 보이나" 다.
      try {
        const caps = await addCaptionsForRecs([local], (layout && layout.aspect) || "9:16-crop-main", onStage);
        note += caps > 0 ? ` · 자막 ${caps}줄` : "";
      } catch (err) {
        note += ` · 자막 건너뜀(${err.message})`;
        console.log("[STEP-D] 미리보기 자막 실패", err);
      }
    }
    setStatus($("recsStatus"),
      `"${name}" ${reused ? "를 열었습니다" : "를 만들었습니다"}${note}. 스페이스바로 재생하세요.`, "ok");
  } catch (err) {
    // 원본이 아직 없거나 프로젝트 밖이면 만들 수 없다 — 그때는 예전처럼 그 시각으로 이동한다.
    try {
      await seekActiveSequence(Number(r.startTime) || 0);
      setStatus($("recsStatus"),
        `미리보기를 못 만들어(${err.message}) ${fmtTime(r.startTime)} 으로 이동했습니다.`, "err");
    } catch (_) {
      setStatus($("recsStatus"), err.message, "err");
    }
    console.log("[STEP-D] 미리보기 실패", err);
  } finally {
    busy = false;
    syncRecButtons();
  }
}

async function loadRecs() {
  const programId = selectedProgram();
  setStatus($("recsStatus"), "불러오는 중…");
  try {
    const q = programId ? `?programId=${encodeURIComponent(programId)}&limit=50` : "?limit=50";
    const data = await apiJson(`/recommendations${q}`);
    recRows = Array.isArray(data.recommendations) ? data.recommendations : [];
    // 기본은 **전부 선택** — 보통은 다 쓰고, 빼고 싶은 것만 빼는 편이 손이 덜 간다.
    selectedIds = new Set(recRows.map((r) => String(r.id)));
    renderEpisodes();
    renderRecs();
    setStatus(
      $("recsStatus"),
      recRows.length
        ? `채택 대기 ${recRows.length}건 · 회차를 고르고 쓸 것만 체크하세요 (제목을 누르면 그 구간으로 이동)`
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
async function runUpload(source, programId, context) {
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
        // 제목은 **추천 제목**이 있으면 그걸 쓴다 — 파일명(stepd-export-….mp4)이 그대로
        // 배포 목록에 뜨면 사람이 뭘 올렸는지 못 알아본다.
        // 우리가 모르면 **아예 안 보낸다** — 서버가 추천에서 물려받을 기회를 남긴다
        // (추천 목록을 안 연 채 업로드 탭에서 바로 렌더하는 경우가 그렇다).
        ...(context && context.title ? { title: context.title }
            : context && context.recommendationId ? {}
            : { title: source.name.replace(/\.[^.]+$/, "") }),
        // 어느 회차·추천에서 나온 편집본인지. 없으면 예전처럼 프로그램에만 붙는다.
        ...(context && context.episodeNumber !== undefined ? { episodeNumber: context.episodeNumber } : {}),
        ...(context && context.recommendationId ? { recommendationId: context.recommendationId } : {}),
        ...(context && context.editKind ? { editKind: context.editKind } : {}),
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
    // **무엇을 편집한 것인지** 먼저 알아낸다 — 렌더가 끝난 뒤엔 시퀀스가 바뀌어 있을 수 있다.
    const context = await exportContext();
    const rendered = await exportActiveSequence((msg) => setStatus($("status"), msg));
    console.log(`[STEP-D] rendered ${rendered.nativePath} · ${rendered.size} bytes`, context);
    await runUpload(rendered, selectedProgram(), context);
  });
}

/**
 * 지금 내보낼 시퀀스가 **어느 추천의 편집본인지** 찾아 낸다.
 *
 * 우리가 만든 미리보기 시퀀스(`[STEP-D] … · <추천id>`)면 그 추천의 제목·회차를 물려준다.
 * 편집자가 만든 시퀀스면 아무것도 못 찾는데, 그때는 예전처럼 프로그램에만 붙는다 —
 * **끈이 끊겨도 업로드는 되는 쪽**으로 둔다.
 */
async function exportContext() {
  try {
    const { name } = await activeSequence();
    const recId = recIdFromName(name);
    if (!recId) return null;
    const rec = recRows.find((r) => String(r.id) === recId);
    if (!rec) return { recommendationId: recId, editKind: "short" };
    return {
      recommendationId: recId,
      title: rec.title || undefined,
      episodeNumber: rec.episodeNumber,
      editKind: "short",
    };
  } catch (_) {
    return null;      // 시퀀스를 못 읽어도 업로드는 막지 않는다
  }
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
  $("episode").addEventListener("change", () => renderRecs());
  $("selectAllBtn").addEventListener("click", () => {
    const vis = visibleRecs();
    const allOn = vis.length > 0 && vis.every((r) => selectedIds.has(String(r.id)));
    for (const r of vis) {
      if (allOn) selectedIds.delete(String(r.id)); else selectedIds.add(String(r.id));
    }
    renderRecs();
  });
  $("markersBtn").addEventListener("click", () => void doAddMarkers());
  $("roughcutBtn").addEventListener("click", () => void doRoughCut());
  $("fetchSrcBtn").addEventListener("click", () => void doFetchSource());
  $("prepMarkBtn").addEventListener("click", () => void doPrepareAndMark());
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
    warnIfFontsMissing();
    startHandoffPolling();
  } else {
    show("login");
    const email = await store.get("stepd.email");
    if (email) $("email").value = email;
  }
})();
