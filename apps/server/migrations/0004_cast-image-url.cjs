/* eslint-disable camelcase */

/**
 * cast-image-url — display-only profile image URL on the program_cast roster.
 *
 * Operator-entered https URL shown next to a roster entry in the cast manager UI.
 * Identity matching stays caption-based (core/cast.py) — this column is never read by
 * the pipeline, so no biometric concern is introduced (see 0003_cast-registry.cjs).
 *
 * NON-DESTRUCTIVE: purely additive (ADD COLUMN IF NOT EXISTS). Existing rows get ''.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE program_cast ADD COLUMN IF NOT EXISTS imageUrl TEXT NOT NULL DEFAULT '';`);
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE program_cast DROP COLUMN IF EXISTS imageUrl;`);
};
