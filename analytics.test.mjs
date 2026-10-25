import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';

const ORIGIN = 'https://eleicoes.example.com';
const credentials = { username: 'test-owner', password: 'test-password-only-2026' };
const cookie = response => response.headers.get('set-cookie')?.split(';')[0];

async function fixture(t, options = {}) {
  const dir = options.dir || await mkdtemp(join(tmpdir(), 'elections-analytics-test-'));
  let time = options.time || Date.parse('2026-10-25T12:00:00Z');
  const env = { SITE_URL: ORIGIN, ADMIN_USERNAME: credentials.username, ADMIN_PASSWORD: credentials.password, ANALYTICS_DB_PATH: join(dir, 'analytics.sqlite'), ...options.env };
  const server = createApp({ env, now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
  };
  t.after(async () => {
    await close();
    if (!options.dir) {
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'elections-analytics-test-'));
      await rm(dir, { recursive: true, force: true });
    }
  });
  const request = (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
  const post = (path, data = {}, sessionCookie = '', headers = {}) => request(path, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 AnalyticsTest', ...(sessionCookie ? { Cookie: sessionCookie } : {}), ...headers }, body: JSON.stringify(data),
  });
  const login = async () => {
    const response = await post('/api/admin/login', credentials);
    assert.equal(response.status, 200);
    return cookie(response);
  };
  const stats = async sessionCookie => {
    const response = await request('/api/admin/stats', { headers: { Cookie: sessionCookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { request, post, login, stats, dir, env, close, advance(ms) { time += ms; } };
}

test('admin exige login, preserva segredo em cookie HttpOnly e encerra a sessão no logout', async t => {
  const app = await fixture(t);
  const absent = await app.request('/api/admin/stats');
  assert.equal(absent.status, 401);
  assert.equal(absent.headers.get('cache-control'), 'no-store');
  assert.equal(absent.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await (await app.request('/api/admin/session')).json(), { authenticated: false, configured: true });
  const wrong = await app.post('/api/admin/login', { ...credentials, password: 'wrong' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const login = await app.post('/api/admin/login', credentials);
  assert.equal(login.status, 200);
  const sessionCookie = cookie(login);
  assert.match(login.headers.get('set-cookie'), /__Host-election_admin=[a-f0-9]{64}; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
  assert.deepEqual(await (await app.request('/api/admin/session', { headers: { Cookie: sessionCookie } })).json(), { authenticated: true, configured: true, username: credentials.username });
  const initial = await app.stats(sessionCookie);
  assert.deepEqual(initial.totals, { visitors: 0, pageviews: 0 });
  const db = new DatabaseSync(app.env.ANALYTICS_DB_PATH, { readOnly: true });
  const stored = db.prepare('SELECT token FROM sessions').get().token;
  db.close();
  assert.notEqual(stored, sessionCookie.split('=')[1]);
  const logout = await app.post('/api/admin/logout', {}, sessionCookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.request('/api/admin/stats', { headers: { Cookie: sessionCookie } })).status, 401);
});

test('origens externas, formulários e métodos alternativos não podem autenticar nem registrar visitas', async t => {
  const app = await fixture(t);
  assert.equal((await app.post('/api/admin/login', credentials, '', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post('/api/admin/login', credentials, '', { Origin: '' })).status, 403);
  assert.equal((await app.post('/api/visit', { path: '/' }, '', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post('/api/admin/login', credentials, '', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.request('/api/admin/login')).status, 405);
  assert.equal((await app.request('/api/visit')).status, 405);
  const sessionCookie = await app.login();
  assert.equal((await app.post('/api/admin/logout', {}, sessionCookie, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request('/api/admin/stats', { headers: { Cookie: sessionCookie } })).status, 200);
  assert.equal((await app.post('/api/visit', { path: '/admin' })).status, 400);
  assert.equal((await app.post('/api/visit', { path: '/', junk: 'x'.repeat(5000) })).status, 413);
});

test('tentativas de senha têm limite por IP confiável, inclusive com origens diferentes falsificadas no XFF', async t => {
  const app = await fixture(t, { env: { TRUST_PROXY: '1' } });
  for (let index = 0; index < 5; index++) {
    const response = await app.post('/api/admin/login', { ...credentials, password: 'wrong' }, '', { 'X-Forwarded-For': `198.51.100.${index}, 203.0.113.10` });
    assert.equal(response.status, 401);
  }
  const blocked = await app.post('/api/admin/login', credentials, '', { 'X-Forwarded-For': '192.0.2.1, 203.0.113.10' });
  assert.equal(blocked.status, 429);
  assert.equal(Number(blocked.headers.get('retry-after')), 900);
  assert.equal((await app.post('/api/admin/login', credentials, '', { 'X-Forwarded-For': '203.0.113.11' })).status, 200);
  app.advance(15 * 60_000);
  assert.equal((await app.post('/api/admin/login', credentials, '', { 'X-Forwarded-For': '203.0.113.10' })).status, 200);
});

test('visualizações e navegadores únicos contam por dia e período, sem contar bots, arquivos ou o admin', async t => {
  const app = await fixture(t);
  const sessionCookie = await app.login();
  const first = await app.post('/api/visit', { path: '/' });
  assert.equal(first.status, 204);
  const browserA = cookie(first);
  assert.match(browserA, /__Host-election_visitor=[a-f0-9]{32}\.[a-f0-9]{64}/);
  assert.equal((await app.post('/api/visit', { path: '/primeiro-turno' }, browserA)).status, 204);
  assert.equal((await app.post('/api/visit', { path: '/' })).status, 204);
  assert.equal((await app.post('/api/visit', { path: '/' }, '', { 'User-Agent': 'WhatsApp/2.0' })).status, 204);
  await app.request('/');
  await app.request('/app.js');
  await app.request('/api/admin/session');
  let report = await app.stats(sessionCookie);
  assert.deepEqual(report.totals, { visitors: 2, pageviews: 3 });
  assert.deepEqual(report.today, { visitors: 2, pageviews: 3 });
  assert.deepEqual(report.pages, [{ path: '/', pageviews: 2 }, { path: '/primeiro-turno', pageviews: 1 }]);
  assert.equal(report.timezone, 'America/Sao_Paulo');
  assert.equal(report.daily.length, 30);
  assert.deepEqual(report.daily.at(-1), { date: '2026-10-25', visitors: 2, pageviews: 3 });
  app.advance(86_400_000);
  assert.equal((await app.post('/api/visit', { path: '/' }, browserA)).status, 204);
  report = await app.stats(await app.login());
  assert.deepEqual(report.totals, { visitors: 2, pageviews: 4 });
  assert.deepEqual(report.today, { visitors: 1, pageviews: 1 });
  assert.deepEqual(report.last7Days, { visitors: 2, pageviews: 4 });
  assert.deepEqual(report.last30Days, { visitors: 2, pageviews: 4 });
});

test('cookie adulterado não aceita identidade escolhida e excesso de registros tem limite por navegador', async t => {
  const app = await fixture(t);
  const sessionCookie = await app.login();
  const first = await app.post('/api/visit', { path: '/' });
  const browserA = cookie(first);
  const forged = browserA.slice(0, -64) + '0'.repeat(64);
  const second = await app.post('/api/visit', { path: '/' }, forged);
  assert.notEqual(cookie(second), browserA);
  assert.deepEqual((await app.stats(sessionCookie)).totals, { visitors: 2, pageviews: 2 });
  for (let index = 1; index < 120; index++) assert.equal((await app.post('/api/visit', { path: '/' }, browserA)).status, 204);
  assert.equal((await app.post('/api/visit', { path: '/' }, browserA)).status, 429);
});

test('contagens, identificador assinado e sessão sobrevivem a reinício; alteração de senha revoga sessões anteriores', async t => {
  const first = await fixture(t);
  const sessionCookie = await first.login();
  const browserCookie = cookie(await first.post('/api/visit', { path: '/' }));
  const startedAt = (await first.stats(sessionCookie)).startedAt;
  await first.close();
  const second = await fixture(t, { dir: first.dir });
  assert.deepEqual((await second.stats(sessionCookie)).totals, { visitors: 1, pageviews: 1 });
  await second.post('/api/visit', { path: '/primeiro-turno' }, browserCookie);
  const report = await second.stats(sessionCookie);
  assert.deepEqual(report.totals, { visitors: 1, pageviews: 2 });
  assert.equal(report.startedAt, startedAt);
  await second.close();
  const changed = await fixture(t, { dir: first.dir, env: { ADMIN_PASSWORD: 'changed-test-password' } });
  assert.equal((await changed.request('/api/admin/stats', { headers: { Cookie: sessionCookie } })).status, 401);
  await changed.close();
});

test('sessões expiram em 12 horas e ausência de credenciais não deixa entrar', async t => {
  const app = await fixture(t);
  const sessionCookie = await app.login();
  app.advance(12 * 60 * 60 * 1000);
  assert.equal((await app.request('/api/admin/stats', { headers: { Cookie: sessionCookie } })).status, 401);
  const unconfigured = await fixture(t, { env: { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } });
  assert.deepEqual(await (await unconfigured.request('/api/admin/session')).json(), { authenticated: false, configured: false });
  assert.equal((await unconfigured.post('/api/admin/login', credentials)).status, 503);
  assert.equal((await unconfigured.request('/api/admin/stats', { headers: { Cookie: sessionCookie } })).status, 401);
});
