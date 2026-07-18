/**
 * STEP-D — Cast registry (출연자 레지스트리) validation + shaping.
 *
 * The roster an operator maintains per program ("23기 영숙", 역할, 별칭), and the shape the
 * worker hands to core/cast.py so it can normalize on-screen name captions onto real people.
 * Mirrors profile.ts: fixed schema, validated here, so storage + the pipeline can trust it.
 *
 * Identity here is caption-based, never biometric — nothing in this module (or its tables)
 * stores a face. See migrations/0003_cast-registry.cjs.
 */

import type { EpisodeCastRow } from "./db-pg.ts";

/** What core/cast.py's build_cast_timeline() emits per person (analysis.json → data.cast). */
export interface CastTimelinePerson {
  castId: string | null;
  name: string;
  role?: string;
  status?: string;
  matchType?: string;
  confidence?: number;
  sceneCount?: number;
  totalSec?: number;
  evidence?: string[];
  appearances?: Array<{ start: number; end: number; scenes: number[]; source: string }>;
}

export interface CastTimeline {
  registrySize?: number;
  matchedCount?: number;
  candidateCount?: number;
  people?: CastTimelinePerson[];
}

export interface CastMemberInput {
  name: string;
  aliases: string[];
  role: string;
  season: string;
  note: string;
  /** Display-only profile image URL (operator-entered) — never used for matching. */
  imageUrl?: string;
}

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v.trim() : v == null ? fallback : String(v).trim() || fallback;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => asString(x)).filter(Boolean))] : [];

/**
 * Validate a roster entry from the API. Returns null when there's no usable name — a
 * nameless cast member can't match anything, so it's a client error, not a defaulted row.
 */
export function normalizeCastInput(raw: unknown): CastMemberInput | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = asString(r.name);
  if (!name) return null;
  // Only https URLs are stored — anything else (http, data:, javascript:, plain text) degrades
  // to '' so the client never renders an untrusted scheme.
  const imageUrl = asString(r.imageUrl);
  return {
    name,
    // A name that also appears in aliases is noise — the matcher tries the canonical name first.
    aliases: asStringArray(r.aliases).filter((a) => a !== name),
    role: asString(r.role),
    season: asString(r.season),
    note: asString(r.note),
    imageUrl: imageUrl.startsWith("https://") ? imageUrl : "",
  };
}

/** Roster rows → the registry JSON core/cast.py reads (`--cast <file>`). */
export function toCoreRegistry(
  members: Array<{ castId: string; name: string; aliases: string[]; role: string; season: string }>,
): { cast: Array<{ castId: string; name: string; aliases: string[]; role: string; season: string }> } {
  return {
    cast: members.map((m) => ({
      castId: m.castId,
      name: m.name,
      aliases: Array.isArray(m.aliases) ? m.aliases : [],
      role: m.role ?? "",
      season: m.season ?? "",
    })),
  };
}

const STATUSES = new Set(["matched", "candidate", "confirmed", "rejected"]);

/**
 * core/cast.py's timeline → episode_cast rows.
 *
 * Confidence is clamped to [0,1) and status is whitelisted: the pipeline may report
 * 'matched'/'candidate' but must never write 'confirmed' — confirmation is an operator
 * action (see setEpisodeCastStatus). Anything unexpected degrades to 'candidate', which is
 * the safe direction: an unconfirmed person surfaces for review, a wrongly-confirmed one
 * silently becomes "fact".
 */
export function timelineToRows(cast: unknown): Array<Partial<EpisodeCastRow> & { name: string }> {
  const people = (cast as CastTimeline)?.people;
  if (!Array.isArray(people)) return [];
  const out: Array<Partial<EpisodeCastRow> & { name: string }> = [];
  for (const p of people) {
    const name = asString(p?.name);
    if (!name) continue;
    const reported = asString(p?.status, "candidate");
    const status = STATUSES.has(reported) && reported !== "confirmed" && reported !== "rejected"
      ? (reported as "matched" | "candidate")
      : "candidate";
    const conf = Number(p?.confidence);
    out.push({
      name,
      castId: asString(p?.castId) || null,
      status,
      matchType: asString(p?.matchType, "none"),
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(0.999, conf)) : 0,
      role: asString(p?.role),
      sceneCount: Number(p?.sceneCount) || 0,
      totalSec: Number(p?.totalSec) || 0,
      evidence: asStringArray(p?.evidence),
      appearances: Array.isArray(p?.appearances) ? (p.appearances as EpisodeCastRow["appearances"]) : [],
    });
  }
  return out;
}
