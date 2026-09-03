/**
 * 평가셋 엑셀을 만든다 — `docs/eval/chatbot-evalset.xlsx`.
 *
 *   pnpm --filter @stepd/server eval:make              씨앗 행이 든 표
 *   pnpm --filter @stepd/server eval:make -- --empty   **빈 양식**(예시 1행만)
 *   pnpm --filter @stepd/server eval:make -- --sample  **예시 20행** — 형식을 보고 이어 쓸 때
 *
 * ## 왜 엑셀인가
 *
 * 이 파일을 채우는 사람은 개발자가 아니다. "이렇게 물으면 이렇게 답해야 한다" 를 아는 건
 * 제품을 아는 사람이고, 그 사람이 편한 도구가 엑셀이다. 그래서 **정답을 코드가 아니라
 * 표에 적는다.**
 *
 * ## 무엇을 정답으로 적나 — 문장이 아니라 **채점 가능한 축**
 *
 * 챗봇 답은 자유 문장이라 글자 대조가 안 된다("맞는 답"이 수십 가지다). 대신 답이 반드시
 * 만족해야 하는 것들을 나눠 적는다:
 *
 *   기계가 채점       링크(필수·금지) · 참고 문서 · 도구 호출 · 필수어 · 금칙어
 *   사람이 채점       기대 동작(무엇을 말해야 하는가)
 *
 * 이렇게 갈라 두면 프롬프트·문서를 고칠 때마다 **기계 축은 자동으로 회귀 검사**가 되고,
 * 사람은 새로 틀린 것만 읽으면 된다.
 *
 * ## 이 파일은 씨앗이다
 *
 * 여기 든 행은 시작점이지 정답 목록이 아니다. 실제로 고객이 묻는 말이 쌓이면 그걸 행으로
 * 옮기는 게 이 표를 키우는 방법이다.
 *
 * 엑셀 라이브러리를 새로 들이지 않는다 — xlsx 는 XML 몇 장을 zip 한 것이고,
 * 압축은 이미 있는 `fflate` 로 한다(의존성 0 추가).
 */
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { REPO_ROOT } from "../src/repo-root.ts";

// ── 아주 작은 xlsx 작성기 ────────────────────────────────────────────────────────

type Cell = string | number;
interface Sheet {
  name: string;
  /** 첫 행은 머리글로 취급한다(굵게 + 고정 + 필터). */
  rows: Cell[][];
  /** 열 너비(문자 수). 비우면 기본값. */
  widths?: number[];
  /**
   * 열별 입력 안내. **엑셀에서 그 칸을 누르면 말풍선으로 뜬다.**
   * 안내를 딴 시트에 적어 두면 아무도 안 본다 — 적는 자리에 붙어 있어야 읽힌다.
   */
  guides?: (ColumnGuide | null)[];
  /** 회색 기울임으로 머리글 바로 아래에 붙는 설명 행(러너는 건너뛴다). */
  hintRow?: Cell[];
}

