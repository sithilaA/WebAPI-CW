// pm2 process definition:  pm2 start ecosystem.config.js
// Secrets (DATABASE_URL, JWT_SECRET) are read from the .env file in this directory.
module.exports = {
  apps: [
    {
      name: 'slsea-api',
      script: 'src/server.js',
      cwd: __dirname,
      // One instance on purpose: the rate limiter keeps its counters in process memory.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3100,
      },
    },
  ],
};
