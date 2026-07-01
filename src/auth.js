// Token gates. Writes (register/update/delete/force-refresh) always require the
// write token when one is configured. Reads are open unless SLUICE_READ_TOKEN is
// set. Tokens are accepted via `x-sluice-token` header or `?token=` query.
import { WRITE_TOKEN, READ_TOKEN } from './config.js';

function presented(req) {
  return req.get('x-sluice-token') || req.query.token || '';
}

export function requireWrite(req, res, next) {
  if (!WRITE_TOKEN) {
    return res
      .status(503)
      .json({ error: 'writes are disabled: SLUICE_TOKEN is not configured on the server' });
  }
  if (presented(req) !== WRITE_TOKEN) {
    return res.status(401).json({ error: 'invalid or missing write token (x-sluice-token)' });
  }
  next();
}

export function requireRead(req, res, next) {
  if (!READ_TOKEN) return next(); // reads open by default
  if (presented(req) !== READ_TOKEN) {
    return res.status(401).json({ error: 'invalid or missing read token (x-sluice-token)' });
  }
  next();
}
