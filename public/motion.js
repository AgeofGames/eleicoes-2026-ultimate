'use strict';
(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set();
  const running = new WeakMap();
  const ease = 'cubic-bezier(.22,1,.36,1)';
  let ready = false;
  const enabled = () => ready && !reduced.matches && !document.hidden;
  const visible = node => {
    if (!node || node.hidden || !node.isConnected) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
  };
  function play(node, frames, options = {}, complete) {
    if (!enabled() || !visible(node) || typeof node.animate !== 'function') return null;
    running.get(node)?.cancel();
    const animation = node.animate(frames, { duration: 360, easing: ease, ...options });
    running.set(node, animation);
    active.add(animation);
    const release = () => {
      active.delete(animation);
      if (running.get(node) === animation) running.delete(node);
    };
    animation.onfinish = () => { release(); complete?.(); };
    animation.oncancel = release;
    return animation;
  }
  function settle() {
    for (const animation of [...active]) {
      try { animation.finish(); } catch { animation.cancel(); }
    }
  }
  reduced.addEventListener('change', () => { if (reduced.matches) settle(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });

  window.electionMotion = {
    // Values change immediately; only their presentation receives a short transition.
    metric(node) {
      if (!/^(national-(lula|flavio|counted)|detail-(lula|flavio)|region-(lula|flavio|counted)-.+)$/.test(node.id)) return;
      play(node, [{ opacity: .55, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 300 });
    },
    select(uf) {
      document.querySelectorAll('.detail h3,.detail-scores,.detail-notes,.detail .data-link').forEach((node, index) => {
        play(node, [{ opacity: .5, translate: '0 7px' }, { opacity: 1, translate: '0 0' }], { duration: 340, delay: index * 22 });
      });
      const box = document.querySelector(`#label-${uf} .label-box`);
      play(box, [{ strokeWidth: 2 }, { strokeWidth: 3.6 }, { strokeWidth: 2 }], { duration: 460 });
    },
    filter(grid, update) {
      if (!enabled()) { update(); return; }
      const cards = [...grid.children];
      const before = new Map(cards.filter(node => !node.hidden).map(node => [node, node.getBoundingClientRect()]));
      cards.forEach(node => running.get(node)?.cancel());
      update();
      let entering = 0;
      for (const node of cards) {
        if (node.hidden) continue;
        const old = before.get(node), next = node.getBoundingClientRect();
        if (old) {
          const x = old.left - next.left, y = old.top - next.top;
          if (Math.abs(x) + Math.abs(y) > 1) play(node, [{ translate: `${x}px ${y}px` }, { translate: '0 0' }], { duration: 350 });
        } else {
          play(node, [{ opacity: .15, translate: '0 9px' }, { opacity: 1, translate: '0 0' }], { duration: 330, delay: Math.min(entering++, 5) * 25 });
        }
      }
    },
    notice(node) {
      play(node, [{ opacity: .4, translate: '0 -5px' }, { opacity: 1, translate: '0 0' }], { duration: 300 });
    },
    scrollTo(node) {
      node.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'center' });
    }
  };

  function initialize() {
    ready = true;
    document.documentElement.classList.add('motion-ready');
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        let index = 0;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          play(entry.target, [{ opacity: .15, translate: '0 16px' }, { opacity: 1, translate: '0 0' }], { duration: 560, delay: Math.min(index++, 5) * 45 });
        }
      }, { threshold: .06 });
      document.querySelectorAll('.mast,.intro,.national,.tools,.regions-heading,.region-card,.map-card,.detail,.hint,.list-head,.state-card,.footer').forEach(node => observer.observe(node));
    }

    const segments = document.querySelector('.segments');
    if (segments) {
      const indicator = document.createElement('span');
      indicator.className = 'segment-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      segments.prepend(indicator);
      segments.classList.add('has-indicator');
      const syncIndicator = () => {
        const button = segments.querySelector('button[aria-pressed="true"]');
        if (!button) return;
        indicator.style.width = `${button.offsetWidth}px`;
        indicator.style.transform = `translateX(${button.offsetLeft}px)`;
      };
      syncIndicator();
      new ResizeObserver(syncIndicator).observe(segments);
      segments.addEventListener('click', event => {
        if (!event.target.closest('button[data-mode]')) return;
        syncIndicator();
        play(document.getElementById('map-labels'), [{ opacity: .6 }, { opacity: 1 }], { duration: 250 });
      });
    }

    window.addEventListener('election-theme-change', () => {
      play(document.querySelector('.theme-moon'), [{ transform: 'rotate(-35deg) scale(.75)' }, { transform: 'rotate(0deg) scale(1)' }], { duration: 450 });
    });

    // Keep native keyboard behavior; enhance only the disclosure's click transition.
    const disclosure = document.querySelector('.regions-method');
    const summary = disclosure?.querySelector('summary');
    let disclosureAnimation = null, targetOpen = disclosure?.open;
    summary?.addEventListener('click', event => {
      if (!enabled() || typeof disclosure.animate !== 'function') return;
      event.preventDefault();
      const from = disclosure.getBoundingClientRect().height;
      targetOpen = disclosureAnimation ? !targetOpen : !disclosure.open;
      disclosureAnimation?.cancel();
      disclosure.open = true;
      const to = targetOpen ? disclosure.getBoundingClientRect().height : summary.getBoundingClientRect().height;
      disclosure.style.overflow = 'hidden';
      disclosureAnimation = play(disclosure, [{ height: `${from}px` }, { height: `${to}px` }], { duration: 320 }, () => {
        disclosure.open = targetOpen;
        disclosure.style.removeProperty('overflow');
        disclosureAnimation = null;
      });
      if (!disclosureAnimation) { disclosure.open = targetOpen; disclosure.style.removeProperty('overflow'); }
    });
  }
  if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
