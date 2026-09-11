#!/usr/bin/env node
/**
 * 디자이너 원본 ↔ 우리 구현 CSS 대조 — "또 다르다" 는 지적을 끝내려고 만든 도구.
 *
 *   node scripts/design/css-audit.mjs            전 화면 요약
 *   node scripts/design/css-audit.mjs automation 한 화면 상세
 *
 * 원본 경로는 `STEPD_DESIGN_SRC` 로 준다(기본값은 아래). 리포에 없는 로컬 산출물이다.
 *
 * ## 읽는 법 — 숫자를 그대로 믿지 말 것
 *
 * "누락" 은 **원본에 있는 클래스가 우리 쪽 스캔 범위에 없다** 는 뜻일 뿐이다.
 * 셋 중 하나면 고칠 게 아니다:
 *   1. **목업 전용** — 원본이 채널마다 아바타 색을 하드코딩(bg-indigo-600 …)한 것 같은 자리.
 *      우리는 실데이터라 색을 그렇게 안 쓴다.
 *   2. **도구 한계** — 우리가 다른 컴포넌트로 뺀 것(UploadDialog 등). import 를 2단계까지만
 *      따라가므로 더 깊으면 안 잡힌다.
 *   3. **의도한 차이** — 실데이터 때문에 조건부 렌더를 바꾼 자리(예: 금액 없는 원장 행).
 *
 * 그래서 이 도구는 **어디를 볼지 좁혀 주는 것**이지 할 일 목록이 아니다.
 * 실제 판정은 원본 파일의 해당 블록을 열어 눈으로 비교해서 한다.
 *
 * ## 이미 걸러낸 거짓 양성 (다시 만들지 말 것)
 *  · 삼항 변수에 담긴 2토큰 문자열(`"bg-emerald-400 animate-pulse"`) → re2 를 2토큰까지
 *  · `${…}` 보간 잔해가 클래스로 새던 것 → 보간을 먼저 지운다
 *  · 우리 화면은 셸을 직접 import 하지 않는다(AppShell 이 감싼다) → 셸을 항상 포함
 *  · 디자이너도 화면을 컴포넌트로 쪼갰다 → **양쪽 다** import 를 따라간다
 */
// 화면 단위로만 비교하면 **공용 컴포넌트에 숨은 어긋남**을 놓친다 — 결제 화면이 그랬다
// (BillingDialog 껍데기가 옛 시스템). 그래서 우리 쪽은 그 화면이 실제로 쓰는
// 컴포넌트까지 import 를 따라가 함께 본다.
import fs from "node:fs";
import path from "node:path";

const ORIG = process.env.STEPD_DESIGN_SRC
  || "C:/Users/STEPAI05/Downloads/STEPD_SaaS_UI_V1/src";
const OURS = path.resolve(import.meta.dirname, "../../apps/web/src");

/** 디자이너 화면 → 우리 화면. (app) 그룹과 파일명이 달라 손으로 맞춘다. */
const MAP = {
  "page.tsx": "app/login/page.tsx",
  "dashboard/page.tsx": "app/(app)/dashboard/page.tsx",
  "analyze/page.tsx": "app/(app)/analyze/page.tsx",
  "assets/page.tsx": "app/(app)/assets/page.tsx",
  "automation/page.tsx": "app/(app)/automation/page.tsx",
  "business/page.tsx": "app/(app)/business/page.tsx",
  "channel-analytics/page.tsx": "app/(app)/channel-analytics/page.tsx",
  "commerce/page.tsx": "app/(app)/commerce/page.tsx",
  "credits/page.tsx": "app/(app)/credits/page.tsx",
  "distribution/page.tsx": "app/(app)/distribution/page.tsx",
  "edits/page.tsx": "app/(app)/edits/page.tsx",
  "media/page.tsx": "app/(app)/media/page.tsx",
  "ops/page.tsx": "app/(app)/ops/page.tsx",
  "performance/page.tsx": "app/(app)/performance/page.tsx",
  "program-analytics/page.tsx": "app/(app)/program-analytics/page.tsx",
  "programs/page.tsx": "app/(app)/programs/page.tsx",
  "publish-channels/page.tsx": "app/(app)/publish-channels/page.tsx",
  "reframe-lab/page.tsx": "app/(app)/reframe-lab/page.tsx",
  "search/page.tsx": "app/(app)/search/page.tsx",
  "thumbnails/page.tsx": "app/(app)/thumbnails/page.tsx",
  "trends/page.tsx": "app/(app)/trends/page.tsx",
  "[programId]/page.tsx": "app/(app)/programs/[id]/page.tsx",
  "episodes/[episodeId]/page.tsx": "app/(app)/episodes/[id]/page.tsx",
};

