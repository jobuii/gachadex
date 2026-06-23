import type { Db } from '../db/client.ts';

/**
 * A settings-backed scalar knob cached in memory for SYNCHRONOUS reads (callers read it on hot paths —
 * the engine reads fees + chat thresholds per trade). The config value is the default; an operator
 * override stored in `settings` overlays it. `validate` coerces + bounds the stored/written value, and a
 * stored value that somehow fails validation falls back to the default rather than poisoning the knob.
 * Shared by the fee knobs (bps, see fees.ts) and the chat action-bar thresholds (USD, see chat-config.ts).
 *
 * `serialize` controls how the value is stored (default String(), which round-trips scalars and the
 * comma-list arrays drop-config relies on). Pass JSON.stringify for structured values (e.g. the Pack Rip
 * tier/band table in game-config.ts) — the matching `validate` then JSON.parses the stored string.
 */
export function liveKnob<T>(settingKey: string, defaultValue: T, validate: (v: unknown) => T, serialize: (v: T) => string = String) {
  let current = defaultValue;
  const load = async (db: Db): Promise<T> => {
    const r = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = $1`, [settingKey]);
    try {
      current = r.rows[0] ? validate(r.rows[0].value) : defaultValue;
    } catch {
      current = defaultValue;
    }
    return current;
  };
  return {
    get: (): T => current,
    load,
    set: async (db: Db, value: unknown): Promise<T> => {
      const v = validate(value);
      await db.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [settingKey, serialize(v)],
      );
      return load(db);
    },
    default: defaultValue,
  };
}
