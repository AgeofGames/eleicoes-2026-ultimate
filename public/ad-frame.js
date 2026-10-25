(() => {
  const content = document.getElementById('ad-content');
  const slot = document.getElementById('container-3bbcbccd95faece0d4d6dae65a8d16a1');
  const status = document.getElementById('ad-status');
  let frameRequest;
  const reportSize = () => {
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(() => {
      status.hidden = Boolean(slot.querySelector('a,img,iframe'));
      parent.postMessage({ type: 'elections-ad-size', height: content.getBoundingClientRect().height }, location.origin);
    });
  };
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'elections-ad-theme') return;
    document.documentElement.dataset.theme = event.data.theme === 'dark' ? 'dark' : 'light';
  });
  new ResizeObserver(reportSize).observe(content);
  new MutationObserver(reportSize).observe(slot, { childList: true, subtree: true });
  setTimeout(() => { status.textContent = 'Publicidade indisponível no momento.'; reportSize(); }, 12000);
  reportSize();
})();
