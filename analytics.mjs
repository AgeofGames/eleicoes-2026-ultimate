import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SESSION_AGE = 12 * 60 * 60;
const VISITOR_AGE = 365 * 24 * 60 * 60;
const TIMEZONE = 'America/Sao_Paulo';
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayAt = time => dayFormatter.format(new Date(time));
const shiftDay = (day, amount) => new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
const digest = value => createHash('sha256').update(value).digest('hex');
const isBot = value => !value || /bot\b|crawler|spider|slurp|facebookexternalhit|facebookcatalog|whatsapp|telegrambot|preview|curl\/|wget\//i.test(value);
const jsonType = 'application/json; charset=utf-8';

function cookies(req) {
  const result = new Map();
  for (const item of (req.headers.cookie || '').split(';')) {
    const match = /^\s*([^=\s]+)=([^;]*)$/.exec(item);
    if (match && !result.has(match[1])) result.set(match[1], match[2]);
  }
  return result;
}

function limiter(maxKeys = 10_000) {
  const entries = new Map();
  return {
    take(key, limit, windowMs, time) {
      let item = entries.get(key);
      if (!item || item.until <= time) {
        if (entries.size >= maxKeys) {
          for (const [oldKey, old] of entries) if (old.until <= time) entries.delete(oldKey);
          if (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
        }
        item = { count: 0, until: time + windowMs };
        entries.set(key, item);
      }
      if (item.count >= limit) return Math.max(1, Math.ceil((item.until - time) / 1000));
      item.count++;
      return 0;
    },
    clear(key) { entries.delete(key); },
  };
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Envie dados em JSON.'), { status: 415, code: 'unsupported_media_type' });
  if (Number(req.headers['content-length']) > 4096) throw Object.assign(new Error('Requisição muito grande.'), { status: 413, code: 'body_too_large' });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error('Requisição muito grande.'), { status: 413, code: 'body_too_large' });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Dados inválidos.'), { status: 400, code: 'invalid_json' }); }
}

