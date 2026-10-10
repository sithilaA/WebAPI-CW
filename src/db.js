// Database access. One interface, two engines:
//  - DATABASE_URL set   -> node-postgres pool against a real PostgreSQL server (production)
//  - DATABASE_URL empty -> PGlite, an embedded PostgreSQL, so the project runs with no install
// Both speak the same SQL dialect ($1, $2 placeholders), so no query is engine-specific.
const config = require('./config');

let enginePromise = null;

async function createEngine() {
  if (config.databaseUrl) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => Number(v)); // int8 (COUNT, BIGSERIAL) -> number
    types.setTypeParser(1700, (v) => parseFloat(v)); // numeric -> number
    const pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
      max: config.dbPoolMax,
    });
    return {
      kind: 'postgres',
      query: async (text, params = []) => {
        const r = await pool.query(text, params);
        return { rows: r.rows, rowCount: r.rowCount };
      },
      exec: (sql) => pool.query(sql),
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  if (!config.pgliteDir.includes('://')) {
    require('fs').mkdirSync(require('path').dirname(config.pgliteDir), { recursive: true });
  }
  const db = new PGlite(config.pgliteDir, {
    parsers: { 20: (v) => Number(v), 1700: (v) => parseFloat(v) },
  });
  await db.waitReady;
  return {
    kind: 'pglite',
    query: async (text, params = []) => {
      const r = await db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

function engine() {
  if (!enginePromise) enginePromise = createEngine();
  return enginePromise;
}

module.exports = {
  query: async (text, params) => (await engine()).query(text, params),
  exec: async (sql) => (await engine()).exec(sql),
  close: async () => (await engine()).close(),
  kind: async () => (await engine()).kind,
};