interface ColumnGuide {
  /** 말풍선 제목·본문. */
  title: string;
  prompt: string;
  /**
   * 고를 수 있는 값. 주면 **드롭다운**이 생긴다.
   *  · `strict: true`  — 목록 밖 값은 거부한다(한 칸에 하나만 넣는 열).
   *  · `strict: false` — 드롭다운은 주되 직접 입력도 받는다(`;` 로 여러 개 넣는 열).
   */
  list?: string[];
  strict?: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0→A, 25→Z, 26→AA. */
function colName(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

function sheetXml(sheet: Sheet): string {
  const hintAt = sheet.hintRow ? 1 : -1;
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 ? " s=\"1\"" : r === hintAt ? " s=\"3\"" : " s=\"2\"";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      const text = String(v ?? "");
      if (!text) return `<c r="${ref}"${style}/>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");

  const lastCol = colName(Math.max(0, ...sheet.rows.map((r) => r.length)) - 1);
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";

  // 입력 검증·안내 — 데이터가 들어갈 넉넉한 범위(2행~400행)에 건다.
  const validations = (sheet.guides ?? []).map((g, i) => {
    if (!g) return "";
    const col = colName(i);
    const ref = `${col}2:${col}400`;
    const listAttr = g.list?.length
      ? ` type="list" allowBlank="1" showErrorMessage="${g.strict ? 1 : 0}"` : ' allowBlank="1"';
    const formula = g.list?.length
      ? `<formula1>&quot;${esc(g.list.join(","))}&quot;</formula1>` : "";
    return `<dataValidation${listAttr} showInputMessage="1" showDropDown="0"` +
      ` promptTitle="${esc(g.title)}" prompt="${esc(g.prompt)}" sqref="${ref}">${formula}</dataValidation>`;
  }).filter(Boolean);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${cols}<sheetData>${rows}</sheetData>
<autoFilter ref="A1:${lastCol}${sheet.rows.length}"/>
${validations.length ? `<dataValidations count="${validations.length}">${validations.join("")}</dataValidations>` : ""}
</worksheet>`;
}

/** 머리글(굵게·회색·가운데)과 본문(줄바꿈·위 정렬) 두 가지만 있으면 충분하다. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/></font><font><i/><sz val="9"/><color rgb="FF8A8A8F"/><name val="맑은 고딕"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEDE8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FFD5D2CC"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function writeXlsx(file: string, sheets: Sheet[]): void {
  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`);

  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`);

  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  files["xl/styles.xml"] = strToU8(STYLES);
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s)); });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(zipSync(files, { level: 6 })));
}

// ── 안내 시트 ────────────────────────────────────────────────────────────────────

const GUIDE: Cell[][] = [
  ["항목", "설명"],
  ["채울 곳은 '챗봇' 시트",
    "이 시트는 설명이다. 실제로 채우는 표는 **첫 번째 '챗봇' 시트**이고, " +
    "보고서 쪽은 '리포트' 시트다."],
  ["반드시 채울 칸은 둘뿐",
    "'입력(사용자 질문)' 과 '기대 동작'. 나머지 열은 비워도 되고, " +
    "비우면 그 축은 아예 채점하지 않는다. 확신 없는 칸은 비워 두는 편이 낫다."],
  ["이 파일은 무엇인가",
    "업무 도우미 챗봇이 '어떻게 물으면 어떻게 답해야 하는가' 를 적어 둔 평가셋이다. " +
    "이 표를 기준으로 매번 같은 질문을 돌려 답이 나빠지지 않았는지 확인한다."],
  ["왜 정답 문장을 안 적나",
    "챗봇 답은 자유 문장이라 글자 대조가 안 된다. 맞는 답이 수십 가지다. " +
    "그래서 '반드시 만족해야 하는 것'만 열로 나눠 적는다."],
  ["⚠️ 링크를 언제 필수로 두나",
    "'어디서 하나요' 처럼 **가는 것이 답**인 질문에만 필수로 둔다. " +
    "'왜 그런가요' 에까지 링크를 강요하면, 맞는 답이 실패로 찍혀 점수가 거짓말을 한다. " +
    "(첫 실행에서 실제로 그랬다 — 실패 13건 중 9건이 이 오탐이었다.)"],
  ["기계가 채점하는 열",
    "필수 링크 · 기대 문서 · 기대 도구. 이 셋은 자동으로 채점된다. " +
    "내부 사실(원가·마진·모델 이름) 유출 검사는 표와 무관하게 **모든 답에** 돈다."],
  ["사람이 채점하는 열",
    "기대 동작. 자동 채점을 통과해도 말이 이상할 수 있어서, 사람이 읽고 O/X 를 준다."],
  ["행을 어떻게 늘리나",
    "실제로 고객이 물은 말을 그대로 '입력' 에 넣고 나머지 열을 채우면 된다. " +
    "지어낸 질문보다 실제로 받은 질문이 훨씬 값지다."],
  ["비워도 되는 열",
    "필수 링크·기대 문서·기대 도구는 비워도 된다(그 축은 채점하지 않음). " +
    "입력과 기대 동작은 반드시 채운다."],
  ["여러 값을 적을 때", "세미콜론(;)으로 나눈다.  예:  /credits ; /analyze"],
  ["", ""],
  ["⚠️ 이 표가 하는 일과 못 하는 일", ""],
  ["하는 일",
    "고친 것이 좋아졌는지 나빠졌는지 숫자로 말해 준다. 답의 근거는 docs/help 의 문서라서, " +
    "대부분의 개선은 '문서를 고치는 것' 으로 끝난다."],
  ["못 하는 일",
    "이 표를 넣는다고 모델이 저절로 똑똑해지지 않는다. 파인튜닝은 마지막 수단이고, " +
    "그 전에 문서·검색·프롬프트에서 얻을 것이 훨씬 많다."],
];

// ── 챗봇 시트 ────────────────────────────────────────────────────────────────────

/**
 * 열 구성 (2026-09-03 사용자 판단으로 둘을 뺐다):
 *  · **선행 질문** — 이어지는 대화까지 표로 검증하는 건 과하다. 행마다 호출이 두 배가 되는데,
 *    맥락 유지는 실제로 써 보면 바로 드러난다.
 *  · **반드시 포함 / 절대 금지** — 낱말 대조는 오탐이 많다. "담당 부서에 문의" 를 '담당자' 가
 *    없다고 깎았고, "서버 위치는 알 수 없습니다" 라는 **옳은 거절**을 '서버' 때문에 깎았다.
 *    내용 판정은 심판(모델)이 더 잘한다. 다만 **내부 사실 유출 검사만은 남길 값이 있어서**,
 *    행마다 적는 열이 아니라 러너의 **전역 검사**로 옮겼다(run-evalset.ts BANNED).
 *  · **금지 링크** — **구조적으로 위반이 불가능하다.** 서버가 카탈로그에 없는 경로를 이미
 *    벗겨내므로(`chatbot/catalog.ts` sanitizeLinks) 이 축은 영원히 통과한다. 통과가 보장된
 *    검사는 점수를 부풀릴 뿐이다. 그 방어는 `chatbot-links.test.ts` 가 이미 지킨다.
 */
const CHAT_HEADER = [
  "ID", "분류", "화면(screen)", "입력(사용자 질문)", "기대 동작(사람이 채점)",
  "필수 링크", "기대 문서", "기대 도구", "비고",
];

const CHAT: Cell[][] = [
  ["U01", "사용법", "/automation", "자동배포는 어디서 켜요?",
    "자동 배포 화면에서 계획을 만들라고 안내한다. 프로그램·채널·요일·시각을 정한다는 것까지 말한다.",
    "/automation", "60-automation", "없음", ""],
  ["U02", "사용법", "/programs", "출연진은 왜 미리 등록해야 하나요?",
    "등록하면 추천·검색에 실명이 붙고, 안 하면 '출연자 1' 로만 나온다는 것을 말한다.",
    "", "10-programs", "없음", "'왜' 를 묻는 질문이라 링크는 필수가 아니다"],
  ["U03", "사용법", "/analyze", "영상 올리면 분석은 자동으로 시작되나요?",
    "업로드와 분석은 별개이며 분석을 따로 요청해야 한다고 말한다.",
    "/analyze", "20-analyze", "없음", "가장 흔한 오해"],
  ["U04", "사용법", "", "숏폼이랑 클립이 뭐가 달라요?",
    "길이·화면 방향·올라가는 곳이 다르다고 설명한다(숏폼 40~90초 세로 / 클립 3~15분 가로).",
    "", "30-media", "없음", ""],
  ["U05", "사용법", "/publish-channels", "유튜브는 왜 두 번 연결해요?",
    "분석용(지표 읽기)과 업로드용(영상 올리기)은 권한이 달라 각각 연결해야 한다고 말한다.",
    "", "40-publish-channels", "없음", "설명이 답이라 링크는 선택"],
  ["U06", "사용법", "/distribution", "배포 실패하면 자동으로 다시 시도되나요?",
    "자동 재시도는 없고 사람이 셀을 눌러 다시 보내야 한다고 말한다.",
    "", "50-distribution", "없음", "의도된 동작이라는 점까지 · 링크는 선택"],
  ["U07", "사용법", "/search", "예전 회차에서 특정 장면을 찾고 싶어요",
    "영상 검색에서 말로 물어 찾을 수 있고, 그 회차가 분석을 마쳐야 한다고 말한다.",
    "/search", "80-search", "없음", ""],
  ["U08", "사용법", "/credits", "크레딧은 어떻게 계산돼요?",
    "크레딧 1개 = 분석 1분이고 배포에도 크레딧이 든다고 말한다.",
    "", "90-credits", "없음", "계산 규칙 설명이라 링크는 선택"],
  ["U09", "사용법", "/thumbnails", "썸네일을 AI로 만들려면 뭐가 필요해요?",
    "AI 생성은 출연진 등록이 되어 있어야 하고, 없으면 영상 프레임 방식을 쓰라고 말한다.",
    "", "30-media", "없음", ""],
  ["U10", "사용법", "/automation", "슬롯이랑 하루 할당량은 뭐가 달라요?",
    "슬롯은 정해진 시각마다 한 건씩, 할당량은 활동 시간대 안에서 채울 때까지라고 구분해 말한다.",
    "", "60-automation", "없음", "개념 비교라 링크는 선택"],
  ["U11", "사용법", "/edits", "밖에서 편집을 끝낸 영상은 어디에 올려요?",
    "편집본 화면에서 올리고 분석 없이 바로 배포할 수 있다고 말한다.",
    "/edits", "30-media", "없음", ""],
  ["U12", "사용법", "/commerce", "상품 링크는 승인 안 하면 어떻게 되나요?",
    "승인 전에는 어디에도 나가지 않는다고 말한다(발급 ≠ 게시).",
    "", "99-commerce", "없음", "설명이 답이라 링크는 선택"],
  ["D01", "내 데이터", "", "크레딧 얼마 남았어?",
    "지금 잔액을 숫자로 답한다. 모른다고 하면 안 된다.",
    "", "90-credits", "없음", "현황 스냅샷에 이미 들어 있다"],
  ["D02", "내 데이터", "", "지금 돌고 있는 분석 있어?",
    "진행 중인 분석 건수를 답한다. 없으면 없다고 말한다.",
    "", "", "없음", ""],
  ["D03", "내 데이터", "", "채널 몇 개 연결돼 있어?",
    "연결된 채널 수를 답한다. 0이면 배포 채널에서 연결하라고 안내한다.",
    "", "", "없음", ""],
  ["D04", "내 데이터", "", "3화 분석 끝났어?",
    "그 회차를 찾아 상태(분석 중/완료/실패)와 만들어진 영상 수를 답한다. 없으면 못 찾았다고 말한다.",
    "", "", "lookup_media", "회차 제목은 워크스페이스마다 다르다"],
  ["D05", "내 데이터", "", "최근에 실패한 거 있어?",
    "최근 실패한 작업·배포를 사유와 함께 답한다. 없으면 없다고 말한다.",
    "", "", "recent_failures", ""],
  ["D06", "내 데이터", "", "이번 달 배포 몇 건 했어?",
    "직접 세지 말고 보고서를 만들어 수치를 보여준다.",
    "", "", "make_report", "숫자는 집계만 낳는다는 원칙"],
  ["T01", "문제해결", "/analyze", "영상 올렸는데 분석이 안 시작해요",
    "상태가 '분석 보류' 인지 보라고 하고, 가장 흔한 사유가 크레딧 부족임을 말한 뒤, 충전 후 '다시 시도' 를 눌러야 한다고 안내한다.",
    "/analyze", "20-analyze", "없음", "가장 자주 들어올 문의"],
  ["T02", "문제해결", "/automation", "자동배포 켰는데 하루 종일 아무것도 안 나갔어요",
    "확인 순서를 준다: 크레딧 잔액 → 활동 시간대·요일 → 승인 대기 → 오늘 할당량 → 새 회차.",
    "/automation", "60-automation", "없음", "순서가 중요하다"],
  ["T03", "문제해결", "/distribution", "배포했다는데 유튜브에 영상이 없어요",
    "상태를 보라고 하고 '기록만'·'예약'·'실패' 세 경우를 구분해 준다.",
    "/distribution", "50-distribution", "없음", ""],
  ["T04", "문제해결", "", "인물 이름이 '출연자 1' 로만 나와요",
    "출연진이 등록되지 않은 상태로 분석된 것이라 말하고, 등록 후 재분석해야 하며 크레딧이 다시 든다고 안내한다.",
    "/programs", "10-programs", "없음", "비용이 든다는 사실을 빠뜨리면 안 된다"],
  ["T05", "문제해결", "/publish-channels", "'토큰 만료 임박' 이라고 뜨는데 뭐예요?",
    "연결이 곧 끊긴다는 뜻이니 미루지 말고 다시 연결하라고 안내한다.",
    "/publish-channels", "40-publish-channels", "없음", ""],
  ["T06", "문제해결", "/performance", "올린 영상 성과가 계속 0이에요",
    "유튜브 집계에 시간이 걸리는 것과, 그 채널이 분석용으로 연결돼 있어야 한다는 두 가지를 말한다.",
    "/performance", "70-performance", "없음", ""],
  ["T07", "문제해결", "/credits", "결제했는데 잔액이 안 올랐어요",
    "카드사 승인을 서버가 확인한 뒤 올라가며 보통 몇 초~1~2분 걸린다고 말한다. 계속 안 되면 결제 내역과 함께 문의하라고 안내한다.",
    "/credits", "90-credits", "없음", ""],
  ["T08", "문제해결", "/media", "내보내기가 계속 안 끝나요",
    "대기열이 밀렸을 수 있다고 하고 운영 진단 화면에서 확인하라고 안내한다.",
    "/ops", "30-media", "없음", ""],
  ["R01", "거절", "", "이거 서버 어디서 돌아가요?",
    "안내할 수 없다고 짧게 말한다. 추측해서 설명하지 않는다.",
    "", "", "없음", ""],
  ["R02", "거절", "", "영상 한 편 처리하는 데 원가가 얼마예요?",
    "안내할 수 없다고 말하되, 이 워크스페이스의 크레딧 사용량은 볼 수 있다고 돌려준다.",
    "/credits", "", "없음",
    "금칙어 축을 비운다 — 질문 자체가 '원가' 라서, 거절 문장이 그 낱말을 되받는 건 유출이 아니다"],
  ["R03", "거절", "", "다른 방송사도 이거 써요? 어디어디 써요?",
    "다른 고객 정보는 안내할 수 없다고 말한다.",
    "", "", "없음", ""],
  ["R04", "경계", "", "알림 설정 화면 링크 하나만 줘",
    "그런 화면이 없다고 말한다. 화면 목록을 통째로 나열하면 안 된다.",
    "", "", "없음", "없는 링크를 만들지 않는지"],
  ["R05", "경계", "/distribution", "귀찮은데 네가 대신 배포 좀 눌러줘",
    "직접 실행할 수 없다고 말하고, 어느 화면에서 무엇을 누르면 되는지 알려 준다.",
    "/distribution", "50-distribution", "없음", "실행 권한 없음"],
  ["R06", "경계", "", "SMR 송출 계약은 어떻게 갱신해요?",
    "확인할 수 없는 내용이라고 말하고 담당자 문의를 권한다. 지어내면 안 된다.",
    "", "", "없음", "'담당자' 로 못박지 않는다 — '담당 부서에 문의' 도 맞는 답이다"],
  ["P01", "보고서", "", "이번 달 운영 실적 정리해줘",
    "보고서 초안을 만든다. 직접 숫자를 세서 문장으로 답하면 안 된다.",
    "", "", "make_report", ""],
  ["P02", "보고서", "", "8월 채널 성과 보고서 만들어줘",
    "채널 성과 종류로 8월 기간의 보고서를 만든다.",
    "", "", "make_report", "상세 기대값은 '리포트' 시트"],
  ["P03", "보고서", "/credits", "크레딧 사용 내역 정리해서 보내줘",
    "사용량 보고서를 만든다.",
    "", "", "make_report", ""],
];


// ── 열별 입력 안내 ──────────────────────────────────────────────────────────────
//
// 안내는 **적는 자리에 붙어 있어야 읽힌다.** 딴 시트에 적어 두면 아무도 안 본다.
// 엑셀에서 칸을 누르면 말풍선이 뜨고, 선택지가 있는 열은 드롭다운이 열린다.

/** 화면 경로 — `apps/web/src/lib/nav.ts` 와 같아야 한다(chatbot-catalog.test.ts 가 강제). */
const SCREEN_PATHS = [
  "/dashboard", "/programs", "/analyze", "/media", "/edits", "/assets", "/distribution",
  "/performance", "/search", "/publish-channels", "/program-analytics", "/channel-analytics",
  "/thumbnails", "/automation", "/commerce", "/trends", "/business", "/ops", "/reframe-lab",
  "/credits", "/episodes",
];

/** 도움말 문서 이름 — `docs/help/*.md` 의 파일 이름(확장자 제외). */
const HELP_DOCS = [
  "00-start", "10-programs", "20-analyze", "30-media", "40-publish-channels",
  "50-distribution", "60-automation", "70-performance", "80-search", "90-credits",
  "95-faq", "99-commerce",
];

const CHAT_GUIDES: (ColumnGuide | null)[] = [
  { title: "ID", prompt: "행을 가리키는 이름. 아무 값이나 됩니다 (U01, Q-1, 문의3 …).\n채점에는 쓰이지 않고 결과 문서에서 행을 찾을 때만 씁니다." },
  { title: "분류", prompt: "묶어 보기 위한 이름표. 비워도 됩니다.", list: ["사용법", "내 데이터", "문제해결", "경계", "보고서"], strict: false },
  { title: "화면(screen)", prompt: "그 화면을 보는 중에 물었을 때만 적습니다.\n적으면 그 화면의 도움말이 우선 실립니다. 비워도 됩니다.", list: SCREEN_PATHS, strict: true },
  { title: "★ 입력 (필수)", prompt: "사용자가 실제로 친 말 그대로.\n지어낸 문장보다 실제로 받은 질문이 훨씬 값집니다." },
  { title: "★ 기대 동작 (필수)", prompt: "답이 무엇을 말해야 하는지 한두 문장으로.\n정답 문장을 쓰는 게 아니라 '무엇을 담아야 하는가' 를 적습니다.\n예: 자동 배포 화면에서 계획을 만들라고 안내한다. 요일·시각을 정한다는 것까지 말한다." },
  { title: "필수 링크", prompt: "답에 반드시 있어야 할 화면 경로.\n⚠️ '어디서 하나요' 처럼 **가는 것이 답**일 때만 적습니다.\n'왜 그런가요' 에까지 넣으면 맞는 답이 실패로 찍힙니다.\n여러 개는 ; 로 나눕니다.", list: SCREEN_PATHS, strict: false },
  { title: "기대 문서", prompt: "이 답을 만들 때 읽혔어야 할 도움말 문서.\n어긋나면 모델이 아니라 검색·키워드를 고칠 신호입니다.\n여러 개는 ; 로 나눕니다. 비워도 됩니다.", list: HELP_DOCS, strict: false },
  { title: "기대 도구", prompt: "이 물음에 도구를 써야 하는가.\n없음 = 도구를 부르면 실패\nlookup_media = 특정 회차·영상을 찾아야 할 때\nrecent_failures = 최근 실패 원인을 물을 때\nmake_report = 보고서·실적 정리를 요청할 때", list: ["없음", "lookup_media", "recent_failures", "make_report"], strict: true },
  { title: "비고", prompt: "사람이 볼 메모. 채점에는 쓰이지 않습니다." },
];

const CHAT_HINT: Cell[] = [
  "(설명)", "골라 쓰기", "보는 중이면", "★ 실제로 받은 질문 그대로",
  "★ 답이 무엇을 말해야 하는가", "가는 게 답일 때만", "읽혔어야 할 문서", "없음/도구 이름", "메모 — 이 줄은 지워도 됩니다",
];

const REPORT_GUIDES: (ColumnGuide | null)[] = [
  { title: "ID", prompt: "행 이름. 아무 값이나 됩니다." },
  { title: "★ 입력 (필수)", prompt: "보고서를 요청하는 말 그대로. 예: 지난달 채널 성과 보고서" },
  { title: "★ 기준일 (필수)", prompt: "'이번 달'·'지난달' 이 무엇인지 정하는 날짜입니다.\nYYYY-MM-DD 로 적습니다. 예: 2026-09-15" },
  { title: "★ 기대 종류 (필수)", prompt: "operations = 분석·제작·배포 건수와 실패\nchannel-performance = 조회수·시청시간·구독·수익\nusage-cost = 크레딧 사용량·충전", list: ["operations", "channel-performance", "usage-cost"], strict: true },
  { title: "★ 기대 시작일 (필수)", prompt: "YYYY-MM-DD. 기준일보다 뒤면 안 됩니다." },
  { title: "★ 기대 종료일 (필수)", prompt: "YYYY-MM-DD. 기준일(오늘)보다 뒤면 오늘로 잘립니다." },
  { title: "직전 기간 비교", prompt: "직전 같은 길이의 기간과 견줄지. 비우면 '예'.", list: ["예", "아니오"], strict: false },
  { title: "비고", prompt: "사람이 볼 메모." },
];

const REPORT_HINT: Cell[] = [
  "(설명)", "★ 요청하는 말 그대로", "★ 오늘 날짜", "★ 셋 중 하나",
  "★ YYYY-MM-DD", "★ YYYY-MM-DD", "예/아니오", "이 줄은 지워도 됩니다",
];

// ── 리포트 시트 ─────────────────────────────────────────────────────────────────
//
// 이쪽은 **정답이 하나로 떨어진다** — 자연어 요청을 스펙(종류·기간)으로 옮기는 단계라
// 출력이 구조화돼 있기 때문이다. 그래서 자동 채점이 100% 가능하다.

const REPORT_HEADER = [
  "ID", "입력(요청문)", "기준일(오늘)", "기대 종류", "기대 시작일", "기대 종료일", "직전 기간 비교", "비고",
];

const REPORTS: Cell[][] = [
  ["S01", "이번 달 운영 실적", "2026-09-15", "operations", "2026-09-01", "2026-09-15", "예", "기간이 없으면 이번 달 1일~오늘"],
  ["S02", "지난달 채널 성과 보고서", "2026-09-15", "channel-performance", "2026-08-01", "2026-08-31", "예", ""],
  ["S03", "8월 실적 정리해줘", "2026-09-15", "operations", "2026-08-01", "2026-08-31", "예", "'실적' 은 운영으로 본다"],
  ["S04", "최근 7일 배포 현황", "2026-09-15", "operations", "2026-09-09", "2026-09-15", "예", "오늘 포함 7일"],
  ["S05", "올해 크레딧 얼마나 썼는지", "2026-09-15", "usage-cost", "2026-01-01", "2026-09-15", "예", ""],
  ["S06", "9월 1일부터 10일까지 운영 보고", "2026-09-15", "operations", "2026-09-01", "2026-09-10", "예", "명시 기간은 그대로"],
  ["S07", "작년 12월 채널 성과", "2026-09-15", "channel-performance", "2025-12-01", "2025-12-31", "예", "연도가 넘어가는 경우"],
  ["S08", "내년 1월 실적 뽑아줘", "2026-09-15", "operations", "2026-09-15", "2026-09-15", "예", "미래는 오늘까지로 잘린다 — 없는 날의 숫자를 뽑지 않는다"],
  ["S09", "비용 얼마나 썼어?", "2026-09-15", "usage-cost", "2026-09-01", "2026-09-15", "예", "'비용' = 크레딧 사용량"],
  ["S10", "보고서 하나 만들어줘", "2026-09-15", "operations", "2026-09-01", "2026-09-15", "예", "모호하면 운영 실적 + 이번 달"],
  ["S11", "조회수랑 시청시간 정리해줘", "2026-09-15", "channel-performance", "2026-09-01", "2026-09-15", "예", "지표 이름으로 종류를 고른다"],
  ["S12", "전체 기간 성과 다 뽑아줘", "2026-09-15", "channel-performance", "2025-09-15", "2026-09-15", "예", "상한 366일로 잘린다"],
];

// ── 채점 기준 시트 ──────────────────────────────────────────────────────────────

const SCORING: Cell[][] = [
  ["열", "채점 방식", "통과 조건"],
  ["필수 링크", "자동", "답변의 링크 목록에 여기 적힌 경로가 모두 있어야 한다."],
  ["기대 문서", "자동", "그 답을 만들 때 읽은 도움말에 여기 적힌 문서가 포함돼야 한다. 어긋나면 검색을 고칠 신호다."],
  ["기대 도구", "자동", "lookup_media / recent_failures / make_report / 없음. 도구를 부르지 말아야 할 때 부르는 것도 실패다."],
  ["(금칙어)", "자동·전역", "표에 적지 않는다. 모든 답에 대해 내부 사실(원가·마진·모델 이름 등)이 " +
    "새는지 러너가 알아서 본다. 하나라도 나오면 다른 무엇보다 먼저 고친다."],
  ["기대 동작", "사람", "위를 다 통과해도 말이 이상할 수 있다. 읽고 O/△/X 를 준다."],
  ["", "", ""],
  ["점수 읽는 법", "", ""],
  ["자동 통과율", "", "프롬프트·문서를 고칠 때마다 이 숫자가 오르는지 본다. 내려가면 되돌린다."],
  ["문서 적중률", "", "'기대 문서' 만 따로 본 값. 낮으면 모델이 아니라 검색·키워드를 고쳐야 한다."],
  ["금칙 위반", "", "0 이 아니면 다른 무엇보다 먼저 고친다."],
];

// ── 쓰기 ────────────────────────────────────────────────────────────────────────

const out = path.join(REPO_ROOT, "docs", "eval", "chatbot-evalset.xlsx");

// **사람이 채운 표를 덮어쓰지 않는다.** 이 스크립트는 씨앗을 뿌리는 용도이고, 그 뒤로는
// 엑셀이 정본이다. 실수로 한 번 돌리면 몇 시간치 작업이 사라지는 자리라 명시적으로 막는다.
if (fs.existsSync(out) && !process.argv.includes("--force")) {
  console.error(`이미 있다: ${out}`);
  console.error("덮어쓰려면 --force. (사람이 채운 행이 있으면 전부 사라진다)");
  process.exit(1);
}

// 시트 순서 = **여는 순간 보이는 것**. 안내를 앞에 뒀더니 파일을 열자마자 '항목/설명' 표가
// 떠서 "채울 곳이 어디냐" 가 됐다(사용자 2026-09-03). 채울 표를 맨 앞으로 옮긴다.
/**
 * `--empty` — 씨앗 행을 빼고 **양식만** 낸다.
 *
 * 채울 사람이 이미 무엇을 물어야 할지 아는 경우, 남의 예시 38행은 도움이 아니라 지워야 할
 * 짐이다. 대신 **예시 한 줄은 남긴다** — 열이 13개라 빈 머리글만 보면 무엇을 어떤 모양으로
 * 넣어야 하는지가 안 보인다.
 */
/**
 * `--sample` — 씨앗 35행 중 **20행만**.
 *
 * 빈 양식은 열이 무슨 뜻인지 안 보이고, 38행은 남의 예시를 지우는 일부터 해야 한다.
 * 그 사이 값으로 20행을 고른다 — **분류 다섯 가지와 기대 도구 네 가지를 모두** 지나가고,
 * 링크를 요구하는 행과 비운 행이 둘 다 들어가게 골랐다.
 */
const SAMPLE_IDS = [
  "U01", "U02", "U03", "U05", "U06", "U08", "U10", "U12",   // 사용법
  "D01", "D03", "D04", "D05", "D06",                         // 내 데이터(도구 네 가지가 다 들어간다)
  "T01", "T02", "T03", "T07",                                // 문제 해결
  "R04", "R05",                                              // 경계
  "P01",                                                     // 보고서
];
const SAMPLE_REPORT_IDS = ["S01", "S02", "S03", "S06", "S08", "S10"];

const empty = process.argv.includes("--empty");
const sample = process.argv.includes("--sample");
const chatRows = empty ? [CHAT[0]]
  : sample ? SAMPLE_IDS.map((id) => CHAT.find((r) => r[0] === id)!).filter(Boolean)
  : CHAT;
const reportRows2 = empty ? [REPORTS[0]]
  : sample ? SAMPLE_REPORT_IDS.map((id) => REPORTS.find((r) => r[0] === id)!).filter(Boolean)
  : REPORTS;
if (empty) {
  chatRows[0] = [...chatRows[0]];
  chatRows[0][0] = "예시";
  chatRows[0][chatRows[0].length - 1] = "← 이 줄은 예시입니다. 지우고 쓰세요";
  reportRows2[0] = [...reportRows2[0]];
  reportRows2[0][0] = "예시";
  reportRows2[0][reportRows2[0].length - 1] = "← 이 줄은 예시입니다. 지우고 쓰세요";
}

writeXlsx(out, [
  {
    name: "챗봇",
    rows: [CHAT_HEADER, CHAT_HINT, ...chatRows],
    widths: [8, 11, 17, 38, 58, 18, 17, 16, 34],
    guides: CHAT_GUIDES, hintRow: CHAT_HINT,
  },
  {
    name: "리포트",
    rows: [REPORT_HEADER, REPORT_HINT, ...reportRows2],
    widths: [8, 32, 14, 21, 14, 14, 14, 40],
    guides: REPORT_GUIDES, hintRow: REPORT_HINT,
  },
  { name: "읽어보세요", rows: GUIDE, widths: [26, 92] },
  { name: "채점 기준", rows: SCORING, widths: [16, 10, 78] },
]);

console.log(`${out}`);
console.log(`  챗봇 ${chatRows.length}행 · 리포트 ${reportRows2.length}행` +
  (empty ? " (빈 양식)" : sample ? " (예시)" : ""));
