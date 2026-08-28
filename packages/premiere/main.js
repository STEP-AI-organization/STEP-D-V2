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
    if (nodeFs && typeof nodeFs.openSync === "function") fd = nodeFs.openSync(nativePath, "r");
    else nodeFs = null;
  } catch (_) {
    nodeFs = null;
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

function contentTypeFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "mov") return "video/quicktime";
  if (ext === "mxf") return "application/mxf";
  if (ext === "m4v") return "video/x-m4v";
  return "video/mp4";
}

async function doUpload() {
  if (!picked || busy) return;
  const programId = $("program").value;
  if (!programId) return;

  busy = true;
  syncUploadButton();
  $("pickBtn").disabled = true;
  setProgress(0);

  const reader = makeReader(picked.entry, picked.nativePath, picked.size);
  try {
    setStatus($("status"), "업로드 세션 여는 중…");
    const init = await apiJson("/media/upload-init", {
      method: "POST",
      body: JSON.stringify({
        programId,
        filename: picked.name,
        contentType: contentTypeFor(picked.name),
      }),
    });

    if (init.mode !== "resumable") {
      throw new Error("이 서버는 대용량 업로드(GCS)가 꺼져 있습니다 — 관리자에게 문의하세요.");
    }

    setStatus($("status"), "업로드 중…");
    await uploadResumable(init.sessionUrl, reader, picked.size, (pct) => {
      setProgress(pct);
      setStatus($("status"), `업로드 중… ${pct}%`);
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
        filename: picked.name,
        contentType: contentTypeFor(picked.name),
        size: picked.size,
        title: picked.name.replace(/\.[^.]+$/, ""),
      }),
    });

    await store.set("stepd.lastProgram", programId);
    setProgress(100);
    const clipTitle = done.clip && done.clip.title ? done.clip.title : picked.name;
    setStatus($("status"), `업로드 완료 — "${clipTitle}" 이(가) STEP-D 에 등록됐습니다. 배포는 웹에서 진행하세요.`, "ok");
    picked = null;
    $("fileBox").className = "file";
    $("fileBox").textContent = "렌더한 MP4 를 선택하세요";
  } catch (err) {
    setStatus($("status"), `실패: ${err.message}`, "err");
  } finally {
    reader.close();
    busy = false;
    $("pickBtn").disabled = false;
    syncUploadButton();
  }
}

async function doLogout() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  await session.clear();
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
  $("logoutBtn").addEventListener("click", doLogout);
  $("program").addEventListener("change", syncUploadButton);

  const restored = await session.restore();
  if (restored) {
    show("upload");
    await loadPrograms();
  } else {
    show("login");
    const email = await store.get("stepd.email");
    if (email) $("email").value = email;
  }
})();
