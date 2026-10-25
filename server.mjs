import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UFS = new Set('br ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to'.split(' '));
const ELECTIONS = Object.freeze({
  '1': { id: '6257', label: 'Primeiro turno', date: '4 de outubro de 2026', path: '/primeiro-turno', otherPath: '/', otherLabel: 'Ver segundo turno' },
  '2': { id: '6258', label: 'Segundo turno', date: '25 de outubro de 2026', path: '/', otherPath: '/primeiro-turno', otherLabel: 'Ver primeiro turno' },
});
const MIME = Object.freeze({ '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' });
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const isLocal = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export function siteOrigin(env = process.env) {
  const configured = env.SITE_URL?.trim() || (env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}` : `http://localhost:${env.PORT || '3000'}`);
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname)))) {
    throw new Error('SITE_URL deve ser a origem HTTPS do site, sem caminho, credenciais ou parâmetros (HTTP só é permitido em localhost).');
  }
  return url.origin;
}

export function sourceUrl(turn, uf) {
  if (!['1', '2'].includes(turn) || !UFS.has(uf)) throw new Error('Consulta inválida.');
  const election = ELECTIONS[turn].id;
  return `https://resultados.tse.jus.br/oficial/ele2026/${election}/dados/${uf}/${uf}-c0001-e${election.padStart(6, '0')}-u.json`;
}

export function validatePayload(payload, turn, uf) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' || payload.f !== 'o' || String(payload.ele) !== ELECTIONS[turn]?.id || String(payload.t) !== turn || String(payload.cdabr).toLowerCase() !== uf || payload.tpabr !== (uf === 'br' ? 'br' : 'uf')) {
    throw new Error('O arquivo recebido não corresponde à eleição, ao turno ou à abrangência solicitada.');
  }
  if (payload.dv !== 's') throw new Error('O TSE ainda não autorizou a divulgação deste resultado.');
  if (!/^\d{2}\/\d{2}\/2026$/.test(payload.dg || '') || !Array.isArray(payload.carg) || !payload.carg.some(office => office && String(office.cd) === '1')) {
    throw new Error('O arquivo recebido não contém uma apuração presidencial de 2026 reconhecida.');
  }
  return payload;
}

