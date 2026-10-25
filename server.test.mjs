import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp, siteOrigin, sourceUrl, validatePayload } from './server.mjs';

const fixture = (turn = '2', uf = 'br', patch = {}) => ({
  f: 'o', ele: turn === '1' ? '6257' : '6258', t: turn, cdabr: uf, tpabr: uf === 'br' ? 'br' : 'uf',
  dv: 's', dg: '25/10/2026', hg: '18:00:00', s: { pst: '12,00' },
  carg: [{ cd: '1', agr: [{ par: [{ sg: 'PT', cand: [{ n: '13', nmu: 'Lula', pvap: '51,00' }] }] }] }], ...patch,
});
const jsonResponse = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function start(t, options = {}) {
  const server = createApp({ env: { SITE_URL: 'https://eleicoes.example.com' }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}

test('origem usa SITE_URL, depois Railway; configuração inválida é rejeitada', () => {
  assert.equal(siteOrigin({ SITE_URL: 'https://www.example.com/', RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app' }), 'https://www.example.com');
  assert.equal(siteOrigin({ RAILWAY_PUBLIC_DOMAIN: 'eleicoes.up.railway.app' }), 'https://eleicoes.up.railway.app');
  assert.equal(siteOrigin({ PORT: '3456' }), 'http://localhost:3456');
  for (const SITE_URL of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'javascript:alert(1)']) assert.throws(() => siteOrigin({ SITE_URL }));
});

test('URLs oficiais são limitadas ao ciclo, turnos e UFs autorizados', () => {
  assert.equal(sourceUrl('2', 'sp'), 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/sp/sp-c0001-e006258-u.json');
  assert.equal(sourceUrl('1', 'br'), 'https://resultados.tse.jus.br/oficial/ele2026/6257/dados/br/br-c0001-e006257-u.json');
  for (const [turn, uf] of [['0', 'br'], ['__proto__', 'br'], ['toString', 'br'], ['2', 'https://evil.example'], ['2', '../br'], ['2', 'SP']]) assert.throws(() => sourceUrl(turn, uf));
});

test('validação rejeita arquivos de simulação, outro ano, turno, eleição, UF, cargo ou sem autorização', () => {
  assert.equal(validatePayload(fixture(), '2', 'br').ele, '6258');
  const patches = [{ f: 's' }, { ele: '6257' }, { t: '1' }, { cdabr: 'sp' }, { tpabr: 'uf' }, { dv: 'n' }, { dg: '30/10/2022' }, { carg: [{ cd: '3' }] }, { carg: null }];
  for (const patch of patches) assert.throws(() => validatePayload(fixture('2', 'br', patch), '2', 'br'));
  for (const payload of [null, [], 'text']) assert.throws(() => validatePayload(payload, '2', 'br'));
});

test('páginas dos dois turnos têm canonical, prévia social, textos SSR, JSON-LD válido e CSP compatível', async t => {
  const request = await start(t);
  for (const [path, label, date, other] of [['/', 'Segundo turno', '25 de outubro de 2026', '/primeiro-turno'], ['/primeiro-turno', 'Primeiro turno', '4 de outubro de 2026', '/']]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`<title>Eleições 2026 Ultimate \\| ${label}</title>`));
    assert.ok(html.includes(`href="https://eleicoes.example.com${path}"`));
    const head = html.slice(0, html.indexOf('</head>'));
    const imageUrl = 'https://eleicoes.example.com/social-preview-v1.jpg';
    assert.ok(head.includes(`<meta property="og:image" content="${imageUrl}">`));
    assert.ok(head.includes(`<meta property="og:image:secure_url" content="${imageUrl}">`));
    assert.ok(head.includes('<meta property="og:image:type" content="image/jpeg">'));
    assert.ok(head.includes('<meta property="og:image:width" content="1200">'));
    assert.ok(head.includes('<meta property="og:image:height" content="628">'));
    assert.match(head, /<meta property="og:image:alt" content="[^"]+">/);
    assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(head.includes(`<meta name="twitter:image" content="${imageUrl}">`));
    assert.equal((head.match(/property="og:image"/g) || []).length, 1);
    assert.ok(html.includes(date));
    assert.ok(html.includes(`href="${other}"`));
    assert.doesNotMatch(html, /__[A-Z_]+__/);
    assert.equal(response.headers.get('X-Robots-Tag'), 'index, follow, max-image-preview:large');
    const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(json).url, 'https://eleicoes.example.com/');
    const hash = createHash('sha256').update(json).digest('base64');
    assert.ok(response.headers.get('Content-Security-Policy').includes(`'sha256-${hash}'`));
  }
});

test('imagem de compartilhamento é JPEG público e leve, acessível por GET e HEAD sem JavaScript', async t => {
  const request = await start(t);
  const path = '/social-preview-v1.jpg';
  const response = await request(path, { headers: { 'User-Agent': 'WhatsApp/2.0' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('X-Robots-Tag'), null);
  const image = Buffer.from(await response.arrayBuffer());
  assert.equal(image.readUInt16BE(0), 0xffd8);
  assert.equal(image.readUInt16BE(image.length - 2), 0xffd9);
  assert.ok(image.length > 0 && image.length < 600_000);
  const head = await request(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(Number(head.headers.get('Content-Length')), image.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('robots e sitemap usam origem configurada; ambiente local não é indexável', async t => {
  const request = await start(t, { env: { RAILWAY_PUBLIC_DOMAIN: 'eleicoes.up.railway.app' } });
  const robots = await (await request('/robots.txt')).text();
  assert.match(robots, /Allow: \/\n/);
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/eleicoes\.up\.railway\.app\/sitemap\.xml/);
  const sitemap = await (await request('/sitemap.xml')).text();
  assert.ok(sitemap.includes('<loc>https://eleicoes.up.railway.app/</loc>'));
  assert.ok(sitemap.includes('<loc>https://eleicoes.up.railway.app/primeiro-turno</loc>'));
  const local = await start(t, { env: { PORT: '3000' } });
  assert.equal((await local('/')).headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(await (await local('/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');
});

test('publicidade usa iframe isolado nos dois turnos sem liberar scripts externos no painel', async t => {
  const request = await start(t);
  for (const path of ['/', '/primeiro-turno']) {
    const response = await request(path);
    const html = await response.text();
    assert.match(html, /title="Publicidade — Adsterra" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"/);
    assert.ok(html.indexOf('class="ad-panel"') > html.indexOf('class="layout"'));
    assert.ok(html.indexOf('class="ad-panel"') < html.indexOf('class="states-panel"'));
    assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /bauval|unsafe-eval|script-src[^;]*https:/);
  }
  const response = await request('/publicidade');
  const html = await response.text();
  const csp = response.headers.get('Content-Security-Policy');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.match(csp, /sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox/);
  assert.doesNotMatch(csp, /allow-top-navigation|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(html, /https:\/\/bauval\.org\/21\/3bbcbccd95faece0d4d6dae65a8d16a1/);
  assert.match(html, /id="container-3bbcbccd95faece0d4d6dae65a8d16a1"/);
  const sitemap = await (await request('/sitemap.xml')).text();
  assert.doesNotMatch(sitemap, /publicidade/);
});

test('health, assets, HEAD, métodos, redirects e 404 verdadeiros', async t => {
  const request = await start(t);
  assert.deepEqual(await (await request('/health')).json(), { status: 'ok' });
  for (const path of ['/styles.css', '/app.js', '/theme-init.js', '/favicon.svg']) assert.equal((await request(path)).status, 200);
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await request('/', { method: 'POST' })).status, 405);
  const redirect = await request('/primeiro-turno/', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/primeiro-turno');
  for (const path of ['/missing', '/server.mjs', '/.env', '/%2e%2e/server.mjs', '/%2e%2e%2fserver.mjs', '/api/missing']) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
  }
});

test('queries inválidas e tentativas SSRF não chegam ao fetch', async t => {
  let calls = 0;
  const request = await start(t, { fetchImpl: async () => { calls++; return jsonResponse(fixture()); } });
  for (const query of ['', '?turno=3&uf=br', '?turno=toString&uf=br', '?turno=__proto__&uf=br', '?turno=2&uf=SP', '?turno=2&uf=xx', '?turno=2&uf=br&url=https://evil.example', '?turno=2&uf=br&uf=sp', '?turno=1&turno=2&uf=br', '?turno=2&uf=..%2Fbr', '?turno=2&uf=https%3A%2F%2Fevil.example']) assert.equal((await request(`/api/resultados${query}`)).status, 400, query);
  assert.equal(calls, 0);
});

test('cache separa turnos e UFs, expira em 25s e preserva horário da consulta', async t => {
  let clock = 1_000_000;
  const calls = [];
  const request = await start(t, { now: () => clock, fetchImpl: async url => {
    calls.push(url);
    const turn = url.includes('/6257/') ? '1' : '2';
    return jsonResponse(fixture(turn, url.includes('/sp/') ? 'sp' : 'br'));
  } });
  const first = await request('/api/resultados?turno=2&uf=br');
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(first.headers.get('X-Data-Checked-At'), '1000000');
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  clock += 24_999;
  const hit = await request('/api/resultados?turno=2&uf=br');
  assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.equal(hit.headers.get('X-Data-Checked-At'), '1000000');
  assert.equal((await (await request('/api/resultados?turno=1&uf=br')).json()).ele, '6257');
  assert.equal((await (await request('/api/resultados?turno=2&uf=sp')).json()).cdabr, 'sp');
  assert.equal(calls.length, 3);
  clock++;
  assert.equal((await request('/api/resultados?turno=2&uf=br')).headers.get('X-Cache'), 'MISS');
  assert.equal(calls.length, 4);
});

test('consultas simultâneas compartilham uma requisição ao TSE', async t => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const request = await start(t, { fetchImpl: async () => { calls++; await gate; return jsonResponse(fixture()); } });
  const responses = Array.from({ length: 8 }, () => request('/api/resultados?turno=2&uf=br'));
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  assert.ok((await Promise.all(responses)).every(response => response.status === 200));
  assert.equal(calls, 1);
});

test('erro não apresenta cache vencido como dado novo e backoff 404 é respeitado', async t => {
  let clock = 100_000;
  let calls = 0;
  const request = await start(t, { now: () => clock, fetchImpl: async () => ++calls === 1 ? jsonResponse(fixture()) : new Response('not found', { status: 404 }) });
  assert.equal((await request('/api/resultados?turno=2&uf=br')).status, 200);
  clock += 25_000;
  const failed = await request('/api/resultados?turno=2&uf=br');
  assert.equal(failed.status, 404);
  assert.equal(failed.headers.get('Retry-After'), '180');
  assert.equal(failed.headers.get('X-Data-Checked-At'), null);
  assert.equal((await failed.json()).error, 'results_not_available');
  clock += 10_000;
  assert.equal((await request('/api/resultados?turno=2&uf=br')).headers.get('Retry-After'), '170');
  assert.equal(calls, 2);
  clock += 170_000;
  await request('/api/resultados?turno=2&uf=br');
  assert.equal(calls, 3);
});

test('403 e 429 preservam status e aplicam 10 minutos de backoff global entre UFs e turnos', async t => {
  for (const status of [403, 429]) {
    let calls = 0;
    const request = await start(t, { fetchImpl: async () => { calls++; return new Response('', { status }); } });
    const response = await request('/api/resultados?turno=2&uf=br');
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Retry-After'), '600');
    await request('/api/resultados?turno=2&uf=br');
    assert.equal((await request('/api/resultados?turno=2&uf=sp')).status, status);
    assert.equal((await request('/api/resultados?turno=1&uf=br')).status, status);
    assert.equal(calls, 1);
  }
});

test('payload de outro turno, conteúdo HTML e JSON malformado retornam erro sem cache', async t => {
  for (const build of [() => jsonResponse(fixture('1')), () => new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } }), () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }), () => jsonResponse(fixture('2', 'br', { dv: 'n' }))]) {
    const request = await start(t, { fetchImpl: async () => build() });
    const response = await request('/api/resultados?turno=2&uf=br');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'invalid_upstream_data');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('timeout aborta a consulta e retorna falha explícita', async t => {
  const request = await start(t, { timeoutMs: 15, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const response = await request('/api/resultados?turno=2&uf=br');
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /demorou/);
});
