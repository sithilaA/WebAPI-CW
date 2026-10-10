// Shared HTTP helpers: async wrapper, input parsing, pagination, sorting,
// conditional GET (ETag / Last-Modified) and request-body validation.
const crypto = require('crypto');
const { badRequest, validationError, preconditionFailed } = require('./errors');

// Express 4 does not catch rejected promises, so every async handler is wrapped.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const absoluteUrl = (req, path) => `${req.protocol}://${req.get('host')}${path}`;

// ---------- path / query parsing ----------

function idParam(req, name = 'id') {
  const raw = req.params[name];
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) {
    throw badRequest(`Path parameter '${name}' must be a positive integer`, [
      { field: name, issue: 'must be a positive integer' },
    ]);
  }
  return Number(raw);
}

// Reads an optional positive-integer query parameter, collecting problems in `details`.
function intQuery(query, name, details, { def, min = 1, max = 2147483647 } = {}) {
  const raw = query[name];
  if (raw === undefined || raw === '') return def;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    details.push({ field: name, issue: `must be an integer between ${min} and ${max}` });
    return def;
  }
  return Number(raw);
}

function parsePagination(query) {
  const details = [];
  const page = intQuery(query, 'page', details, { def: 1, min: 1, max: 1000000 });
  const limit = intQuery(query, 'limit', details, { def: 50, min: 1, max: 500 });
  if (details.length) throw badRequest('Invalid pagination parameters', details);
  return { page, limit, offset: (page - 1) * limit };
}