export function createAnalytics({ env, now, origin, publicDir, root }) {
  const secure = origin.startsWith('https:');
  const sessionName = secure ? '__Host-election_admin' : 'election_admin';
  const visitorName = secure ? '__Host-election_visitor' : 'election_visitor';
  const username = typeof env.ADMIN_USERNAME === 'string' ? env.ADMIN_USERNAME : '';
  const password = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '';
  const configured = Boolean(username && password && username.length <= 64 && password.length <= 128);
  const salt = randomBytes(16);
  const expectedPassword = configured ? scryptSync(password, salt, 64) : null;
  const expectedUsername = digest(username);
  const limits = limiter();
  const globalLimits = limiter(8);
  let db, secret, authVersion, nextCleanup = 0;

  const cookieValue = (name, value, maxAge, strict = false) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${strict ? 'Strict' : 'Lax'}${secure ? '; Secure' : ''}`;
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  const ipKey = req => {
    const forwarded = env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim() : '';
    return digest(forwarded || req.socket.remoteAddress || 'unknown');
  };
  function database() {
    if (db) return db;
    const filename = resolve(env.ANALYTICS_DB_PATH || resolve(root, '.data', 'analytics.sqlite'));
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(filename, { timeout: 5000 });
    try { chmodSync(filename, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, first_day TEXT NOT NULL, last_day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_visitors (day TEXT NOT NULL, visitor TEXT NOT NULL, PRIMARY KEY(day, visitor));
      CREATE TABLE IF NOT EXISTS pageviews (day TEXT NOT NULL, path TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(day, path));
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL, auth_version TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
    db.prepare('INSERT OR IGNORE INTO metadata(name,value) VALUES (?,?)').run('startedAt', new Date(now()).toISOString());
    db.prepare('INSERT OR IGNORE INTO metadata(name,value) VALUES (?,?)').run('secret', randomBytes(32).toString('hex'));
    secret = db.prepare('SELECT value FROM metadata WHERE name=?').get('secret').value;
    authVersion = sign(`${username}\0${password}`);
    return db;
  }
  function cleanup() {
    if (now() < nextCleanup) return;
    database().prepare('DELETE FROM sessions WHERE expires<=? OR auth_version<>?').run(now(), authVersion);
    db.prepare('DELETE FROM daily_visitors WHERE day<?').run(shiftDay(dayAt(now()), -90));
    nextCleanup = now() + 60 * 60 * 1000;
  }
  function session(req) {
    if (!configured) return false;
    const token = cookies(req).get(sessionName);
    if (!/^[a-f0-9]{64}$/.test(token || '')) return false;
    database();
    const record = db.prepare('SELECT expires,auth_version FROM sessions WHERE token=?').get(digest(token));
    return Boolean(record && record.expires > now() && record.auth_version === authVersion);
  }
  function respond(req, res, status, value, headers = {}) {
    const body = value === null ? '' : JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': jsonType, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  function problem(req, res, status, error, message, retryAfter) {
    respond(req, res, status, { error, message, ...(retryAfter ? { retryAfter } : {}) }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
  }
  function sameOrigin(req) {
    return req.headers.origin === origin && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
  }
  function stats() {
    database();
    cleanup();
    const today = dayAt(now());
    const countRange = from => ({
      visitors: db.prepare('SELECT COUNT(DISTINCT visitor) AS count FROM daily_visitors WHERE day>=? AND day<=?').get(from, today).count,
      pageviews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM pageviews WHERE day>=? AND day<=?').get(from, today).count,
    });
    const series = new Map(db.prepare('SELECT day, SUM(views) AS pageviews FROM pageviews WHERE day>=? AND day<=? GROUP BY day').all(shiftDay(today, -29), today).map(row => [row.day, row.pageviews]));
    const unique = new Map(db.prepare('SELECT day, COUNT(*) AS visitors FROM daily_visitors WHERE day>=? AND day<=? GROUP BY day').all(shiftDay(today, -29), today).map(row => [row.day, row.visitors]));
    return {
      startedAt: db.prepare('SELECT value FROM metadata WHERE name=?').get('startedAt').value,
      generatedAt: new Date(now()).toISOString(), timezone: TIMEZONE,
      totals: { visitors: db.prepare('SELECT COUNT(*) AS count FROM visitors').get().count, pageviews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM pageviews').get().count },
      today: countRange(today), last7Days: countRange(shiftDay(today, -6)), last30Days: countRange(shiftDay(today, -29)),
      daily: Array.from({ length: 30 }, (_, index) => { const date = shiftDay(today, index - 29); return { date, visitors: unique.get(date) || 0, pageviews: series.get(date) || 0 }; }),
      pages: ['/', '/primeiro-turno'].map(path => ({ path, pageviews: db.prepare('SELECT COALESCE(SUM(views),0) AS count FROM pageviews WHERE path=?').get(path).count })),
    };
  }
  async function handle(req, res, path) {
    if (path !== '/admin' && path !== '/admin/' && path !== '/api/visit' && !path.startsWith('/api/admin/')) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = req.method;
    if (path === '/admin' || path === '/admin/') {
      if (!['GET', 'HEAD'].includes(method)) { problem(req, res, 405, 'method_not_allowed', 'Método não permitido.'); return true; }
      if (path === '/admin/') { res.writeHead(308, { Location: '/admin', 'Content-Length': '0' }); res.end(); return true; }
      const html = await readFile(resolve(publicDir, 'admin.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(method === 'HEAD' ? undefined : html);
      return true;
    }
    const routes = { '/api/admin/login': 'POST', '/api/admin/logout': 'POST', '/api/admin/session': 'GET', '/api/admin/stats': 'GET', '/api/visit': 'POST' };
    if (!routes[path]) { problem(req, res, 404, 'not_found', 'Recurso não encontrado.'); return true; }
    if (method !== routes[path]) { problem(req, res, 405, 'method_not_allowed', 'Método não permitido.'); return true; }
    if (method === 'POST' && !sameOrigin(req)) { problem(req, res, 403, 'invalid_origin', 'Origem da requisição não autorizada.'); return true; }
    try {
      if (path === '/api/admin/session') { respond(req, res, 200, { authenticated: session(req), configured, ...(session(req) ? { username } : {}) }); return true; }
      if (path === '/api/admin/login') {
        if (!configured) { problem(req, res, 503, 'admin_unconfigured', 'O acesso administrativo ainda não está configurado.'); return true; }
        const key = `login:${ipKey(req)}`;
        const globalRetry = globalLimits.take('login', 100, 15 * 60_000, now());
        const retry = limits.take(key, 5, 15 * 60_000, now());
        if (globalRetry || retry) { problem(req, res, 429, 'too_many_attempts', 'Muitas tentativas. Aguarde antes de tentar novamente.', Math.max(globalRetry, retry)); return true; }
        const body = await readJson(req);
        if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.username.length > 64 || body.password.length > 128) { problem(req, res, 400, 'invalid_credentials_format', 'Informe usuário e senha válidos.'); return true; }
        const candidate = await deriveKey(body.password, salt, 64);
        const userMatches = timingSafeEqual(Buffer.from(digest(body.username), 'hex'), Buffer.from(expectedUsername, 'hex'));
        if (!timingSafeEqual(candidate, expectedPassword) || !userMatches) { problem(req, res, 401, 'invalid_credentials', 'Usuário ou senha inválidos.'); return true; }
        database(); cleanup();
        const previous = cookies(req).get(sessionName);
        if (previous) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(previous));
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions(token,expires,auth_version) VALUES (?,?,?)').run(digest(token), now() + SESSION_AGE * 1000, authVersion);
        limits.clear(key);
        respond(req, res, 200, { authenticated: true, username }, { 'Set-Cookie': cookieValue(sessionName, token, SESSION_AGE, true) });
        return true;
      }
      if (path === '/api/admin/logout') {
        await readJson(req);
        const token = cookies(req).get(sessionName);
        if (token && configured) database().prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
        respond(req, res, 200, { authenticated: false }, { 'Set-Cookie': cookieValue(sessionName, '', 0, true) });
        return true;
      }
      if (path === '/api/admin/stats') {
        if (!session(req)) { problem(req, res, 401, 'unauthorized', 'Entre para consultar as estatísticas.'); return true; }
        respond(req, res, 200, stats()); return true;
      }
      const data = await readJson(req);
      if (!['/', '/primeiro-turno'].includes(data.path)) { problem(req, res, 400, 'invalid_path', 'Página inválida.'); return true; }
      if (isBot(req.headers['user-agent']) || req.headers['sec-purpose'] === 'prefetch' || req.headers.purpose === 'prefetch') { respond(req, res, 204, null); return true; }
      const globalRetry = globalLimits.take('visits', 15_000, 60_000, now());
      const retry = limits.take(`visit:${ipKey(req)}`, 1000, 60_000, now());
      if (globalRetry || retry) { problem(req, res, 429, 'rate_limited', 'Limite temporário de registros.', Math.max(globalRetry, retry)); return true; }
      database(); cleanup();
      // Signed random browser identifiers never contain addresses, names or device details.
      const existing = cookies(req).get(visitorName) || '';
      const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(existing);
      const valid = match && timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(sign(match[1]), 'hex'));
      const visitor = valid ? match[1] : randomBytes(16).toString('hex');
      const visitorKey = digest(visitor);
      const browserRetry = limits.take(`browser:${visitorKey}`, 120, 60_000, now());
      if (browserRetry) { problem(req, res, 429, 'rate_limited', 'Limite temporário de registros.', browserRetry); return true; }
      const day = dayAt(now());
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO visitors(id,first_day,last_day) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_day=excluded.last_day').run(visitorKey, day, day);
        db.prepare('INSERT OR IGNORE INTO daily_visitors(day,visitor) VALUES (?,?)').run(day, visitorKey);
        db.prepare('INSERT INTO pageviews(day,path,views) VALUES (?,?,1) ON CONFLICT(day,path) DO UPDATE SET views=views+1').run(day, data.path);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      respond(req, res, 204, null, { 'Set-Cookie': cookieValue(visitorName, `${visitor}.${sign(visitor)}`, VISITOR_AGE) });
      return true;
    } catch (error) {
      if (error.status) problem(req, res, error.status, error.code, error.message);
      else { console.error('Falha no painel de visitas:', error.code || error.name); problem(req, res, 503, 'temporarily_unavailable', 'Estatísticas temporariamente indisponíveis.'); }
      return true;
    }
  }
  return { handle, close() { db?.close(); db = undefined; } };
}
