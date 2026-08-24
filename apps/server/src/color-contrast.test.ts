/**
 * 앱 공통 팔레트 대비 회귀 테스트.
 *
 * STEP-D 본문은 9.5~12.5px 운영 문구가 많아서 "장식용 회색"도 WCAG AA 4.5:1을
 * 넘어야 한다. 특히 html.dark에서 semantic 토큰만 다크, sd-* 배경은 라이트였던 혼합
 * 테마가 다시 생기면 흰 글자가 밝은 카드에 묻힌다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(HERE, "../../web/src/app/globals.css"), "utf8");
const WEB_SRC = path.resolve(HERE, "../../web/src");

function readTsxTree(dir: string): string {
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return readTsxTree(target);
    return entry.name.endsWith(".tsx") ? fs.readFileSync(target, "utf8") : "";
  }).join("\n");
}

const TSX = readTsxTree(WEB_SRC);

function block(selector: string, requiredToken: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const found = [...CSS.matchAll(re)].map((m) => m[1]).find((body) => body.includes(`${requiredToken}:`));
  assert.ok(found, `${selector} ${requiredToken} 팔레트 블록을 찾지 못했다`);
  return found!;
}

function hex(body: string, token: string): string {
  const m = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`).exec(body);
  assert.ok(m, `--${token} hex 토큰을 찾지 못했다`);
  return m![1];
}

function luminance(value: string): number {
  const rgb = [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = rgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function aa(fg: string, bg: string, label: string): void {
  assert.ok(contrast(fg, bg) >= 4.5, `${label}: ${contrast(fg, bg).toFixed(2)}:1 < 4.5:1`);
}

describe("sd-* 공통 팔레트 색 대비", () => {
  const light = block(":root", "--sd-accent");
  const dark = block(".dark", "--sd-accent");

  it("라이트 보조 문구가 카드·앱·사이드바에서 AA", () => {
    for (const token of ["sd-mut", "sd-label"] as const) {
      for (const bg of ["sd-card", "sd-app-bg", "sd-sidebar-bg"] as const) {
        aa(hex(light, token), hex(light, bg), `light ${token}/${bg}`);
      }
    }
    for (const bg of ["sd-placeholder-a", "sd-placeholder-b"] as const) {
      aa(hex(light, "sd-idle"), hex(light, bg), `light sd-idle/${bg}`);
    }
  });

  it("다크 보조 문구가 카드·앱·사이드바에서 AA", () => {
    for (const token of ["sd-mut", "sd-label", "sd-idle"] as const) {
      for (const bg of ["sd-card", "sd-app-bg", "sd-sidebar-bg"] as const) {
        aa(hex(dark, token), hex(dark, bg), `dark ${token}/${bg}`);
      }
    }
  });

  it("강조 배경 위 글자도 라이트·다크 모두 AA", () => {
    aa(hex(light, "sd-on-accent"), hex(light, "sd-accent"), "light primary");
    aa(hex(dark, "sd-on-accent"), hex(dark, "sd-accent"), "dark primary");
    aa(hex(light, "sd-on-danger"), hex(light, "sd-danger-strong"), "light danger");
    aa(hex(dark, "sd-on-danger"), hex(dark, "sd-danger-strong"), "dark danger");
  });

  it("다크 sd 팔레트가 실제로 존재하고 모달은 하드코딩 흰 배경을 쓰지 않는다", () => {
    assert.notEqual(hex(light, "sd-app-bg"), hex(dark, "sd-app-bg"));
    assert.doesNotMatch(TSX, /sd-modal[^"\n]*bg-white/);
  });
});
