'use strict';
(() => {
  const el = id => document.getElementById(id);
  const number = new Intl.NumberFormat('pt-BR');
  const fullDate = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
  const shortDate = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
  let loading = false;
  let loggingIn = false;
  let authenticated = false;

  function message(id, text) {
    el(id).textContent = text || '';
    el(id).hidden = !text;
  }
  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function setCount(id, value) { el(id).textContent = number.format(count(value)); }
  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? fullDate.format(date) : 'indisponível';
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(data?.message || 'Não foi possível concluir a solicitação. Tente novamente.');
        error.status = response.status;
        error.retryAfter = Number(data?.retryAfter || response.headers.get('Retry-After'));
        throw error;
      }
      if (!data || typeof data !== 'object') throw new Error('O painel recebeu uma resposta inválida. Tente novamente.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('A conexão demorou a responder. Tente novamente.');
      if (error instanceof TypeError) throw new Error('Não foi possível conectar ao site. Verifique sua conexão e tente novamente.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function showLogin(text = '', focus = false) {
    authenticated = false;
    el('initial-status').hidden = true;
    el('dashboard').hidden = true;
    el('login-panel').hidden = false;
    el('password').value = '';
    el('password').type = 'password';
    el('password-toggle').setAttribute('aria-pressed', 'false');
    el('password-toggle').setAttribute('aria-label', 'Mostrar senha');
    el('password-toggle').textContent = 'Mostrar';
    message('login-message', text);
    if (focus) el('username').focus();
  }
  function showDashboard() {
    authenticated = true;
    el('initial-status').hidden = true;
    el('login-panel').hidden = true;
    el('dashboard').hidden = false;
    message('login-message', '');
    el('password').value = '';
  }
  function renderChart(days) {
    const chart = document.createDocumentFragment();
    const table = document.createDocumentFragment();
    const max = Math.max(1, ...days.flatMap(day => [count(day.visitors), count(day.pageviews)]));
    for (const [index, day] of days.entries()) {
      const date = new Date(`${day.date}T12:00:00Z`);
      if (!Number.isFinite(date.getTime())) continue;
      const label = shortDate.format(date);
      const visitors = count(day.visitors), views = count(day.pageviews);
      const description = `${label}: ${number.format(visitors)} visitantes, ${number.format(views)} visualizações`;
      const column = document.createElement('div');
      column.className = `chart-day${index === 0 || index === days.length - 1 || index % 7 === 0 ? ' label-day' : ''}`;
      column.setAttribute('role', 'listitem');
      column.setAttribute('aria-label', description);
      column.title = description;
      const bars = document.createElement('div');
      bars.className = 'chart-bars';
      bars.setAttribute('aria-hidden', 'true');
      for (const [value, kind] of [[visitors, 'visitors'], [views, 'views']]) {
        const bar = document.createElement('span');
        bar.className = `chart-bar ${kind}${value === 0 ? ' zero' : ''}`;
        bar.style.height = `${value / max * 100}%`;
        bars.append(bar);
      }
      const time = document.createElement('time');
      time.dateTime = day.date;
      time.textContent = label;
      time.setAttribute('aria-hidden', 'true');
      column.append(bars, time);
      chart.append(column);
      const row = document.createElement('tr');
      for (const [cellIndex, value] of [label, number.format(visitors), number.format(views)].entries()) {
        const cell = document.createElement(cellIndex === 0 ? 'th' : 'td');
        if (cellIndex === 0) cell.scope = 'row';
        cell.textContent = value;
        row.append(cell);
      }
      table.prepend(row);
    }
    el('daily-chart').replaceChildren(chart);
    el('daily-table').replaceChildren(table);
  }
  function renderStats(data) {
    if (!data.totals || !data.today || !data.last7Days || !data.last30Days || !Array.isArray(data.daily) || !Array.isArray(data.pages)) {
      throw new Error('Não foi possível ler os dados do painel. Tente atualizar novamente.');
    }
    for (const [id, value] of Object.entries({
      'total-visitors': data.totals.visitors, 'total-pageviews': data.totals.pageviews,
      'today-visitors': data.today.visitors, 'today-pageviews': data.today.pageviews,
      'period-today-visitors': data.today.visitors, 'period-today-pageviews': data.today.pageviews,
      'period-week-visitors': data.last7Days.visitors, 'period-week-pageviews': data.last7Days.pageviews,
      'period-month-visitors': data.last30Days.visitors, 'period-month-pageviews': data.last30Days.pageviews,
    })) setCount(id, value);
    const first = count(data.pages.find(page => page.path === '/primeiro-turno')?.pageviews);
    const second = count(data.pages.find(page => page.path === '/')?.pageviews);
    setCount('first-pageviews', first);
    setCount('second-pageviews', second);
    const total = first + second;
    el('first-bar').style.width = `${total ? first / total * 100 : 0}%`;
    el('second-bar').style.width = `${total ? second / total * 100 : 0}%`;
    renderChart(data.daily);
    el('empty-notice').hidden = count(data.totals.pageviews) !== 0;
    el('updated-at').textContent = `Atualizado em ${formatDate(data.generatedAt)}`;
    el('counting-start').textContent = `Contagem iniciada em ${formatDate(data.startedAt)}, no horário de Brasília. Acessos anteriores à ativação não estão incluídos.`;
  }
  async function refreshStats() {
    if (loading || !authenticated) return;
    loading = true;
    el('refresh-stats').disabled = true;
    el('refresh-stats').setAttribute('aria-busy', 'true');
    message('dashboard-message', '');
    try {
      const data = await api('/api/admin/stats');
      if (authenticated) renderStats(data);
    } catch (error) {
      if (error.status === 401) showLogin('Sua sessão expirou. Entre novamente para continuar.', true);
      else if (authenticated) message('dashboard-message', error.message);
    } finally {
      loading = false;
      el('refresh-stats').disabled = false;
      el('refresh-stats').setAttribute('aria-busy', 'false');
    }
  }
  el('password-toggle').addEventListener('click', () => {
    const show = el('password').type === 'password';
    el('password').type = show ? 'text' : 'password';
    el('password-toggle').setAttribute('aria-pressed', String(show));
    el('password-toggle').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
    el('password-toggle').textContent = show ? 'Ocultar' : 'Mostrar';
  });
  el('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (loggingIn) return;
    loggingIn = true;
    el('login-submit').disabled = true;
    el('login-submit').setAttribute('aria-busy', 'true');
    message('login-message', '');
    try {
      const result = await api('/api/admin/login', { username: el('username').value, password: el('password').value });
      if (!result.authenticated) throw new Error('Não foi possível entrar. Tente novamente.');
      showDashboard();
      el('dashboard-title').focus();
      await refreshStats();
    } catch (error) {
      const cooldown = error.status === 429 && Number.isFinite(error.retryAfter) && error.retryAfter > 0 ? ` Tente novamente em ${Math.ceil(error.retryAfter / 60)} minuto(s).` : '';
      message('login-message', error.message + cooldown);
    } finally {
      loggingIn = false;
      el('login-submit').disabled = false;
      el('login-submit').setAttribute('aria-busy', 'false');
    }
  });
  el('refresh-stats').addEventListener('click', refreshStats);
  el('logout').addEventListener('click', async () => {
    el('logout').disabled = true;
    message('dashboard-message', '');
    try {
      await api('/api/admin/logout', {});
      showLogin('', true);
    } catch (error) { message('dashboard-message', error.message); }
    finally { el('logout').disabled = false; }
  });
  (async () => {
    try {
      const session = await api('/api/admin/session');
      if (session.authenticated) { showDashboard(); await refreshStats(); }
      else showLogin(session.configured === false ? 'O acesso administrativo ainda não foi configurado no servidor.' : '');
    } catch (error) { showLogin(error.message); }
  })();
})();
