// Device API keys. A key is 32 random bytes (256 bits) with a recognisable prefix.
// Only its SHA-256 hash is stored. Because the key is long and random (not a guessable
// password), a fast hash is sufficient and lets the server find the installation with a
// single indexed lookup on every ingest request.
const crypto = require('crypto');

const DEVICE_KEY_PREFIX = 'slsea_dev_';

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

function generateDeviceKey() {
  const key = DEVICE_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key) };
}

module.exports = { DEVICE_KEY_PREFIX, hashKey, generateDeviceKey };
