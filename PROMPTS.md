# Prompt templates for generating this API

Five staged prompts for building the SLSEA Real-Time Solar Generation Data API with an AI
code assistant (Node.js 22, Express 4, PostgreSQL). They are ordered so that each stage builds
on the previous one.

> **Note on disclosure.** This file is a set of *suggested prompt templates*. It is **not** the
> log of prompts actually used while building this project. The actual prompt log, with what the
> AI produced and what was checked or changed, is kept in [`AI_LOG.md`](AI_LOG.md) and is the
> source for Appendix A (AI Disclosure) of the report.

---

## Prompt 1: Data model and seed data

```text
I'm building a REST API for a university coursework: a Real-Time Solar Generation Data API
for Sri Lanka's sustainable energy authority. Stack: Node.js 22, Express 4, PostgreSQL.

Design the data model first. Entities: Province -> District -> GridSubstation ->
SolarInstallation -> GenerationReading, plus a User with a role (national / provincial /
district) and a jurisdiction.

Rules:
- The meter/inverter ID is a column on SolarInstallation. Do NOT create a Device table.
- GenerationReading is its own append-only time-series table (installation_id, timestamp,
  power_kw, energy_kwh cumulative, voltage). Do NOT store last_power on the installation.
- Add a unique constraint on (installation_id, timestamp), foreign keys, CHECK constraints,
  and sensible indexes. Explain each index.

Write schema.sql, then a seed script that generates 9 provinces, 25 real Sri Lankan districts,
20+ substations, 200+ installations and 7 days of 15-minute readings per installation with a
realistic daylight curve (zero at night, Asia/Colombo time). Seed one user per jurisdiction.
Use a seeded random generator so runs are repeatable. Explain your design choices briefly.
```

## Prompt 2: Authentication and jurisdiction scoping

```text
Add security to the Express API. There are two kinds of client:
1. Metering devices (write clients): each installation has its own random API key. Store
   only the SHA-256 hash. A device may POST readings for its OWN installation only.
2. SLSEA users (read clients): log in with email and password (bcrypt), receive a JWT
   (HS256, 1 hour) carrying role and jurisdiction. They read data but never write readings.

Requirements:
- Separate middleware for device and user. A device key on a read route, or a user token on
  the ingest route (even a national user), must return 403. Missing/invalid credentials: 401
  with WWW-Authenticate.
- Jurisdiction scope: national sees all, provincial sees own province, district sees own
  district. For lists, apply the scope inside the SQL WHERE clause. For single resources,
  return 404 if missing and 403 if out of scope. A filter pointing at another jurisdiction
  must return 403, not be silently ignored.
- Login must not reveal whether an email exists, and should be rate limited.
- Use parameterised SQL only. Explain why SHA-256 is fine for the device key but bcrypt is
  used for passwords.
```

## Prompt 3: Read path with pagination, filtering, sorting and caching

```text
Implement the read endpoints following REST design guidelines (resource taxonomy, plural
nouns, scoped collections nested under their parent where they only make sense there):
- /provinces, /provinces/{id}/districts, /districts/{id}/substations,
  /substations/{id}/installations, /installations and /installations/{id}
- /installations/{id}/overview (composite: installation + hierarchy + latest reading +
  today's energy)
- /installations/{id}/readings (history), /installations/{id}/readings/latest (derived)
- /readings (cross-installation analytics) and /districts/{id}/generation-summary

Collections must support ?page&limit and return {data, pagination{total,...}, links{self,
first, prev, next, last}} plus a Link header; sort via a whitelist (prefix - for
descending); filters for province/district/substation and from/to time window.
Implement conditional GET: send ETag (and Last-Modified on single resources) and return 304
with an empty body for If-None-Match / If-Modified-Since. Validate query parameters and
return 400 with details. Show how each endpoint applies the jurisdiction scope.
```

## Prompt 4: Write path, status codes and one error contract

```text
Implement the write side.
- POST /installations/{id}/readings (device only): validate body (timestamp, power_kw,
  energy_kwh, voltage), reject timestamps more than 5 minutes in the future, return
  201 Created with a Location header pointing to the new reading, plus ETag. A duplicate
  (installation, timestamp) must return 409 DUPLICATE_READING so device retries are safe.
  Readings are append-only: PUT/PATCH/DELETE return 405 with an Allow header.
- Admin writes, national role only: create under the parent (POST /substations/{id}/
  installations), PUT (idempotent replace), PATCH, DELETE (204, then 404). Support If-Match
  returning 412. Deleting a parent that still has children returns 409; deleting an
  installation cascades to its readings. The device API key is returned once on creation.

Use ONE error body everywhere: {error:{status, code, message, details:[{field, issue}]}},
including 404 for unknown routes, malformed JSON (400), wrong content type (415), wrong
Accept (406) and rate limiting (429). Use a central error handler, and explain which
status code you chose for each case and why.
```

## Prompt 5: OpenAPI docs, tests and deployment

```text
1. Write an OpenAPI 3 document covering every endpoint: both security schemes (device key
   and user JWT), reusable parameters, the shared error schema and example responses. Serve
   it with Swagger UI at /docs and as /openapi.json.
2. Write end-to-end tests with node:test against an in-memory database seeded with a small
   dataset. Cover: both auth types, the write/read split, jurisdiction scoping (list and
   single), pagination, sorting, time-window filter, ETag/304, 201+Location, 409, 405,
   412, 406, 415 and the error shape.
3. Prepare production deployment on an Ubuntu VPS: a pm2 ecosystem file (single instance,
   bound to 127.0.0.1), an nginx reverse-proxy server block with the right proxy headers
   for correct https links, and Certbot HTTPS steps behind Cloudflare. Secrets come from
   a .env file, and the app must refuse to start in production without JWT_SECRET.
Explain anything I should be able to defend in a viva.
```
