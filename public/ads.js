(() => {
  const frame = document.getElementById('native-ad');
  if (!frame) return;
  const sendTheme = () => frame.contentWindow?.postMessage({ type: 'elections-ad-theme', theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light' }, '*');
  frame.addEventListener('load', sendTheme);
  new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'elections-ad-size') return;
    const height = event.data.height;
    if (Number.isFinite(height)) frame.style.height = `${Math.min(1800, Math.max(80, Math.ceil(height)))}px`;
  });
})();
