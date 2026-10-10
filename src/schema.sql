-- SLSEA Solar Generation API - relational schema (PostgreSQL)
-- Hierarchy: province -> district -> grid_substation -> solar_installation -> generation_reading
-- The meter/inverter identity is an ATTRIBUTE of solar_installation (meter_id + api_key_hash),
-- not a separate Device table. Readings are an append-only time series in their own table.

CREATE TABLE IF NOT EXISTS province (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  code       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS district (
  id          SERIAL PRIMARY KEY,
  province_id INTEGER NOT NULL REFERENCES province(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (province_id, name)
);
CREATE INDEX IF NOT EXISTS idx_district_province ON district (province_id);

CREATE TABLE IF NOT EXISTS grid_substation (
  id           SERIAL PRIMARY KEY,
  district_id  INTEGER NOT NULL REFERENCES district(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  capacity_mva DOUBLE PRECISION NOT NULL CHECK (capacity_mva > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (district_id, name)
);
CREATE INDEX IF NOT EXISTS idx_substation_district ON grid_substation (district_id);

CREATE TABLE IF NOT EXISTS solar_installation (
  id            SERIAL PRIMARY KEY,
  substation_id INTEGER NOT NULL REFERENCES grid_substation(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  owner_name    TEXT NOT NULL,
  meter_id      TEXT NOT NULL UNIQUE,            -- smart meter / inverter identifier
  capacity_kw   DOUBLE PRECISION NOT NULL CHECK (capacity_kw > 0),
  installed_on  DATE NOT NULL,
  api_key_hash  CHAR(64) NOT NULL UNIQUE,        -- SHA-256 of the device API key; plaintext is never stored
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_installation_substation ON solar_installation (substation_id);

-- Append-only time series. UNIQUE (installation_id, ts) both rejects duplicate/retried
-- readings and serves as the index for per-installation history queries.
CREATE TABLE IF NOT EXISTS generation_reading (
  id              BIGSERIAL PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES solar_installation(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL,           -- when the device measured it
  power_kw        DOUBLE PRECISION NOT NULL CHECK (power_kw >= 0),
  energy_kwh      DOUBLE PRECISION NOT NULL CHECK (energy_kwh >= 0),  -- cumulative meter value
  voltage         DOUBLE PRECISION NOT NULL CHECK (voltage > 0),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),                  -- when the API stored it
  UNIQUE (installation_id, ts)
);
-- Supports cross-installation time-window queries (GET /readings?from=&to=).
CREATE INDEX IF NOT EXISTS idx_reading_ts ON generation_reading (ts);

CREATE TABLE IF NOT EXISTS app_user (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('national', 'provincial', 'district')),
  province_id   INTEGER REFERENCES province(id) ON DELETE RESTRICT,
  district_id   INTEGER REFERENCES district(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (role = 'national'   AND province_id IS NULL     AND district_id IS NULL) OR
    (role = 'provincial' AND province_id IS NOT NULL AND district_id IS NULL) OR
    (role = 'district'   AND province_id IS NOT NULL AND district_id IS NOT NULL)
  )
);
