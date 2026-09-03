/**
 * 챗봇이 **지어낸 링크를 내보내지 못한다**는 것을 고정한다.
 *
 * 모델은 그럴듯한 경로를 잘 만든다 — `/settings/notifications` 처럼. 사용자는 눌러 보고
 * 404 를 만난 뒤에야 그게 없는 화면인 줄 안다. 도우미가 주는 링크는 "여기로 가면 된다"는
 * 약속이라, **틀린 링크는 안 주느니만 못하다.**
 *
 * 후처리는 링크 문법만 벗기고 **말은 남긴다.** 문장을 통째로 버리면 답이 이상해지고,
 * 링크를 그대로 두면 사용자가 헛걸음한다. 사이 값이 "글자는 맞되 못 누른다" 다.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_LINKS, sanitizeLinks } from "../chatbot/catalog.ts";

describe("답변 링크 후처리", () => {
  it("실재하는 화면 링크는 남고 목록에도 실린다", () => {
    const out = sanitizeLinks("설정은 [자동 배포](/automation) 화면에서 합니다.");
    assert.equal(out.text, "설정은 [자동 배포](/automation) 화면에서 합니다.");
    assert.deepEqual(out.links, [{ label: "자동 배포", href: "/automation" }]);
  });

  it("없는 화면은 링크가 벗겨지고 말만 남는다", () => {
    const out = sanitizeLinks("[알림 설정](/settings/notifications)에서 바꾸세요.");
    assert.equal(out.text, "알림 설정에서 바꾸세요.");
    assert.deepEqual(out.links, []);
  });

  it("id 가 붙은 하위 경로는 통과한다 — 조회 도구가 실제 id 를 준다", () => {
    const out = sanitizeLinks("[3화](/episodes/ep_9f2c) 를 보세요.");
    assert.deepEqual(out.links, [{ label: "3화", href: "/episodes/ep_9f2c" }]);
  });

  it("바깥 링크는 허용 호스트만 남는다", () => {
    const ok = sanitizeLinks("[영상](https://www.youtube.com/watch?v=abc)");
    assert.deepEqual(ok.links, [{ label: "영상", href: "https://www.youtube.com/watch?v=abc" }]);

    const bad = sanitizeLinks("[안내 문서](https://help.example.com/guide)");
    assert.equal(bad.text, "안내 문서");
    assert.deepEqual(bad.links, []);
  });

  it("http(평문)·javascript 는 통과하지 못한다", () => {
    assert.deepEqual(sanitizeLinks("[a](http://youtube.com/x)").links, []);
    assert.deepEqual(sanitizeLinks("[a](javascript:alert(1))").links, []);
  });

  it("같은 링크가 여러 번 나와도 한 번만 싣는다", () => {
    const out = sanitizeLinks("[배포](/distribution) 와 [배포](/distribution)");
    assert.equal(out.links.length, 1);
  });

  it("링크가 아무리 많아도 상한을 넘지 않는다", () => {
    const many = ["/dashboard", "/programs", "/analyze", "/media", "/edits", "/assets", "/search", "/credits"]
      .map((h) => `[${h}](${h})`).join(" ");
    assert.equal(sanitizeLinks(many).links.length, MAX_LINKS);
  });

  it("링크가 없는 답은 그대로 지나간다", () => {
    const text = "크레딧이 12개 남았습니다.";
    assert.deepEqual(sanitizeLinks(text), { text, links: [] });
  });

  // 실측(2026-09-03): flash-lite 는 마크다운 링크로 쓰라고 시켜도 경로를 그냥 적는 일이 잦다.
  // 그때 링크가 통째로 사라지면 위젯이 버튼을 못 그린다 — 조용히 요구사항이 빠지는 자리다.
  describe("맨 텍스트 경로도 줍는다", () => {
    it("본문은 그대로 두고 링크만 모은다", () => {
      const text = "자동 배포는 /automation 에서 켭니다.";
      const out = sanitizeLinks(text);
      assert.equal(out.text, text, "본문을 고쳐 쓰면 안 된다");
      assert.deepEqual(out.links, [{ label: "자동 배포", href: "/automation" }]);
    });

    it("코드표시(`/media`)도 잡는다", () => {
      assert.deepEqual(sanitizeLinks("결과는 `/media` 에 있습니다.").links,
        [{ label: "미디어", href: "/media" }]);
    });

    it("없는 경로는 안 줍는다", () => {
      assert.deepEqual(sanitizeLinks("/settings/notifications 에서 바꾸세요.").links, []);
    });

    it("경로가 아닌 슬래시(and/or · 날짜)는 안 줍는다", () => {
      assert.deepEqual(sanitizeLinks("A and/or B · 2026/08/31 기준").links, []);
    });

    it("마크다운 링크와 같은 경로면 한 번만 담는다", () => {
      const out = sanitizeLinks("[배포](/distribution) 는 /distribution 화면입니다.");
      assert.equal(out.links.length, 1);
      assert.equal(out.links[0].label, "배포", "마크다운 라벨이 우선이다");
    });
  });
});