// `allowed` maps public sort field -> SQL column (a whitelist, so user input never reaches SQL).
function parseSort(query, allowed, defaultSort) {
  const raw = query.sort === undefined ? defaultSort : query.sort;
  const desc = typeof raw === 'string' && raw.startsWith('-');
  const field = typeof raw === 'string' ? raw.replace(/^-/, '') : '';
  if (!Object.prototype.hasOwnProperty.call(allowed, field)) {
    throw badRequest('Invalid sort parameter', [
      { field: 'sort', issue: `must be one of: ${Object.keys(allowed).join(', ')} (prefix with - for descending)` },
    ]);
  }
  return { field, desc, sql: `${allowed[field]} ${desc ? 'DESC' : 'ASC'}` };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseIsoInstant(value) {
  if (typeof value !== 'string' || !(DATE_ONLY.test(value) || DATE_TIME_TZ.test(value))) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ?from=...&to=... (both inclusive). A '+' in an offset must be URL-encoded as %2B.
function parseWindow(query) {
  const details = [];
  const hint = 'must be an ISO 8601 date or date-time with Z or an offset (URL-encode + as %2B)';
  let from = null;
  let to = null;
  if (query.from !== undefined) {
    from = parseIsoInstant(query.from);
    if (!from) details.push({ field: 'from', issue: hint });
  }
  if (query.to !== undefined) {
    to = parseIsoInstant(query.to);
    if (!to) details.push({ field: 'to', issue: hint });
  }
  if (from && to && from > to) details.push({ field: 'from', issue: "must not be later than 'to'" });
  if (details.length) throw badRequest('Invalid time window', details);
  return { from, to };
}

// ---------- pagination envelope ----------

function paginate(req, { rows, total, page, limit }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const pageUrl = (p) => {
    const u = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`);
    u.searchParams.set('page', String(p));
    u.searchParams.set('limit', String(limit));
    return u.toString();
  };
  return {
    data: rows,
    pagination: { page, limit, total, total_pages: totalPages },
    links: {
      self: pageUrl(page),
      first: pageUrl(1),
      prev: page > 1 ? pageUrl(Math.min(page - 1, totalPages)) : null,
      next: page < totalPages ? pageUrl(page + 1) : null,
      last: pageUrl(totalPages),
    },
  };
}

// ---------- conditional GET ----------

const etagOf = (json) => `"${crypto.createHash('sha1').update(json).digest('base64url')}"`;

function matchesEtag(header, etag) {
  if (header.trim() === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}

// Sends 200 with validators, or 304 with an empty body when the client already holds
// the current version. If-None-Match takes precedence over If-Modified-Since (RFC 7232).
function sendRepresentation(req, res, body, lastModified) {
  const json = JSON.stringify(body);
  const etag = etagOf(json);
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  res.vary('Authorization');
  if (res.getHeader('Link') === undefined && body && body.links) {
    const parts = Object.entries(body.links)
      .filter(([rel, url]) => url && ['first', 'prev', 'next', 'last'].includes(rel))
      .map(([rel, url]) => `<${url}>; rel="${rel}"`);
    if (parts.length) res.set('Link', parts.join(', '));
  }
  const lm = lastModified ? new Date(lastModified) : null;
  if (lm) res.set('Last-Modified', lm.toUTCString());

  const inm = req.get('If-None-Match');
  const ims = req.get('If-Modified-Since');
  let fresh = false;
  if (inm) {
    fresh = matchesEtag(inm, etag);
  } else if (lm && ims) {
    const since = Date.parse(ims);
    fresh = !Number.isNaN(since) && Math.floor(lm.getTime() / 1000) * 1000 <= since;
  }
  if (fresh) return res.status(304).end();
  return res.status(200).type('application/json').send(json);
}

// 201 Created: Location says where the new resource lives; ETag / Last-Modified let the
// client revalidate it later with a conditional GET.
function sendCreated(req, res, path, body, lastModified) {
  const json = JSON.stringify(body);
  res.set('Location', absoluteUrl(req, path));
  res.set('ETag', etagOf(json));
  if (lastModified) res.set('Last-Modified', new Date(lastModified).toUTCString());
  return res.status(201).type('application/json').send(json);
}

// Optimistic concurrency for writes: If-Match must equal the current ETag, else 412.
function assertIfMatch(req, currentRepresentation) {
  const header = req.get('If-Match');
  if (!header) return;
  if (!matchesEtag(header, etagOf(JSON.stringify(currentRepresentation)))) {
    throw preconditionFailed('The resource has changed since you last retrieved it (If-Match did not match)');
  }
}

// ---------- request body validation ----------

function checkRule(value, rule) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return 'must be a string';
      const len = value.trim().length;
      if (len < (rule.min ?? 1)) return `must be at least ${rule.min ?? 1} character(s)`;
      if (len > (rule.max ?? 200)) return `must be at most ${rule.max ?? 200} characters`;
      return null;
    }
    case 'email':
      return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
        ? null
        : 'must be a valid email address';
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (rule.type === 'integer' && !Number.isInteger(value)) return 'must be an integer';
      if (rule.min !== undefined && value < rule.min) return `must be >= ${rule.min}`;
      if (rule.max !== undefined && value > rule.max) return `must be <= ${rule.max}`;
      return null;
    }
    case 'date':
      return typeof value === 'string' && DATE_ONLY.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : 'must be a date in YYYY-MM-DD format';
    case 'timestamp':
      return parseIsoInstant(value) && typeof value === 'string' && value.includes('T')
        ? null
        : 'must be an ISO 8601 date-time with Z or an offset, e.g. 2026-10-06T10:15:00Z';
    default:
      return null;
  }
}

// Validates a JSON body against a schema ({ field: { type, required, min, max } }).
// Unknown fields are rejected. With `partial`, absent fields are allowed (PATCH).
function validateBody(body, schema, { partial = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const details = [];
  const out = {};
  for (const key of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) details.push({ field: key, issue: 'unknown field' });
  }
  for (const [key, rule] of Object.entries(schema)) {
    const value = body[key];
    if (value === undefined) {
      if (rule.required && !partial) details.push({ field: key, issue: 'is required' });
      continue;
    }
    const issue = checkRule(value, rule);
    if (issue) details.push({ field: key, issue });
    else out[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (details.length) throw validationError(details);
  return out;
}

module.exports = {
  ah,
  absoluteUrl,
  idParam,
  intQuery,
  parsePagination,
  parseSort,
  parseWindow,
  paginate,
  etagOf,
  sendRepresentation,
  sendCreated,
  assertIfMatch,
  validateBody,
};
