/**
 * 채널별 메타데이터 불변식.
 *
 * 여기서 고정하는 것은 "좋은 문구가 나오는가" 가 아니다(그건 LLM 몫이고 매번 다르다).
 * **규격을 어긴 메타가 발행 경로로 흘러가지 않는가** 다 — 발행이 실패하는 지점은 대부분
 * 창의성이 아니라 길이·필수 필드였다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CHANNEL_SPECS,
  META_CHANNELS,
  buildMetadataPrompt,
  genrePackFor,
  normalizeForChannel,
  validateForChannel,
  type BaseMetadata,
} from "./clip-metadata.ts";

const base: BaseMetadata = {
  title: "이영자가 젓가락을 놓은 순간",
  description: "먹방 도중 이영자가 갑자기 젓가락을 내려놓는다. 옆자리 홍현희가 이유를 묻자 짧게 답한다.",
  tags: ["이영자", "홍현희", "전지적 참견 시점", "먹방"],
  hashtags: ["#전참시", "#이영자"],
};

describe("채널 규격을 어긴 메타는 발행 경로로 못 간다", () => {
  it("네이버 클립은 제목 필드가 없다 — 제목 문구를 버리지 않고 설명 첫 줄로 올린다", () => {
    const m = normalizeForChannel(base, "naverclip");
    assert.equal(m.title, null, "네이버 클립에 제목을 만들어 보내면 안 된다");
    assert.ok(m.description.startsWith(base.title),
      "제목 문구가 사라졌다 — 제목 필드가 없는 채널에서는 설명 첫 줄이 그 자리다");
  });

  it("네이버 클립 설명 10자 하한은 자동으로 채우지 않고 문제로 보고한다", () => {
    // 지어낸 문장으로 길이를 맞추면 사실이 흔들린다. 사람이 고치게 한다.
    const m = normalizeForChannel({ ...base, title: "가", description: "", hashtags: [] }, "naverclip");
    assert.ok(m.problems.some((p) => p.includes("10자")), `하한 위반을 안 잡았다: ${m.problems}`);
  });

  it("제목 상한을 넘기지 않는다 — 단어 중간에서 끊지 않는다", () => {
    const long = { ...base, title: "가".repeat(400) };
    for (const ch of META_CHANNELS) {
      const spec = CHANNEL_SPECS[ch];
      if (spec.titleMax === null) continue;
      const m = normalizeForChannel(long, ch);
      assert.ok((m.title ?? "").length <= spec.titleMax,
        `${ch}: 제목이 ${spec.titleMax} 를 넘었다 (${m.title?.length})`);
    }
  });

  it("설명 상한을 넘기지 않는다", () => {
    const long = { ...base, description: "가".repeat(9000) };
    for (const ch of META_CHANNELS) {
      const m = normalizeForChannel(long, ch);
      assert.ok(m.description.length <= CHANNEL_SPECS[ch].descMax,
        `${ch}: 설명이 ${CHANNEL_SPECS[ch].descMax} 를 넘었다 (${m.description.length})`);
    }
  });

  it("태그 필드가 없는 채널에는 태그를 보내지 않는다 — 해시태그로 녹인다", () => {
    for (const ch of META_CHANNELS) {
      const m = normalizeForChannel(base, ch);
      if (CHANNEL_SPECS[ch].tagsMax === 0) {
        assert.deepEqual(m.tags, [], `${ch} 는 태그 필드가 없는데 태그를 보냈다`);
        assert.ok(m.description.includes("#"), `${ch}: 해시태그가 본문에도 없다 — 그냥 사라졌다`);
      } else {
        assert.ok(m.tags.length <= CHANNEL_SPECS[ch].tagsMax, `${ch}: 태그 개수 초과`);
      }
    }
  });

  it("카테고리가 필요한 채널은 사람에게 묻는다 — 자동 판정하지 않는다", () => {
    // 틀린 분류로 발행되면 되돌리기가 번거롭다. 조용히 골라주지 않는다.
    for (const ch of META_CHANNELS) {
      const m = normalizeForChannel(base, ch);
      assert.equal(m.needsCategory, CHANNEL_SPECS[ch].needsCategory, `${ch}: 카테고리 요구가 규격과 다르다`);
      if (m.needsCategory) {
        assert.ok(m.problems.some((p) => p.includes("카테고리")), `${ch}: 카테고리를 안 물었다`);
      }
    }
  });
});

describe("채널 규칙이 실제로 반영된다", () => {
  // ⚠️ titlePrefix·hashtagTemplate 는 2026-08-12 까지 화면에서 입력만 받고
  //    읽는 코드가 한 곳도 없었다. 운영자가 채워도 아무 데도 안 갔다.
  it("titlePrefix 가 제목 앞에 붙는다", () => {
    const m = normalizeForChannel(base, "youtube", { titlePrefix: "[전참시]" });
    assert.ok(m.title?.startsWith("[전참시]"), `접두어가 안 붙었다: ${m.title}`);
  });

  it("hashtagTemplate 의 {program}·{episode} 가 치환돼 설명에 들어간다", () => {
    const m = normalizeForChannel(base, "youtube",
      { hashtagTemplate: "#{program} #{episode}" },
      { program: "전참시", episode: "312회" });
    assert.match(m.description, /#전참시/, "프로그램 해시태그가 안 들어갔다");
    assert.match(m.description, /#312회/, "회차 해시태그가 안 들어갔다");
  });

  it("접두어가 붙어도 제목 상한을 넘지 않는다", () => {
    const m = normalizeForChannel({ ...base, title: "가".repeat(200) }, "youtube",
      { titlePrefix: "[아주 긴 접두어입니다]" });
    assert.ok((m.title ?? "").length <= CHANNEL_SPECS.youtube.titleMax!);
  });
});

describe("YouTube 제목 해시태그 — 유입의 축", () => {
  // 운영자 요구: `제목 #나는솔로` 처럼 제목에 프로그램 해시태그를 단다.
  // 설명에만 넣으면 같은 프로그램 클립끼리 묶이는 효과가 약하다.
  it("프로그램 해시태그가 제목 끝에 붙는다", () => {
    const m = normalizeForChannel(base, "youtube", {}, { program: "나는 SOLO" });
    assert.match(m.title ?? "", /#나는SOLO/, `제목에 프로그램 해시태그가 없다: ${m.title}`);
    // 프로그램 태그가 1순위 — 자리가 하나뿐일 때 밀려나면 안 된다.
    const tags = (m.title ?? "").match(/#\S+/g) ?? [];
    assert.equal(tags[0], "#나는SOLO", `프로그램 태그가 첫 번째가 아니다: ${tags.join(" ")}`);
  });

  it("공백을 지운다 — `#나는 솔로` 는 `#나는` 까지만 인식된다", () => {
    const m = normalizeForChannel(base, "youtube", {}, { program: "나는 SOLO" });
    assert.doesNotMatch(m.title ?? "", /#나는 /, "해시태그 안에 공백이 남았다");
  });

  it("해시태그 자리를 먼저 확보한 뒤 본문을 자른다 — 해시태그가 잘리면 안 된다", () => {
    const m = normalizeForChannel({ ...base, title: "가".repeat(300) }, "youtube", {},
      { program: "나는SOLO" });
    assert.ok((m.title ?? "").length <= CHANNEL_SPECS.youtube.titleMax!);
    assert.match(m.title ?? "", /#나는SOLO/, "본문이 상한을 다 써서 해시태그가 날아갔다");
  });

  it("제목 해시태그가 관행이 아닌 채널에는 붙이지 않는다", () => {
    const m = normalizeForChannel(base, "navertv", {}, { program: "나는SOLO" });
    assert.doesNotMatch(m.title ?? "", /#/, "네이버 TV 제목에 해시태그가 붙었다");
  });

  // ⚠️ 규칙 hashtagTemplate 도 없고 Gemini hashtags 도 비면 예전엔 제목이 해시태그 없이 나갔다.
  //    YouTube 쇼츠는 해시태그가 유입축이라 **항상 최소 #쇼츠 는 달고 나가야** 한다.
  const noHashtags: BaseMetadata = {
    title: "이영자가 젓가락을 놓은 순간",
    description: "먹방 도중 갑자기 젓가락을 내려놓는다.",
    tags: ["이영자", "홍현희", "먹방"],
    hashtags: [],
  };

  it("해시태그 소스가 하나도 없어도 제목은 #Shorts 로 끝난다 (프로그램 주어지면 #프로그램도)", () => {
    const noSource: BaseMetadata = { ...noHashtags, tags: [] };
    const m = normalizeForChannel(noSource, "youtube", {}, { program: "전참시" });
    // 예: "이영자가 젓가락을 놓은 순간 #전참시 #Shorts"
    assert.match(m.title ?? "", /#전참시/, `프로그램 해시태그가 없다: ${m.title}`);
    assert.match(m.title ?? "", /#Shorts$/i, `#Shorts 로 안 끝난다: ${m.title}`);
    assert.ok((m.title ?? "").length <= CHANNEL_SPECS.youtube.titleMax!, `상한 초과: ${m.title?.length}`);
  });

  it("프로그램이 없으면 base.tags(등록 캐스트·인물)로 채우고 #Shorts 를 보루로 둔다", () => {
    const m = normalizeForChannel(noHashtags, "youtube", {}, {});
    assert.match(m.title ?? "", /#이영자/, `태그 폴백이 안 됐다: ${m.title}`);
    assert.match(m.title ?? "", /#Shorts/i, `#Shorts 보루가 없다: ${m.title}`);
  });

  it("프로그램·태그가 전무해도 최소 #Shorts 한 개는 붙는다 — 해시태그 0개로는 안 나간다", () => {
    const bare: BaseMetadata = { title: "무제", description: "설명", tags: [], hashtags: [] };
    const m = normalizeForChannel(bare, "youtube", {}, {});
    assert.match(m.title ?? "", /#Shorts/i, `최후 보루 #Shorts 가 없다: ${m.title}`);
  });

  it("소스가 비어 폴백해도 제목 상한을 넘지 않는다", () => {
    const longNoTags: BaseMetadata = { ...noHashtags, title: "가".repeat(300), tags: [] };
    const m = normalizeForChannel(longNoTags, "youtube", {}, { program: "전참시" });
    assert.ok((m.title ?? "").length <= CHANNEL_SPECS.youtube.titleMax!, `상한 초과: ${m.title?.length}`);
    assert.match(m.title ?? "", /#Shorts$/i, "본문이 상한을 다 써서 #Shorts 가 날아갔다");
  });

  it("제목 해시태그 상한이 다른 태그로 다 차도 #Shorts 는 무조건 붙는다 (사용자 2026-08-20)", () => {
    // AI 가 프로그램+인물+상황으로 titleHashtags(3) 를 꽉 채운 경우 — 예전엔 자리가 없어 #Shorts 가
    // 조용히 밀려났다. 이제 #Shorts 자리를 예약하므로 반드시 맨 끝에 붙는다.
    const full: BaseMetadata = { title: "결정적 순간", description: "설명 문장.", tags: [], hashtags: ["#영수", "#영자", "#돌싱글즈"] };
    const m = normalizeForChannel(full, "youtube", {}, { program: "나는솔로" });
    assert.match(m.title ?? "", /#Shorts$/i, `태그가 꽉 찼다고 #Shorts 가 빠졌다: ${m.title}`);
  });

  it("AI 가 한글 #쇼츠 를 뽑아도 표준 #Shorts 하나로 통일된다 (중복 없음)", () => {
    const kr: BaseMetadata = { title: "순간", description: "설명 문장.", tags: [], hashtags: ["#쇼츠", "#영수"] };
    const m = normalizeForChannel(kr, "youtube", {}, { program: "나는솔로" });
    assert.match(m.title ?? "", /#Shorts$/i);
    assert.doesNotMatch(m.title ?? "", /#쇼츠/, `한글 #쇼츠 가 남았다: ${m.title}`);
  });

  it("#Shorts 보장은 제목 해시태그가 0인 채널에는 적용되지 않는다", () => {
    // 네이버·인스타 등은 titleHashtags=0 이라 #Shorts 도 붙지 않는다.
    const m = normalizeForChannel(noHashtags, "navertv", {}, { program: "전참시" });
    assert.doesNotMatch(m.title ?? "", /#Shorts/i, "제목 해시태그 관행이 없는 채널에 #Shorts 가 붙었다");
  });
});

describe("장르팩 — AENA 가 품질 핵심이라 지목한 분기", () => {
  it("드라마·예능을 알아보고, 모르는 장르는 공통팩으로 간다", () => {
    assert.equal(genrePackFor("드라마").label, "드라마");
    assert.equal(genrePackFor("drama").label, "드라마");
    assert.equal(genrePackFor("예능").label, "예능");
    assert.equal(genrePackFor("variety").label, "예능");
    // 추측해서 틀린 팩을 쓰는 것보다 공통팩이 낫다.
    assert.equal(genrePackFor("스포츠").label, "공통");
    assert.equal(genrePackFor(undefined).label, "공통");
  });

  it("드라마 팩은 스포일러를 금지한다", () => {
    const p = buildMetadataPrompt({ genre: "드라마", program: "허수아비" });
    assert.match(p, /스포일러 금지/);
  });
});

describe("프롬프트 조립", () => {
  it("자막이 없어도 프롬프트가 만들어진다 — 대사 없는 클립도 메타가 필요하다", () => {
    const p = buildMetadataPrompt({ program: "전참시", summary: "리액션 몰아보기" });
    assert.ok(p.length > 0);
    assert.match(p, /대사가 거의 없다/, "자막 부재를 모델에게 알려주지 않았다");
  });

  it("등록 캐스트가 없으면 이름을 지어내지 말라고 명시한다", () => {
    const p = buildMetadataPrompt({ program: "전참시" });
    assert.match(p, /이름을 추측해 쓰지 마라/);
  });

  it("등록 캐스트가 있으면 그 표기만 쓰라고 못 박는다", () => {
    const p = buildMetadataPrompt({ program: "전참시", cast: ["이영자", "홍현희"] });
    assert.match(p, /이영자 · 홍현희/);
    assert.match(p, /새로 만들지 마라/);
  });

  it("⚠️ response_schema 를 쓰지 않는다 — 프롬프트가 형식을 직접 말한다", () => {
    // AENA 결론: 스키마를 걸면 MAX_TOKENS 로 잘렸을 때 파싱 자체가 실패해 배치가 통째로 유실된다.
    const p = buildMetadataPrompt({ program: "전참시" });
    assert.match(p, /아래 JSON 만 출력한다/);
    assert.match(p, /"title"/);
  });

  it("빈 블록은 빠진다 — 조립이 지저분해지지 않는다", () => {
    const p = buildMetadataPrompt({ program: "전참시" });
    assert.doesNotMatch(p, /\n\n\n/, "빈 블록이 그대로 이어져 개행이 3개 이상 생겼다");
  });

  it("titlePrompt(프로그램별 운영자 지시)가 실리고, 없으면 블록 자체가 빠진다", () => {
    const withPrompt = buildMetadataPrompt({ program: "전참시", titlePrompt: "출연자 실명 필수" });
    assert.match(withPrompt, /## 프로그램별 운영자 지시/);
    assert.match(withPrompt, /출연자 실명 필수/);
    // 값이 없거나 공백뿐이면 헤더도 남기지 않는다 — 빈 지시 블록은 모델에게 소음이다.
    for (const src of [{ program: "전참시" }, { program: "전참시", titlePrompt: "   " }]) {
      assert.doesNotMatch(buildMetadataPrompt(src), /프로그램별 운영자 지시/);
    }
  });
});

describe("⚠️ 만든 것이 실제로 소비된다 — 이 리포의 최빈 실패", () => {
  /**
   * 기능은 있는데 출력이 소비처에 미도달하는 것이 이 리포에서 가장 자주 난 사고다.
   * `channel_rules` 의 titlePrefix·hashtagTemplate 는 화면에서 입력만 받고 **읽는 코드가
   * 한 곳도 없이** 오래 방치됐다. 메타데이터도 같은 길을 가지 않게 소스로 확인한다.
   */
  const SRC = path.dirname(fileURLToPath(import.meta.url));
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

  it("발행 경로가 채널별 메타를 읽는다", () => {
    const w = read("worker.ts");
    assert.match(w, /metaForChannel\(/, "worker 가 채널별 메타를 꺼내 쓰지 않는다");
    // YouTube·네이버 둘 다.
    assert.match(w, /metaForChannel\(clip, "youtube"\)/, "YouTube 발행이 채널 메타를 안 쓴다");
    assert.match(w, /const naverMeta = metaForChannel\(/, "네이버 발행이 채널 메타를 안 쓴다");
  });

  it("생성 라우트가 채널 규칙(titlePrefix·hashtagTemplate)을 실제로 넘긴다", () => {
    const idx = read("index.ts");
    const block = idx.match(/generate-metadata[\s\S]{0,4000}/)?.[0] ?? "";
    assert.match(block, /listChannelRules\(/, "채널 규칙을 조회하지 않는다 — 접두어·해시태그가 또 죽는다");
    assert.match(block, /normalizeForChannel\(/, "채널 규격 적용을 안 한다");
  });

  it("생성 라우트가 response_schema 를 넘기지 않는다 (AENA 결론)", () => {
    const idx = read("index.ts");
    const block = idx.match(/generate-metadata[\s\S]{0,4000}/)?.[0] ?? "";
    assert.doesNotMatch(block, /schema[,\s]*}/,
      "schema 를 넘기면 MAX_TOKENS 로 잘렸을 때 파싱이 통째로 실패한다");
  });

  it("사람이 고친 메타를 재생성이 덮지 않는다", () => {
    const idx = read("index.ts");
    const block = idx.match(/generate-metadata[\s\S]{0,4000}/)?.[0] ?? "";
    assert.match(block, /edited/, "사람이 수정한 채널을 보존하는 처리가 없다");
  });

  it("program.titlePrompt 가 서버 제목 경로 두 곳에 실제로 실린다", () => {
    // 저장(PATCH)만 되고 안 읽히면 이 필드도 titlePrefix 의 길을 간다.
    const idx = read("index.ts");
    const gen = idx.match(/generate-metadata[\s\S]{0,4000}/)?.[0] ?? "";
    assert.match(gen, /titlePrompt/, "generate-metadata 가 program.titlePrompt 를 안 넘긴다");
    const re = idx.match(/regenerate-titles[\s\S]{0,6000}/)?.[0] ?? "";
    assert.match(re, /titlePrompt/, "regenerate-titles 가 program.titlePrompt 를 안 쓴다");
  });

  it("커스텀 프롬프트 2종이 저장(PATCH)→전달(program_context.json)→core 로 이어진다", () => {
    const idx = read("index.ts");
    assert.match(idx, /"titlePrompt", "recommendPrompt"/,
      "PATCH /api/programs/:id 병합 목록에 커스텀 프롬프트 필드가 없다");
    const cp = read("content-pipeline.ts");
    const ctxBlock = cp.match(/program_context\.json 로 넘겨[\s\S]{0,1500}/)?.[0] ?? cp;
    assert.match(ctxBlock, /"titlePrompt", "recommendPrompt"/,
      "content-pipeline 이 program_context.json 에 커스텀 프롬프트를 안 싣는다 — core 미도달");
  });
});

describe("발행 직전 재검증", () => {
  it("사람이 고쳐서 규격을 어기면 잡는다", () => {
    assert.deepEqual(validateForChannel({ title: "제목", description: "짧다" }, "naverclip").length, 1);
    assert.deepEqual(validateForChannel({ title: "", description: "충분히 긴 설명입니다" }, "youtube"),
      ["제목이 비어 있습니다."]);
    assert.deepEqual(validateForChannel({ title: "가".repeat(101), description: "설명" }, "youtube").length, 1);
  });

  it("규격에 맞으면 통과한다", () => {
    assert.deepEqual(validateForChannel({ title: "정상 제목", description: "충분히 긴 설명입니다." }, "youtube"), []);
  });
});
