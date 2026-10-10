const router = require('express').Router();
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { ah, validateBody } = require('../http');
const { signUserToken, requireUser } = require('../auth');
const { unauthenticated } = require('../errors');
const { rateLimit } = require('../rateLimit');

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.loginLimitPerMin,
  keyFn: (req) => req.ip,
  message: 'Too many login attempts. Try again later.',
});

const LOGIN_SCHEMA = {
  email: { type: 'email', required: true },
  password: { type: 'string', required: true, min: 1, max: 200 },
};

const userRep = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  province_id: u.province_id,
  district_id: u.district_id,
});

// POST /auth/login - the only unauthenticated API route (besides health and docs).
router.post(
  '/auth/login',
  loginLimiter,
  ah(async (req, res) => {
    const { email, password } = validateBody(req.body, LOGIN_SCHEMA);
    const { rows } = await db.query(
      'SELECT id, name, email, role, province_id, district_id, password_hash FROM app_user WHERE lower(email) = lower($1)',
      [email]
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) throw unauthenticated('Invalid email or password');

    res.set('Cache-Control', 'no-store').status(200).json({
      access_token: signUserToken(user),
      token_type: 'Bearer',
      expires_in: config.jwtExpiresInSeconds,
      user: userRep(user),
    });
  })
);

// GET /auth/me - who am I, according to my token.
router.get(
  '/auth/me',
  requireUser,
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT id, name, email, role, province_id, district_id FROM app_user WHERE id = $1',
      [req.user.id]
    );
    if (rows.length === 0) throw unauthenticated('The user for this token no longer exists');
    res.set('Cache-Control', 'no-store').status(200).json(userRep(rows[0]));
  })
);

module.exports = router;
