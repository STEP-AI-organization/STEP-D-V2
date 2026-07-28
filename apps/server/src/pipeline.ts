import crypto from "node:crypto";

export function newId(prefix: string): string {
  const rand = crypto.randomUUID().slice(0, 8);
  return `${prefix}_${rand}`;
}