/** 진짜 Tailwind 유틸리티인가 — 변수명·숫자·JSX 조각을 걸러낸다. */
function isUtility(c) {
  if (!c || c.length < 2) return false;
  if (/[A-Z${}'"`<>]/.test(c)) return false;      // camelCase 변수·보간 잔해
  if (/^\d+$/.test(c)) return false;               // 숫자만
  if (c.includes(".") && !c.includes("[")) return false;  // prod.status 같은 프로퍼티 접근
  return /^[a-z0-9[]/.test(c);
}

function classesOf(src) {
  const out = new Set();
  const add = (blob) => {
    // ${...} 보간을 통째로 지운 뒤 토큰을 나눈다 — 안 지우면 변수 조각이 클래스로 샌다.
    for (const t of blob.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      const c = t.trim();
      if (isUtility(c)) out.add(c);
    }
  };
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m;
  while ((m = re.exec(src))) add(m[1] ?? m[2] ?? "");
  // 문자열 상수로 뽑아 둔 클래스 묶음도 본다 (PILL = "px-5 py-2.5 …")
  // 2토큰 문자열도 잡는다 — `"bg-emerald-400 animate-pulse"` 처럼 삼항 변수에 담긴 것들.
  // 3토큰 이상만 보면 그런 게 통째로 "누락" 으로 잡혀 거짓 양성이 된다.
  const re2 = /["`]((?:[a-z][\w[\]().,#/%:-]*\s+){1,}[a-z][\w[\]().,#/%:-]*)["`]/g;
  while ((m = re2.exec(src))) add(m[1]);
  return out;
}

/**
 * `@/…` 로컬 컴포넌트를 따라간다(2단계까지). **양쪽 다** 해야 한다 —
 * 디자이너도 화면을 컴포넌트로 쪼개 놨고(components/dashboard/*), 우리도 그렇다.
 * 한쪽만 따라가면 "원본엔 있는데 우리엔 없다" 가 통째로 거짓 양성이 된다.
 */
function withLocalImports(file, root, depth = 2) {
  const seen = new Set();
  const walk = (f, d) => {
    if (seen.has(f) || d < 0) return;
    seen.add(f);
    let src;
    try { src = fs.readFileSync(f, "utf-8"); } catch { return; }
    const re = /from\s+['"]@\/([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      if (!/^(components|lib)\//.test(m[1])) continue;
      for (const ext of [".tsx", ".ts"]) {
        const p = path.join(root, m[1] + ext);
        if (fs.existsSync(p)) { walk(p, d - 1); break; }
      }
    }
  };
  walk(file, depth);
  return [...seen];
}

/** 목업 전용·레이아웃 셸 노이즈 — 우리 쪽에 없어도 정상인 것들. */
const IGNORE = new Set(["h-screen", "w-screen", "min-h-screen", "antialiased"]);

const rows = [];
for (const [o, u] of Object.entries(MAP)) {
  const op = path.join(ORIG, "app", o);
  const up = path.join(OURS, u);
  if (!fs.existsSync(op)) { rows.push([o, "원본없음", 0, []]); continue; }
  if (!fs.existsSync(up)) { rows.push([o, "우리없음", 0, []]); continue; }

  const orig = new Set();
  for (const f of withLocalImports(op, ORIG)) {
    for (const c of classesOf(fs.readFileSync(f, "utf-8"))) orig.add(c);
  }
  // 우리는 화면이 셸을 직접 import 하지 않는다 — `(app)/layout.tsx` 의 AppShell 이 감싼다.
  // 그래서 셸 컴포넌트를 **항상** 포함시킨다. 안 하면 사이드바 클래스 20여 개가 화면마다
  // "누락" 으로 잡혀(거짓 양성) 진짜 차이가 묻힌다.
  const SHELL = ["components/layout/sidebar.tsx", "components/layout/header.tsx",
                 "components/layout/footer.tsx", "components/shell/app-shell.tsx"];
  const ours = new Set();
  for (const sf of SHELL) {
    const p = path.join(OURS, sf);
    if (fs.existsSync(p)) for (const c of classesOf(fs.readFileSync(p, "utf-8"))) ours.add(c);
  }
  for (const f of withLocalImports(up, OURS)) {
    for (const c of classesOf(fs.readFileSync(f, "utf-8"))) ours.add(c);
  }
  const missing = [...orig].filter((c) => !ours.has(c) && !IGNORE.has(c)).sort();
  rows.push([o, "비교", orig.size, missing]);
}

rows.sort((a, b) => (b[3]?.length ?? 0) - (a[3]?.length ?? 0));
console.log("화면".padEnd(34), "원본", "누락");
console.log("-".repeat(70));
for (const [name, state, n, missing] of rows) {
  if (state !== "비교") { console.log(name.padEnd(34), state); continue; }
  const only = process.argv[2];
  if (only) {
    if (name.includes(only) && missing.length) {
      console.log(`
=== ${name} — 누락 ${missing.length} ===`);
      for (const c of missing) console.log("  " + c);
    }
    continue;
  }
  console.log(name.padEnd(34), String(n).padStart(4), String(missing.length).padStart(5),
    missing.length ? "  " + missing.slice(0, 6).join(" ") + (missing.length > 6 ? " …" : "") : "");
}
const total = rows.reduce((a, r) => a + (r[3]?.length ?? 0), 0);
console.log(`\n총 누락 ${total}개`);
