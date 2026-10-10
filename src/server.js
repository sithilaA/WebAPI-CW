const config = require('./config');
const db = require('./db');
const { ensureSchema } = require('./migrate');
const { createApp } = require('./app');

async function main() {
  await ensureSchema();
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM province');
  if (rows[0].n === 0) {
    console.warn('The database is empty. Run "npm run seed" to load the seed data.');
  }

  const listenArgs = config.host ? [config.port, config.host] : [config.port];
  const server = createApp().listen(...listenArgs, () => {
    console.log(`SLSEA Solar API listening on ${config.host || 'all interfaces'}:${config.port} (docs at /docs)`);
  });

  const shutdown = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
