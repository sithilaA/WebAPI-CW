// One error contract for the whole API:
//   { "error": { "status": 404, "code": "RESOURCE_NOT_FOUND", "message": "...", "details": [ ... ] } }
class ApiError extends Error {
  constructor(status, code, message, details = [], headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

const badRequest = (message, details = []) => new ApiError(400, 'BAD_REQUEST', message, details);
const validationError = (details) =>
  new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', details);
const unauthenticated = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHENTICATED', message, [], { 'WWW-Authenticate': 'Bearer' });
const forbidden = (message = 'You do not have permission to perform this action') =>
  new ApiError(403, 'FORBIDDEN', message);
const notFound = (message = 'Resource not found') =>
  new ApiError(404, 'RESOURCE_NOT_FOUND', message);
const methodNotAllowed = (allowed) =>
  new ApiError(405, 'METHOD_NOT_ALLOWED', `Method not allowed. Allowed: ${allowed.join(', ')}`, [], {
    Allow: allowed.join(', '),
  });
const notAcceptable = () =>
  new ApiError(406, 'NOT_ACCEPTABLE', 'This API only produces application/json');
const conflict = (code, message, details = []) => new ApiError(409, code, message, details);
const preconditionFailed = (message) => new ApiError(412, 'PRECONDITION_FAILED', message);
const unsupportedMediaType = () =>
  new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must be application/json');
const tooManyRequests = (message) => new ApiError(429, 'RATE_LIMITED', message);

// Translate library / database errors into ApiErrors.
function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err.type === 'entity.parse.failed') {
    return new ApiError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  if (err.code === '23505') {
    return conflict('CONFLICT', 'A resource with the same unique value already exists', [
      { field: err.constraint || null, issue: 'duplicate value' },
    ]);
  }
  // 23503 foreign_key_violation, 23001 restrict_violation (ON DELETE RESTRICT with children)
  if (err.code === '23503' || err.code === '23001') {
    return conflict('CONFLICT', 'The operation conflicts with related resources', [
      { issue: err.detail || 'related resources exist or are missing' },
    ]);
  }
  return null;
}

function send(res, e) {
  res
    .status(e.status)
    .set(e.headers)
    .type('application/json')
    .send(
      JSON.stringify({
        error: { status: e.status, code: e.code, message: e.message, details: e.details },
      })
    );
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const apiError = toApiError(err);
  if (apiError) return send(res, apiError);
  console.error(err);
  return send(res, new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred'));
}

function notFoundHandler(req, res, next) {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

module.exports = {
  ApiError,
  badRequest,
  validationError,
  unauthenticated,
  forbidden,
  notFound,
  methodNotAllowed,
  notAcceptable,
  conflict,
  preconditionFailed,
  unsupportedMediaType,
  tooManyRequests,
  errorHandler,
  notFoundHandler,
};
