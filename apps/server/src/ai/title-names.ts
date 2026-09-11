/** 제목 전용 대응표. 대사·화자·인물 분석의 이름을 바꾸지 않는다. */
export interface TitleCast {
  actorName: string;
  characterNames: string[];
}

export function normalizeTitleCast(raw: unknown): TitleCast[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("배우 대응표는 최대 100행까지 입력할 수 있습니다.");
  const owners = new Map<string, string>();
  const actors = new Map<string, Set<string>>();
  for (const row of raw) {
    const actor = typeof row?.actorName === "string" ? row.actorName.trim() : "";
    const names = Array.isArray(row?.characterNames) ? row.characterNames : [];
    if (!actor || actor.length > 50 || !names.length || names.length > 20 ||
        names.some((n: unknown) => typeof n !== "string" || !n.trim() || n.trim().length > 50)) {
      throw new Error("각 행에 배우명과 극중 이름을 입력해 주세요 (이름당 최대 50자).");
    }
    const aliases = actors.get(actor) ?? new Set<string>();
    for (const value of names) {
      const name = value.trim();
      if (owners.has(name) && owners.get(name) !== actor) {
        throw new Error(`'${name}'에 배우가 둘 이상 연결돼 있습니다. 아역·성인역은 구분된 이름으로 입력해 주세요.`);
      }
      owners.set(name, actor);
      aliases.add(name);
    }
    actors.set(actor, aliases);
  }
  // 다른 인물의 극중 이름이 배우명과 겹치면 출력 검증에서 둘을 구별할 수 없다.
  for (const actor of actors.keys()) {
    if (owners.has(actor) && owners.get(actor) !== actor) throw new Error(`'${actor}'의 배우명과 극중 이름이 겹칩니다.`);
  }
  return [...actors].map(([actorName, names]) => ({ actorName, characterNames: [...names] }));
}

export function titleCastOf(program: unknown): TitleCast[] {
  try { return normalizeTitleCast((program as { titleCast?: unknown })?.titleCast ?? []); }
  catch { return []; }
}

export function titleNamesPrompt(program: unknown): string {
  const cast = titleCastOf(program);
  if (!cast.length) return "";
  return "\n\n[제목 인물 표기 — 배우명]\n" +
    cast.map((m) => `- 극중 이름 ${JSON.stringify(m.characterNames)} = 배우명 ${JSON.stringify(m.actorName)}`).join("\n") +
    "\n- title·title_line1·title_line2·제목 후보는 극중 이름 대신 위 배우명(활동명)을 쓴다." +
    "\n- 이 대응표는 이름 변환의 근거다. 장면·대사에 극중 이름이 확인되면 대응 배우명은 대사에 없어도 사용할 수 있다. 기존의 '대사·요약에 나온 이름만' 규칙에 대한 예외다." +
    "\n- 명단에 있다는 이유만으로 등장했다고 판단하지 마라. 해당 구간에 근거가 있는 인물만 쓴다. 대응되지 않거나 아역·성인역 구분이 불확실하면 이름 없는 상황형 제목을 쓴다." +
    "\n- 극중 이름이 든 대사를 제목에서 직접 인용하지 말고 배우명을 쓰는 관찰형 문장으로 다시 쓴다. 조사도 자연스럽게 맞춘다." +
    "\n- 극중 사건을 배우의 실제 사생활·범죄로 서술하지 마라. 필요하면 연기·장면임을 드러낸다. 대사 자막·hook_quote·줄거리·characters는 원문을 유지한다.";
}

/** 알려진 극중 이름이 남으면 문장 전체를 제외한다. 조사·인용을 문자열 치환하지 않는다. */
export function isActorTitle(text: string, program: unknown): boolean {
  const cast = titleCastOf(program);
  // 배우명 안에 극중 이름이 포함된 경우(수지 → 배수지)는 올바른 배우명을 거부하지 않는다.
  let remaining = text;
  for (const actor of cast.map((m) => m.actorName).sort((a, b) => b.length - a.length)) {
    remaining = remaining.split(actor).join("\0");
  }
  return !cast.some((m) => m.characterNames.some((name) =>
    name !== m.actorName && remaining.includes(name)));
}

export const NAMELESS_TITLE = "다시 보는 이 장면";

export function actorTitleOrFallback(text: string, program: unknown): string {
  return isActorTitle(text, program) ? text : NAMELESS_TITLE;
}
