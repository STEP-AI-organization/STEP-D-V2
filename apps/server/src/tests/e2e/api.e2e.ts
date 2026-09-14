/**
 * 서버 API e2e — 진짜 DB · 진짜 서버 프로세스에 HTTP 로 묻는다.
 *
 * 띄우고 정리하는 건 `scripts/e2e.mts` 가 한다. 여기는 **묻는 것만** 있다.
 * 실행: `pnpm --filter @stepd/server test:e2e` (CI 는 같은 명령을 돌린다)
 *
 * ## 여기 무엇을 넣고 무엇을 안 넣나
 *
 * 넣는 것은 **DB 없이는 증명할 수 없는 것**뿐이다:
 *   · 로그인이 실제로 되고, 안 된 채로는 못 들어간다
 *   · **테넌트 격리가 실제로 남의 행을 막는다** ← 이게 이 파일의 존재 이유다
 *
 * 순수 함수로 증명되는 것(문구·계산·조합)은 여기 넣지 않는다 — 단위 테스트가 훨씬 빠르고,
 * e2e 가 길어지면 사람이 안 돌린다.
 *
 * ⚠️ `*.e2e.ts` 확장자는 의도적이다. 서버 test 스크립트는 `src/**\/*.test.ts` 를 돌리므로
 *    이 파일들은 **`pnpm check` 에 안 끼어든다**(거긴 DB 가 없다).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:4100";

/** 브라우저 없이 세션 쿠키를 들고 다니는 최소 쿠키 단지. */
class Session {
  private cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    return res;
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body: body as T };
  }

  post<T = any>(path: string, body: unknown) {
    return this.json<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  async login(email: string, password: string): Promise<void> {
    const { status, body } = await this.post("/api/auth/login", { email, password });
    assert.equal(status, 200, `로그인 실패 (${email}): ${JSON.stringify(body)}`);
  }
}

const SUPERADMIN = { email: "super@e2e.local", password: "e2e-superadmin-pw" };

describe("e2e — 기동과 인증", () => {
  it("/health 가 응답한다", async () => {
    const res = await new Session().fetch("/health");
    assert.equal(res.status, 200);
  });

  it("로그인 없이 /api/state 를 못 본다", async () => {
    // AUTH_REQUIRED=1 (프로덕션과 같은 설정). 여기가 200 이면 워크스페이스 데이터가
    // 인증 없이 새는 것이다 — 소스 스캔으로는 잡히지 않는 종류다.
    const { status } = await new Session().json("/api/state");
    assert.equal(status, 401, "인증 없이 /api/state 가 열렸다");
  });

  it("비밀번호가 틀리면 401", async () => {
    const { status } = await new Session().post("/api/auth/login", {
      email: SUPERADMIN.email,
      password: "wrong-password",
    });
    assert.equal(status, 401);
  });

  it("없는 계정도 401 이다 — 계정 존재 여부가 새지 않는다", async () => {
    const { status } = await new Session().post("/api/auth/login", {
      email: "nobody@e2e.local",
      password: "whatever",
    });
    assert.equal(status, 401);
  });

  it("superadmin 으로 로그인하면 /api/auth/me 가 그 사람을 준다", async () => {
    const s = new Session();
    await s.login(SUPERADMIN.email, SUPERADMIN.password);
    const { status, body } = await s.json<{ user?: { email?: string; role?: string } }>("/api/auth/me");
    assert.equal(status, 200);
    assert.equal(body.user?.email, SUPERADMIN.email);
    assert.equal(body.user?.role, "superadmin");
  });
});

