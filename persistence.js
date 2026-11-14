// @ts-check
/**
 * Optional Postgres persistence for the betting engine.
 *
 * The engine stays in-memory; this module stores a JSON snapshot of the whole engine state
 * in a single row so that restarts and deploys don't wipe users, balances and markets.
 * Enabled only when DATABASE_URL is set; otherwise every function is a no-op.
 *
 * Deploy hand-over: each process claims ownership of the row on startup. A process that is
 * no longer the owner (the old instance during a zero-downtime deploy) stops writing, so it
 * can never overwrite state the new instance has already taken over.
 */

const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");

const DATABASE_URL = process.env.DATABASE_URL;
const instanceId = randomUUID();

/** @type {Pool | null} */
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Hosted Postgres (Neon) requires TLS with a verified certificate;
      // a local URL can opt out with ?sslmode=disable.
      ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: true },
      max: 2,
    })
  : null;

// Neon suspends idle databases and closes idle connections. Without a listener, that
// "error" event would crash the process; the pool simply reconnects on the next query.
pool?.on("error", (err) => console.warn("[persist] idle database connection closed:", err.message));

let owner = false;

const enabled = () => pool !== null;

/**
 * Create the table if needed, take ownership, and return the stored snapshot (or null).
 * @returns {Promise<unknown | null>}
 */
async function claimAndLoad() {
  if (!pool) return null;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engine_state (
      id         integer PRIMARY KEY,
      owner      text NOT NULL,
      data       jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  const { rows } = await pool.query(
    `INSERT INTO engine_state (id, owner) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner
     RETURNING data`,
    [instanceId],
  );
  owner = true;
  return rows[0]?.data ?? null;
}

/**
 * Write a snapshot if this process still owns the row.
 * @param {unknown} snapshot
 * @returns {Promise<boolean>} false if a newer instance has taken over.
 */
async function save(snapshot) {
  if (!pool || !owner) return false;
  const res = await pool.query(
    `UPDATE engine_state SET data = $2, updated_at = now() WHERE id = 1 AND owner = $1`,
    [instanceId, JSON.stringify(snapshot)],
  );
  if (res.rowCount === 0) {
    owner = false;
    console.warn("[persist] a newer instance took over; this instance stops saving");
    return false;
  }
  return true;
}

async function close() {
  await pool?.end();
}

module.exports = { enabled, claimAndLoad, save, close };
