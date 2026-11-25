/* In-page UI host (shadow DOM in the top layer): toasts, countdown and pinned images. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    .toast{position:fixed;right:18px;bottom:18px;width:366px;background:#16181d;color:#eef0f4;border:1px solid rgba(255,255,255,.12);
      border-radius:14px;padding:12px;box-shadow:0 18px 50px rgba(0,0,0,.5);font:13px/1.45 system-ui,-apple-system,"Kohinoor Bangla",sans-serif;
      pointer-events:auto;animation:in .18s ease-out}
    @keyframes in{from{opacity:0;transform:translateY(10px)}}
    .toast h4{margin:0 0 2px;font-size:14px}
    .toast p{margin:0;color:#a9aebb}
    .toast img{width:100%;max-height:170px;object-fit:cover;object-position:top;border-radius:8px;margin-top:9px;display:block;background:#fff}
    .toast .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
    .toast button{all:unset;cursor:pointer;padding:6px 11px;border-radius:8px;background:rgba(255,255,255,.1);font-size:12.5px}
    .toast button:hover{background:rgba(255,255,255,.18)}
    .toast button.main{background:#4f46e5;color:#fff}
    .toast button.x{position:absolute;right:8px;top:8px;padding:2px 8px;background:none;font-size:16px}
    .countdown{position:fixed;right:24px;top:24px;width:96px;height:96px;border-radius:50%;background:rgba(22,24,29,.88);color:#fff;
      display:flex;flex-direction:column;align-items:center;justify-content:center;font:700 40px/1 system-ui;pointer-events:auto;cursor:pointer}
    .countdown small{font:11px system-ui,"Kohinoor Bangla";opacity:.75;margin-top:4px}
    .pin{position:fixed;background:#16181d;border-radius:10px;box-shadow:0 18px 55px rgba(0,0,0,.5);pointer-events:auto;overflow:hidden;
      resize:horizontal;min-width:140px;max-width:96vw;border:1px solid rgba(255,255,255,.18)}
    .pin header{display:flex;gap:4px;justify-content:flex-end;padding:4px;cursor:grab;color:#fff;font:12px system-ui;touch-action:none}
    .pin header span{margin-right:auto;padding:3px 6px;opacity:.7;white-space:nowrap}
    .pin header button{all:unset;cursor:pointer;padding:3px 8px;border-radius:6px;font:12px system-ui,"Kohinoor Bangla"}
    .pin header button:hover{background:rgba(255,255,255,.18)}
    .pin img{display:block;width:100%;max-height:80vh;object-fit:contain}
  `;

  let host;
  let root;

  const mount = () => {
    if (!host) {
      host = document.createElement('snap5-root');
      // `popover` puts the UI in the top layer, above any z-index on the page.
      host.setAttribute('popover', 'manual');
      host.style.cssText =
        'all:initial;position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647';
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS + S.toolbarCSS;
      root.append(style);
    }
    // A modal <dialog> makes everything outside it inert, so live inside it in that case.
    const parent = document.querySelector('dialog:modal') || document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    return root;
  };

  const raise = () => {
    mount();
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {}
  };

  const element = (tag, props = {}, ...children) => {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children);
    return el;
  };

  let toastEl;
  let toastTimer;
  const dismissToast = () => {
    clearTimeout(toastTimer);
    toastEl?.remove();
    toastEl = null;
  };

  const toast = ({ title, text = '', thumb, actions = [], timeout = 7000 }) => {
    raise();
    dismissToast();
    const box = element('div', { className: 'toast' });
    box.setAttribute('role', 'status');
    box.append(element('button', { className: 'x', textContent: '×', onclick: dismissToast, title: 'Close' }));
    box.append(element('h4', { textContent: title }));
    if (text) box.append(element('p', { textContent: text }));
    if (thumb) box.append(element('img', { src: thumb, alt: '' }));
    if (actions.length) {
      const row = element('div', { className: 'row' });
      for (const a of actions) {
        row.append(element('button', {
          textContent: a.label,
          className: a.main ? 'main' : '',
          onclick: async () => {
            await a.onClick();
            if (!a.keep) dismissToast();
          },
        }));
      }
      box.append(row);
    }
    root.append(box);
    toastEl = box;
    const arm = () => {
      clearTimeout(toastTimer);
      if (timeout) toastTimer = setTimeout(dismissToast, timeout);
    };
    box.addEventListener('pointerenter', () => clearTimeout(toastTimer));
    box.addEventListener('pointerleave', arm);
    arm();
  };

  const countdown = (seconds) =>
    new Promise((resolve) => {
      raise();
      dismissToast();
      const label = element('span', { textContent: String(seconds) });
      const box = element('div', { className: 'countdown' }, label, element('small', { textContent: 'click to cancel' }));
      root.append(box);
      let left = seconds;
      const finish = (cancelled) => {
        clearInterval(timer);
        box.remove();
        // Wait for the circle to disappear before the screenshot is taken.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ cancelled })));
      };
      const timer = setInterval(() => {
        left -= 1;
        label.textContent = String(left);
        if (left <= 0) finish(false);
      }, 1000);
      box.addEventListener('click', () => finish(true));
    });

  const pin = (dataUrl, rect) => {
    raise();
    const width = Math.min(rect?.w || 360, innerWidth * 0.8);
    const box = element('div', { className: 'pin' });
    box.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect?.x ?? 40))}px`;
    box.style.top = `${Math.max(8, Math.min(innerHeight - 160, rect?.y ?? 40))}px`;
    box.style.width = `${width}px`;
    const copy = element('button', {
      textContent: 'Copy',
      onclick: async () => {
        try {
          await S.exporter.copyImage(S.exporter.dataUrlToBlob(dataUrl));
          copy.textContent = '✓ Copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      },
    });
    const header = element('header', {}, element('span', { textContent: '📌 Drag to move' }), copy,
      element('button', { textContent: '✕', title: 'Close', onclick: () => box.remove() }));
    let from = null;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      from = { x: e.clientX - box.offsetLeft, y: e.clientY - box.offsetTop };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!from) return;
      box.style.left = `${e.clientX - from.x}px`;
      box.style.top = `${e.clientY - from.y}px`;
    });
    header.addEventListener('pointerup', () => (from = null));
    box.append(header, element('img', { src: dataUrl, alt: 'Pinned screenshot' }));
    root.append(box);
  };

  const hideTransient = () => {
    dismissToast();
    // Pinned images stay out of new screenshots.
    root?.querySelectorAll('.pin').forEach((p) => (p.style.visibility = 'hidden'));
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  const showPins = () => root?.querySelectorAll('.pin').forEach((p) => (p.style.visibility = ''));

  S.ui = { mount, raise, element, toast, dismissToast, countdown, pin, hideTransient, showPins, get host() { return host; } };
})();
