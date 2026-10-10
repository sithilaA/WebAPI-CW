# SLSEA Real-Time Solar Generation Data API

NB6007CEM Web API Development coursework. REST API (Node.js / Express / PostgreSQL) that ingests
generation readings from rooftop-solar metering devices and serves them to SLSEA users, scoped by
jurisdiction. Live OpenAPI (Swagger) UI is served at `/docs`.

## Run locally

Requires Node 20.12+. No database install needed: without `DATABASE_URL` the API uses PGlite
(an embedded PostgreSQL stored in `.data/`).

```bash
npm install
npm run seed      # 9 provinces, 25 districts, 31 substations, 240 installations, 161,280 readings
npm start         # http://localhost:3000  (Swagger UI: /docs)
npm test          # 27 end-to-end tests against an in-memory database
```

`npm run seed` writes credentials to `seed-output/` (gitignored):
`users.json` (every seeded user shares one password) and `device-keys.json` (one API key per installation).
Seeded users: `national@slsea.test`, `province.<name>@slsea.test`, `district.<name>@slsea.test`.

Simulate live devices pushing readings:

```bash
npm run simulate -- --base http://localhost:3000 --count 5 --interval 10
```

## Configuration

See `.env.example`. In production set `NODE_ENV=production`, `DATABASE_URL`, `DB_SSL=true` (if the
provider requires it) and a long random `JWT_SECRET`. To seed a hosted database:
`DATABASE_URL=... npm run seed -- --yes` (this drops and recreates all tables).

## Design at a glance

| Concern | Decision |
|---|---|
| Domain | Province → District → GridSubstation → SolarInstallation → GenerationReading, plus User. Meter identity is an attribute of the installation (no Device entity). |
| History | `generation_reading` is an append-only time series (UNIQUE `(installation_id, ts)`), not last-value fields. |
| Device auth | Per-installation API key (`slsea_dev_...`); only its SHA-256 hash is stored; valid for that installation only. |
| User auth | Email + password (bcrypt) → HS256 JWT carrying role and jurisdiction. |
| Authorization | national = all; provincial = own province; district = own district. Lists are filtered in SQL; single resources are 404 if missing, 403 if out of scope. Only devices write readings; only `national` users manage the hierarchy. |
| Errors | One body everywhere: `{ "error": { "status", "code", "message", "details": [] } }`. |
| Collections | `page` / `limit`, `pagination.total`, `links` (+ `Link` header), whitelisted `sort`, `from` / `to` window, `province` / `district` / `substation` filters. |
| Caching | `ETag` on every GET, `Last-Modified` on atomic resources, `304` with empty body. `If-Match` → `412` on writes. |
| Maturity | Richardson Level 2. |

## Endpoint summary

See `/docs` for the full contract (32 operations). Key resources:

- Device (write): `POST /installations/{id}/readings` → `201` + `Location`
- Hierarchy: `/provinces`, `/provinces/{id}/districts`, `/districts/{id}/substations`, `/substations/{id}/installations`, `/installations`
- Composite: `/installations/{id}/overview`
- Operational: `/installations/{id}/readings/latest`, `/districts/{id}/generation-summary`
- Analytical: `/installations/{id}/readings`, `/readings`

## Project layout

```
src/app.js          app wiring, content negotiation (406/415), docs
src/auth.js         device / user authentication, role checks
src/scope.js        jurisdiction scoping (SQL conditions + 403 checks)
src/http.js         pagination, sorting, conditional GET, body validation
src/errors.js       the single error contract
src/routes/         auth, hierarchy, installations, readings, summary
src/schema.sql      PostgreSQL schema
src/seed.js         seed generator
openapi.yaml        OpenAPI 3 contract served at /docs
test/api.test.js    end-to-end tests
```
