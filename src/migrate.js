// Applies schema.sql (idempotent: every statement uses IF NOT EXISTS).
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(sql);
}

module.exports = { ensureSchema };

if (require.main === module) {
  ensureSchema()
    .then(() => console.log('Schema is up to date.'))
    .then(() => db.close())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
