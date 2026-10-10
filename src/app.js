const fs = require('fs');
const path = require('path');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yaml');
const db = require('./db');
const {
  ApiError, notAcceptable, unsupportedMediaType, errorHandler, notFoundHandler,
} = require('./errors');

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// 406: the API only produces JSON, so refuse clients that explicitly exclude it.
function negotiateJson(req, res, next) {
  if (!req.accepts('application/json')) return next(notAcceptable());
  return next();
}

// 415: request bodies, when present, must be JSON.
function requireJsonBody(req, res, next) {
  if (BODY_METHODS.has(req.method)) {
    const hasBody = Number(req.get('Content-Length') || 0) > 0 || req.get('Transfer-Encoding');
    if (hasBody && !req.is('application/json')) return next(unsupportedMediaType());
  }
  return next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // validators are produced explicitly in http.js
  app.set('trust proxy', 1); // behind the host's HTTPS proxy: correct protocol/host in links

  // ---- documentation & operational endpoints (not content-negotiated)
  const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
  app.get('/openapi.json', (req, res) => res.json(spec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'SLSEA Solar Generation API' }));

  app.get('/', (req, res) => {
    res.json({
      name: 'SLSEA Real-Time Solar Generation Data API',
      version: spec.info.version,
      documentation: '/docs',
      openapi: '/openapi.json',
      health: '/health',
    });
  });

  app.get('/health', async (req, res, next) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', database: await db.kind(), time: new Date().toISOString() });
    } catch (err) {
      console.error(err);
      next(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The database is not reachable'));
    }
  });

  // ---- API
  app.use(negotiateJson);
  app.use(requireJsonBody);
  app.use(express.json({ limit: '100kb' }));

  app.use(require('./routes/auth'));
  app.use(require('./routes/hierarchy'));
  app.use(require('./routes/installations'));
  app.use(require('./routes/readings'));
  app.use(require('./routes/summary'));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
