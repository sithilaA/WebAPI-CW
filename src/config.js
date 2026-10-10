// Central configuration. Values come from the environment (optionally a local .env file).
try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on real environment variables
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production');
}

module.exports = {
  isProd,
  port: Number(env.PORT) || 3000,
  // In production behind nginx set HOST=127.0.0.1 so the API is reachable only through the proxy.
  host: env.HOST || '',
  databaseUrl: env.DATABASE_URL || '',
  dbSsl: env.DB_SSL === 'true',
  dbPoolMax: Number(env.DB_POOL_MAX) || 10,
  pgliteDir: env.PGLITE_DIR || '.data/pglite',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-do-not-use-in-production',
  jwtExpiresInSeconds: Number(env.JWT_EXPIRES_IN_SECONDS) || 3600,
  ingestLimitPerMin: Number(env.INGEST_RATE_LIMIT_PER_MIN) || 60,
  loginLimitPerMin: Number(env.LOGIN_RATE_LIMIT_PER_MIN) || 10,
};