describe("e2e — 워크스페이스 격리 (RLS)", () => {
  // 이 블록이 이 파일의 핵심이다. 정책은 `tenant_id = current_setting('app.tenant_id', true)`
  // 이고, 그 변수가 안 세워지면 **에러가 아니라 빈 결과**가 나온다. 그래서 "격리가 깨졌다"가
  // 조용하다 — 2026-08-11 API 키 사고가 정확히 이 모양이었다(rls-access.test.ts 주석).
  let alpha: { email: string; password: string; programId: string };
  let bravo: { email: string; password: string };

  before(async () => {
    const admin = new Session();
    await admin.login(SUPERADMIN.email, SUPERADMIN.password);

    const make = async (name: string, email: string, password: string) => {
      const { status, body } = await admin.post<{ id?: string; error?: string; message?: string }>(
        "/api/superadmin/tenants",
        { name, ownerEmail: email, ownerPassword: password, ownerName: `${name} 대표` },
      );
      assert.equal(status, 200, `회사 개설 실패(${name}): ${JSON.stringify(body)}`);
      assert.ok(body.id, "테넌트 id 가 없다");
      return body.id!;
    };

    await make("알파 방송", "owner@alpha.e2e", "alpha-owner-pw");
    await make("브라보 미디어", "owner@bravo.e2e", "bravo-owner-pw");

    // 알파 쪽에 자기 프로그램을 하나 만든다 — 브라보가 이걸 보면 안 된다.
    const a = new Session();
    await a.login("owner@alpha.e2e", "alpha-owner-pw");
    const created = await a.post<{ program?: { id?: string } }>("/api/programs", {
      title: "알파 전용 프로그램",
    });
    assert.equal(created.status, 200, `프로그램 생성 실패: ${JSON.stringify(created.body)}`);
    const programId = created.body.program?.id;
    assert.ok(programId, "프로그램 id 가 없다");

    alpha = { email: "owner@alpha.e2e", password: "alpha-owner-pw", programId: programId! };
    bravo = { email: "owner@bravo.e2e", password: "bravo-owner-pw" };
  });

  it("알파는 자기 프로그램이 보인다", async () => {
    const s = new Session();
    await s.login(alpha.email, alpha.password);
    const { status, body } = await s.json<{ programs: { id: string; title: string }[] }>("/api/programs");
    assert.equal(status, 200);
    assert.ok(
      body.programs.some((p) => p.id === alpha.programId),
      "자기 워크스페이스 프로그램이 안 보인다 — 격리가 아니라 조회가 깨진 것이다",
    );
  });

  it("**브라보는 알파의 프로그램이 안 보인다**", async () => {
    const s = new Session();
    await s.login(bravo.email, bravo.password);
    const { status, body } = await s.json<{ programs: { id: string; title: string }[] }>("/api/programs");
    assert.equal(status, 200);
    assert.equal(
      body.programs.some((p) => p.id === alpha.programId),
      false,
      `워크스페이스 격리가 깨졌다 — 브라보가 알파의 ${alpha.programId} 를 본다.\n` +
        `  RLS 정책이 안 걸렸거나, app.tenant_id 를 안 세우는 경로로 조회했거나,\n` +
        `  접속 역할에 BYPASSRLS 가 있다(scripts/e2e.mts 의 전용 역할 주석 참조).`,
    );
  });

  it("브라보는 알파의 프로그램을 id 로 직접 찍어도 못 가져온다", async () => {
    // 목록에서 빠지는 것만 확인하면 부족하다 — id 를 아는 사람이 단건으로 집어가는 경로가
    // 따로 열려 있을 수 있다. 실제 사고는 대개 이쪽이다.
    const s = new Session();
    await s.login(bravo.email, bravo.password);
    const { status } = await s.json(`/api/programs/${alpha.programId}`);
    assert.equal(status, 404, `남의 워크스페이스 프로그램이 단건 조회로 샜다 (status ${status})`);
  });

  it("로그아웃하면 세션이 실제로 끊긴다", async () => {
    const s = new Session();
    await s.login(alpha.email, alpha.password);
    assert.equal((await s.json<{ user?: unknown }>("/api/auth/me")).body.user !== null, true);

    await s.post("/api/auth/logout", {});

    // ⚠️ `/api/auth/me` 는 미인증에도 **200** 을 준다 — `{ user: null, authRequired }` 로
    //    "로그인 화면을 띄울지" 를 웹이 판단하는 라우트라서다(401 이 아니다).
    //    그래서 여기서 상태코드를 보면 안 되고, ① user 가 null 인지 ② **데이터 라우트가
    //    실제로 막히는지** 를 같이 봐야 세션이 정말 죽은 것이다.
    const me = await s.json<{ user: unknown }>("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user, null, "로그아웃 뒤에도 /api/auth/me 가 사용자를 준다");
    assert.equal(
      (await s.json("/api/state")).status, 401,
      "로그아웃했는데 워크스페이스 데이터가 아직 열린다 — 세션이 안 끊겼다",
    );
  });
});

/**
 * `/api/state` 조건부 요청 — **안 바뀌었으면 본문을 안 보낸다.**
 *
 * 웹 스토어는 탭이 열려 있는 내내 이 라우트를 폴링하고(유휴 45초), 이 응답은 워크스페이스
 * 전체다. 프로덕션은 프록시 경유라 그 바이트가 곧 Vercel Fast Origin Transfer 과금이다.
 *
 * 소스만 읽어서는 증명이 안 된다. 확인해야 하는 건 두 가지고 **둘 다 진짜 DB 가 필요하다**:
 *   ① 아무것도 안 했을 때 같은 ETag 가 나오는가 (안 그러면 최적화가 조용히 무력화된다)
 *   ② 데이터가 바뀌면 ETag 가 실제로 달라지는가 (안 그러면 **낡은 화면을 준다** — 이쪽이 위험하다)
 */
describe("e2e — /api/state 조건부 요청 (ETag)", () => {
  const OWNER = { email: "owner@etag.e2e", password: "etag-owner-pw" };
  /** 같은 회사에 발급한 API 키 — 조건부 응답에서 제외되는지 보려고 쓴다. */
  let apiKey: string;

  before(async () => {
    const admin = new Session();
    await admin.login(SUPERADMIN.email, SUPERADMIN.password);
    const { status, body } = await admin.post<{ id?: string; error?: string }>(
      "/api/superadmin/tenants",
      { name: "이태그 방송", ownerEmail: OWNER.email, ownerPassword: OWNER.password, ownerName: "이태그 대표" },
    );
    assert.equal(status, 200, `회사 개설 실패: ${JSON.stringify(body)}`);

    const key = await admin.post<{ key?: string; error?: string }>(
      `/api/superadmin/tenants/${body.id}/api-keys`,
      { name: "etag e2e", reason: "e2e — 조건부 응답 제외 확인" },
    );
    assert.equal(key.status, 200, `API 키 발급 실패: ${JSON.stringify(key.body)}`);
    assert.ok(key.body.key, "발급 응답에 키가 없다");
    apiKey = key.body.key!;
  });

  it("ETag 를 주고, 그걸 되돌려주면 304 + 빈 본문이다", async () => {
    const s = new Session();
    await s.login(OWNER.email, OWNER.password);

    const first = await s.fetch("/api/state");
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "/api/state 가 ETag 를 안 준다 — 조건부 요청이 성립하지 않는다");
    assert.ok((await first.text()).length > 0, "200 인데 본문이 비었다");

    const second = await s.fetch("/api/state", { headers: { "if-none-match": etag! } });
    assert.equal(second.status, 304, "안 바뀐 상태인데 304 가 아니다 — 폴링이 매번 전체를 받아간다");
    assert.equal(await second.text(), "", "304 인데 본문이 실려 나갔다 — 아낀 게 없다");
  });

  it("데이터가 바뀌면 ETag 도 바뀐다 — 낡은 상태를 물고 있지 않는다", async () => {
    const s = new Session();
    await s.login(OWNER.email, OWNER.password);

    const before = await s.fetch("/api/state");
    const etag = before.headers.get("etag");
    await before.text();
    assert.ok(etag);

    const created = await s.post<{ program?: { id?: string } }>("/api/programs", {
      title: "ETag 를 흔드는 프로그램",
    });
    assert.equal(created.status, 200, `프로그램 생성 실패: ${JSON.stringify(created.body)}`);

    const after = await s.fetch("/api/state", { headers: { "if-none-match": etag! } });
    assert.equal(
      after.status, 200,
      "프로그램을 만들었는데 304 가 돌아왔다 — 화면이 영원히 갱신되지 않는다",
    );
    assert.notEqual(after.headers.get("etag"), etag, "내용이 바뀌었는데 ETag 가 그대로다");
  });

  it("/api/state/progress 는 진행률만 주고 **전체보다 작다**", async () => {
    // 쪼갠 이유가 크기다. 작지 않으면 라우트만 하나 늘린 셈이라 여기서 잡는다.
    const s = new Session();
    await s.login(OWNER.email, OWNER.password);

    const full = await (await s.fetch("/api/state")).text();
    const res = await s.fetch("/api/state/progress");
    assert.equal(res.status, 200);
    const progress = await res.text();

    assert.ok(
      progress.length < full.length,
      `진행률 응답(${progress.length}B)이 전체(${full.length}B)보다 작지 않다 — 쪼갠 의미가 없다`,
    );

    // 담는 것만 담는다. 클립·미디어·프로그램이 섞여 들어오면 다시 커진다.
    const body = JSON.parse(progress) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["episodes", "jobs"]);
  });

  it("**API 키에는 304 를 주지 않는다** — 남의 연동에 조건부 응답을 떠넘기지 않는다", async () => {
    // 아끼려는 바이트는 전부 브라우저 폴링 쪽이다. 외부 연동은 아낄 게 없는데 우리가 고칠 수
    // 없는 코드라, ETag 만 되돌려주고 304 는 못 다루는 구현 하나면 그쪽이 조용히 깨진다.
    const headers = { "x-api-key": apiKey };

    const first = await fetch(`${BASE}/api/state`, { headers });
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    await first.text();
    assert.ok(etag, "API 키 응답에도 ETag 자체는 붙는다(캐시 검증용) — 없으면 전제가 바뀐 것");

    const second = await fetch(`${BASE}/api/state`, { headers: { ...headers, "if-none-match": etag! } });
    assert.equal(
      second.status, 200,
      "API 키 클라이언트가 304 를 받았다 — 본문을 기대하는 외부 연동이 빈 응답을 받는다",
    );
    assert.ok((await second.text()).length > 0, "200 인데 본문이 비었다");
  });

  it("/api/state/progress 도 로그인 없이는 못 본다", async () => {
    // 전체 상태를 막아 두고 진행률은 열어 두면 회차 목록·단계가 그대로 샌다.
    const anon = new Session();
    assert.equal((await anon.json("/api/state/progress")).status, 401);
  });

  it("gzip 을 요구해도 304 는 그대로 304 다", async () => {
    // `/api/*` 에는 compress() 가 걸려 있다. 본문 없는 응답을 압축하려 들면 깨진다 —
    // hono 는 `!ctx.res.body` 로 건너뛰지만, 그 전제가 바뀌면 여기서 잡힌다.
    const s = new Session();
    await s.login(OWNER.email, OWNER.password);

    const first = await s.fetch("/api/state", { headers: { "accept-encoding": "gzip" } });
    const etag = first.headers.get("etag");
    await first.text();

    const second = await s.fetch("/api/state", {
      headers: { "if-none-match": etag!, "accept-encoding": "gzip" },
    });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("content-encoding"), null, "빈 본문에 압축 헤더가 붙었다");
  });
});