class ResultError extends Error {
  constructor(message, status = 503, retryAfter = 30, code = 'upstream_unavailable') {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

export function createApp({ fetchImpl = globalThis.fetch, now = Date.now, env = process.env, publicDir = resolve(ROOT, 'public'), cacheMs = 25_000, timeoutMs = 10_000 } = {}) {
  const origin = siteOrigin(env);
  const indexable = origin.startsWith('https://') && !isLocal(new URL(origin).hostname);
  const cache = new Map();
  const pending = new Map();
  const cooldowns = new Map();
  let globalCooldown;

  async function fetchResults(turn, uf) {
    const key = `${turn}:${uf}`;
    const cached = cache.get(key);
    if (cached && now() - cached.checkedAt < cacheMs) return { ...cached, cache: 'HIT' };
    if (globalCooldown?.until > now()) throw new ResultError(globalCooldown.message, globalCooldown.status, Math.max(1, Math.ceil((globalCooldown.until - now()) / 1000)), globalCooldown.code);
    globalCooldown = undefined;
    const cooldown = cooldowns.get(key);
    if (cooldown?.until > now()) throw new ResultError(cooldown.message, cooldown.status, Math.max(1, Math.ceil((cooldown.until - now()) / 1000)), cooldown.code);
    if (cooldown) cooldowns.delete(key);
    if (pending.has(key)) return pending.get(key);

    const request = (async () => {
      const url = sourceUrl(turn, uf);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const upstream = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Eleicoes2026Ultimate/1.0' } });
        if (!upstream.ok) {
          const backoff = [403, 429].includes(upstream.status) ? 600 : upstream.status === 404 ? 180 : 30;
          const message = upstream.status === 404 ? 'O TSE ainda não disponibilizou este arquivo de resultados.' : [403, 429].includes(upstream.status) ? 'A fonte oficial limitou temporariamente as consultas. A próxima tentativa respeitará esse intervalo.' : 'A fonte oficial está temporariamente indisponível.';
          const code = upstream.status === 404 ? 'results_not_available' : 'upstream_unavailable';
          const status = [403, 429, 404].includes(upstream.status) ? upstream.status : 503;
          const cooldown = { until: now() + backoff * 1000, message, status, code };
          if ([403, 429].includes(status)) globalCooldown = cooldown;
          else cooldowns.set(key, cooldown);
          throw new ResultError(message, status, backoff, code);
        }
        const contentType = upstream.headers.get('content-type') || '';
        if (!/\bapplication\/(?:json|[\w.-]+\+json)\b/i.test(contentType)) throw new ResultError('A fonte oficial retornou um formato não reconhecido.', 502, 30, 'invalid_upstream_data');
        const contentLength = Number(upstream.headers.get('content-length'));
        if (contentLength > 4_000_000) throw new ResultError('A resposta da fonte oficial excedeu o tamanho permitido.', 502, 30, 'invalid_upstream_data');
        const reader = upstream.body?.getReader();
        if (!reader) throw new ResultError('A fonte oficial retornou uma resposta vazia.', 502, 30, 'invalid_upstream_data');
        let total = 0;
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 4_000_000) {
            await reader.cancel();
            throw new ResultError('A resposta da fonte oficial excedeu o tamanho permitido.', 502, 30, 'invalid_upstream_data');
          }
          chunks.push(value);
        }
        let payload;
        try { payload = validatePayload(JSON.parse(Buffer.concat(chunks).toString('utf8')), turn, uf); }
        catch { throw new ResultError('O arquivo recebido não passou pela validação de eleição, turno, abrangência ou autorização de divulgação.', 502, 30, 'invalid_upstream_data'); }
        const result = { body: JSON.stringify(payload), checkedAt: now(), source: url };
        cache.set(key, result);
        cooldowns.delete(key);
        return { ...result, cache: 'MISS' };
      } catch (error) {
        if (error instanceof ResultError) throw error;
        throw new ResultError(controller.signal.aborted ? 'O TSE demorou a responder. Tente novamente em instantes.' : 'Não foi possível consultar a fonte oficial neste momento.');
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, request);
    try { return await request; }
    finally { pending.delete(key); }
  }

  function send(req, res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    const baseCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
    res.setHeader('Content-Security-Policy', baseCsp);
    if (indexable) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (!indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!['GET', 'HEAD'].includes(req.method)) return send(req, res, 405, 'Método não permitido.', undefined, { Allow: 'GET, HEAD', 'X-Robots-Tag': 'noindex' });
    if (!req.url || req.url.length > 2048) return send(req, res, 400, 'Endereço inválido.');
    let url;
    try { url = new URL(req.url, 'http://internal.invalid'); }
    catch { return send(req, res, 400, 'Endereço inválido.'); }
    const path = url.pathname;
    if (path === '/publicidade') {
      const adCsp = "default-src 'none'; script-src 'self' https://bauval.org/21/3bbcbccd95faece0d4d6dae65a8d16a1; style-src 'self' 'unsafe-inline'; img-src https: data:; connect-src https://bauval.org; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'; sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
      return send(req, res, 200, await readFile(resolve(publicDir, 'ad-frame.html'), 'utf8'), 'text/html; charset=utf-8', { 'Content-Security-Policy': adCsp, 'X-Frame-Options': 'SAMEORIGIN', 'X-Robots-Tag': 'noindex, nofollow' });
    }
    if (path === '/health') return send(req, res, 200, '{"status":"ok"}', 'application/json; charset=utf-8', { 'X-Robots-Tag': 'noindex' });
    if (path === '/api/resultados') {
      const turn = url.searchParams.get('turno');
      const uf = url.searchParams.get('uf');
      const allowed = [...url.searchParams.keys()].every(key => key === 'turno' || key === 'uf');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (!allowed || url.searchParams.getAll('turno').length !== 1 || url.searchParams.getAll('uf').length !== 1 || !['1', '2'].includes(turn) || !UFS.has(uf)) {
        return send(req, res, 400, JSON.stringify({ error: 'invalid_query', message: 'Informe turno=1 ou 2 e uf=br ou uma sigla de UF em letras minúsculas.' }), 'application/json; charset=utf-8');
      }
      try {
        const data = await fetchResults(turn, uf);
        return send(req, res, 200, data.body, 'application/json; charset=utf-8', { 'X-Data-Checked-At': String(data.checkedAt), 'X-Data-Source': data.source, 'X-Cache': data.cache });
      } catch (error) {
        const problem = error instanceof ResultError ? error : new ResultError('Não foi possível consultar os resultados.');
        return send(req, res, problem.status, JSON.stringify({ error: problem.code, message: problem.message, retryAfter: problem.retryAfter }), 'application/json; charset=utf-8', { 'Retry-After': String(problem.retryAfter) });
      }
    }
    if (path.startsWith('/api/')) return send(req, res, 404, '{"error":"not_found"}', 'application/json; charset=utf-8', { 'X-Robots-Tag': 'noindex' });
    if (path === '/robots.txt') {
      const body = indexable ? `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /health\n\nSitemap: ${origin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
      return send(req, res, 200, body, 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=300' });
    }
    if (path === '/sitemap.xml') {
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHtml(origin)}/</loc></url><url><loc>${escapeHtml(origin)}/primeiro-turno</loc></url></urlset>\n`;
      return send(req, res, 200, body, 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=300' });
    }
    if (path === '/index.html' || path === '/primeiro-turno/' || path === '/segundo-turno' || path === '/segundo-turno/') {
      return send(req, res, 308, '', undefined, { Location: path.startsWith('/primeiro-turno') ? '/primeiro-turno' : '/' });
    }
    if (path === '/' || path === '/primeiro-turno') {
      const election = ELECTIONS[path === '/primeiro-turno' ? '1' : '2'];
      const title = `Eleições 2026 Ultimate | ${election.label}`;
      const description = `Acompanhe o ${election.label.toLowerCase()} das Eleições 2026 para presidente, em ${election.date}, com mapa do Brasil, resultados oficiais do TSE por estado e tema escuro.`;
      const substitutions = { __CANONICAL_URL__: origin + election.path, __SITE_ORIGIN__: origin, __PAGE_TITLE__: title, __PAGE_DESCRIPTION__: description, __TURN_LABEL__: election.label, __TURN_DATE__: election.date, __OTHER_TURN_HREF__: election.otherPath, __OTHER_TURN_LABEL__: election.otherLabel };
      let html = await readFile(resolve(publicDir, 'index.html'), 'utf8');
      const tokens = /__(?:CANONICAL_URL|SITE_ORIGIN|PAGE_TITLE|PAGE_DESCRIPTION|TURN_LABEL|TURN_DATE|OTHER_TURN_HREF|OTHER_TURN_LABEL)__/g;
      // JSON strings and HTML attributes require different escaping rules.
      html = html.replace(/(<script\b[^>]*type=["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (_match, open, json, close) => open + json.replace(tokens, token => JSON.stringify(substitutions[token]).slice(1, -1).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')) + close);
      html = html.replace(tokens, token => escapeHtml(substitutions[token]));
      const hashes = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
      if (hashes.length) res.setHeader('Content-Security-Policy', baseCsp.replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`));
      return send(req, res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Robots-Tag': indexable ? 'index, follow, max-image-preview:large' : 'noindex, nofollow', Link: `<${origin + election.path}>; rel="canonical"` });
    }
    let assetPath;
    try {
      const decoded = decodeURIComponent(path);
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) throw new Error('invalid');
      assetPath = resolve(publicDir, `.${decoded}`);
      const rel = relative(publicDir, assetPath);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !MIME[extname(assetPath).toLowerCase()]) throw new Error('invalid');
      const actual = await realpath(assetPath);
      const actualRelative = relative(await realpath(publicDir), actual);
      if (actualRelative.startsWith('..') || isAbsolute(actualRelative) || !(await stat(actual)).isFile()) throw new Error('invalid');
      return send(req, res, 200, await readFile(actual), MIME[extname(actual).toLowerCase()], { 'Cache-Control': 'public, max-age=3600' });
    } catch {
      return send(req, res, 404, '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Página não encontrada — Eleições 2026 Ultimate</title><h1>Página não encontrada</h1><p><a href="/">Voltar às Eleições 2026 Ultimate</a></p></html>', 'text/html; charset=utf-8', { 'X-Robots-Tag': 'noindex, nofollow' });
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error('Falha ao atender requisição:', error.message);
      if (!res.headersSent) send(req, res, 500, 'Serviço temporariamente indisponível.', undefined, { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' });
      else res.end();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválida.');
  const server = createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Eleições 2026 Ultimate disponível na porta ${server.address().port}. Origem pública: ${siteOrigin()}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
