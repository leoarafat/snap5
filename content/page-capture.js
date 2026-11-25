/* Page side of the full-page capture: picks the scroller, scrolls it and tames sticky elements. */
(() => {
  const S = (globalThis.Snap5 ||= {});
  let session = null;

  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Apps like dashboards and chat tools scroll an inner box instead of the window. */
  const findInnerScroller = () => {
    let best = null;
    let bestScore = 0;
    for (const node of document.querySelectorAll('body, body *')) {
      if (node.scrollHeight <= node.clientHeight + 40) continue;
      if (node.clientHeight < innerHeight * 0.4 || node.clientWidth < innerWidth * 0.4) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) continue;
      const score = node.clientWidth * node.clientHeight;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  };

  const override = (node, property, value) => {
    session.undo.push([node, property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]);
    node.style.setProperty(property, value, 'important');
  };

  const scrollInfo = () => {
    const s = session;
    if (s.inner) return { top: s.inner.scrollTop, height: s.inner.scrollHeight };
    const root = document.scrollingElement || document.documentElement;
    return { top: root.scrollTop, height: root.scrollHeight };
  };

  const scrollToY = (y) => (session.inner ? session.inner.scrollTo({ top: y, behavior: 'instant' }) : window.scrollTo({ left: session.x, top: y, behavior: 'instant' }));

  /* Fixed bars would repeat in every slice: show top bars once at the start, bottom bars once at the end. */
  const tame = ({ first, last }) => {
    for (const node of document.querySelectorAll('body *')) {
      if (node.localName === 'snap5-root') continue;
      const style = getComputedStyle(node);
      if (style.position === 'sticky') {
        if (!session.sticky.has(node)) {
          session.sticky.add(node);
          override(node, 'position', 'relative');
          for (const side of ['top', 'bottom', 'left', 'right']) override(node, side, 'auto');
        }
      } else if (style.position === 'fixed' && !session.fixed.has(node)) {
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (session.inner && node.contains(session.inner)) continue;
        // Full-height layers (app shells, sidebars) must stay put.
        if (r.height >= innerHeight * 0.9) continue;
        session.fixed.set(node, { bottom: r.top > innerHeight / 2, original: node.style.getPropertyValue('visibility'), priority: node.style.getPropertyPriority('visibility') });
      }
    }
    for (const [node, meta] of session.fixed) {
      const show = meta.bottom ? last : first;
      if (show) node.style.setProperty('visibility', meta.original, meta.priority);
      else node.style.setProperty('visibility', 'hidden', 'important');
    }
  };

  const prepare = async () => {
    await S.ui.hideTransient();
    const root = document.scrollingElement || document.documentElement;
    const height = root.scrollHeight;
    const overflow = [document.documentElement, document.body].map((n) => n && getComputedStyle(n).overflowY);
    const windowScrolls = height > innerHeight + 4 && !overflow.includes('hidden');
    const inner = windowScrolls ? null : findInnerScroller();

    session = { inner, undo: [], fixed: new Map(), sticky: new Set(), x: window.scrollX, startY: 0, cancelled: false };
    session.startY = scrollInfo().top;

    const css = document.createElement('style');
    css.textContent = `*{scroll-behavior:auto!important;scroll-snap-type:none!important}
      ::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}
      *,*::before,*::after{transition:none!important;caret-color:transparent!important}`;
    document.documentElement.append(css);
    session.css = css;

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      session.cancelled = true;
      chrome.runtime.sendMessage({ type: 'fp-cancel' });
    };
    window.addEventListener('keydown', onKey, true);
    session.onKey = onKey;
    await frames();

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    let area = { x: 0, y: 0, w: viewW, h: viewH };
    if (inner) {
      const r = inner.getBoundingClientRect();
      const x = Math.max(0, r.left + inner.clientLeft);
      const y = Math.max(0, r.top + inner.clientTop);
      area = { x, y, w: Math.min(viewW - x, inner.clientWidth), h: Math.min(viewH - y, inner.clientHeight) };
    }

    const opaque = (n) => {
      const c = n && getComputedStyle(n).backgroundColor;
      return c && c !== 'transparent' && !/,\s*0\)$/.test(c) ? c : null;
    };

    return {
      inner: !!inner,
      viewW,
      viewH,
      area,
      scrollHeight: windowScrolls || inner ? scrollInfo().height : viewH,
      background: opaque(document.body) || opaque(document.documentElement) || '#ffffff',
    };
  };

  const scroll = async ({ y, first, last, delay }) => {
    if (!session) return { cancelled: true };
    scrollToY(y);
    await frames();
    tame({ first, last });
    // Give lazy images time to load.
    await wait(delay);
    const pending = [...document.images].filter((i) => {
      const r = i.getBoundingClientRect();
      return !i.complete && r.bottom > 0 && r.top < innerHeight;
    });
    if (pending.length) {
      await Promise.race([wait(1200), Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); })))]);
    }
    await frames();
    const info = scrollInfo();
    return { y: info.top, scrollHeight: info.height, cancelled: session.cancelled };
  };

  const restore = () => {
    if (!session) return;
    for (const [node, property, value, priority] of session.undo.reverse()) node.style.setProperty(property, value, priority);
    for (const [node, meta] of session.fixed) node.style.setProperty('visibility', meta.original, meta.priority);
    session.css.remove();
    window.removeEventListener('keydown', session.onKey, true);
    scrollToY(session.startY);
    session = null;
    S.ui.showPins();
  };

  S.pageCapture = { prepare, scroll, restore };
})();
