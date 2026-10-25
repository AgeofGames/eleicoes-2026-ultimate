'use strict';
(() => {
  if (!['/', '/primeiro-turno'].includes(location.pathname)) return;
  let sent = false;
  function recordVisit() {
    if (sent || document.visibilityState !== 'visible') return;
    sent = true;
    document.removeEventListener('visibilitychange', recordVisit);
    fetch('/api/visit', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: location.pathname }),
    }).catch(() => {});
  }
  document.addEventListener('visibilitychange', recordVisit);
  recordVisit();
})();
