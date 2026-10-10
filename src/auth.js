// Authentication & role checks. Two kinds of principal, never interchangeable:
//   device : Bearer slsea_dev_...  -> resolves to exactly one installation (write path)
//   user   : Bearer <JWT>          -> resolves to a role + jurisdiction     (read path)
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');
const { DEVICE_KEY_PREFIX, hashKey } = require('./keys');
const { unauthenticated, forbidden } = require('./errors');
const { idParam } = require('./http');

const JWT_OPTIONS = { algorithms: ['HS256'], issuer: 'slsea-api' };

function signUserToken(user) {
  return jwt.sign(
    { role: user.role, province_id: user.province_id, district_id: user.district_id },
    config.jwtSecret,
    { algorithm: 'HS256', issuer: 'slsea-api', subject: String(user.id), expiresIn: config.jwtExpiresInSeconds }
  );
}

function bearerToken(req) {
  const header = req.get('Authorization');
  if (!header) throw unauthenticated('Missing Authorization header');
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw unauthenticated("Authorization header must be 'Bearer <token>'");
  return m[1];
}

// Resolves the caller to a principal. Throws 401 when the credential is absent or invalid.
async function authenticate(req) {
  if (req.principal) return req.principal;
  const token = bearerToken(req);

  if (token.startsWith(DEVICE_KEY_PREFIX)) {
    const { rows } = await db.query('SELECT id FROM solar_installation WHERE api_key_hash = $1', [hashKey(token)]);
    if (rows.length === 0) throw unauthenticated('Invalid device API key');
    req.principal = { type: 'device', installationId: rows[0].id };
    return req.principal;
  }

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, JWT_OPTIONS);
  } catch {
    throw unauthenticated('Invalid or expired token');
  }
  req.principal = {
    type: 'user',
    id: Number(claims.sub),
    role: claims.role,
    province_id: claims.province_id ?? null,
    district_id: claims.district_id ?? null,
  };
  return req.principal;
}

// Read path: only SLSEA users. Device credentials are authenticated but not authorised.
async function requireUser(req, res, next) {
  try {
    const p = await authenticate(req);
    if (p.type !== 'user') throw forbidden('Device credentials cannot access this resource');
    req.user = p;
    next();
  } catch (err) {
    next(err);
  }
}

// Write path: only a device, and only for its own installation (:id in the URL).
async function requireDevice(req, res, next) {
  try {
    const p = await authenticate(req);
    if (p.type !== 'device') throw forbidden('Only metering devices may write generation readings');
    if (p.installationId !== idParam(req, 'id')) {
      throw forbidden('This device key belongs to a different installation');
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Must run after requireUser.
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(forbidden(`This action requires the ${roles.join(' or ')} role`));
  }
  return next();
};

module.exports = { signUserToken, authenticate, requireUser, requireDevice, requireRole };
