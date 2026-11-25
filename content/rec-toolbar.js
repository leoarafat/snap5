/* Floating recording controls, on-screen drawing, click highlight and shortcut display.
   Injected into the visible tab only while a recording is running. */
(() => {
  if (globalThis.__snap5Rec) return;
  globalThis.__snap5Rec = true;

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box}
    canvas{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none}
    canvas.drawing{pointer-events:auto;cursor:crosshair;touch-action:none}
    .bar{position:fixed;display:flex;align-items:center;gap:4px;background:rgba(20,22,28,.95);color:#fff;border-radius:30px;padding:5px 7px;
      box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:auto;font:13px/1 system-ui,-apple-system,sans-serif;user-select:none;cursor:grab;touch-action:none;white-space:nowrap}
    button{all:unset;cursor:pointer;min-width:30px;height:30px;padding:0 9px;border-radius:16px;display:inline-flex;align-items:center;justify-content:center}
    button:hover{background:rgba(255,255,255,.14)}
    button.on{background:#4f46e5}
    button.stop{background:#dc2626;font-weight:700}
    .dot{width:10px;height:10px;border-radius:50%;background:#ef4444;margin:0 4px 0 6px;animation:blink 1.1s infinite}
    .paused .dot{background:#f59e0b;animation:none}
    @keyframes blink{50%{opacity:.25}}
    .time{font:600 14px ui-monospace,Menlo,monospace;min-width:48px;margin-right:4px}
    .tools{display:none;align-items:center;gap:3px;padding-left:6px;border-left:1px solid rgba(255,255,255,.2)}
    .tools.open{display:flex}
    .swatch{min-width:18px;width:18px;height:18px;padding:0;border:2px solid rgba(255,255,255,.55);border-radius:50%}
    .swatch.on{border-color:#fff;box-shadow:0 0 0 2px #4f46e5}
    .mini .full{display:none}
    .ripple{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid #facc15;background:rgba(250,204,21,.3);pointer-events:none;animation:ripple .55s ease-out forwards}
    @keyframes ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1.25);opacity:0}}
    .keys{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:rgba(20,22,28,.92);color:#fff;border-radius:12px;padding:10px 20px;font:700 22px system-ui;pointer-events:none}
    .count{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:190px;height:190px;border-radius:50%;background:rgba(20,22,28,.85);color:#fff;display:flex;align-items:center;justify-content:center;font:800 96px system-ui}
  `;

  const COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff'];
  const KEY_NAMES = { Enter: '⏎ Enter', Escape: 'Esc', Tab: '⇥ Tab', Backspace: '⌫', Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'Page Up', PageDown: 'Page Down', Home: 'Home', End: 'End' };

  let state = null;
  let received = 0;
  let host;
  let root;
  let ui;
  let timer;
  let keyTimer;
  let drawing = false;
  let tool = 'pen';
  let color = COLORS[0];
  let fade = true;
  let mini = false;
  let shapes = [];
  let active = null;
  let frame = 0;

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  const send = (cmd) => alive() && chrome.runtime.sendMessage({ type: 'rec-cmd', cmd }).catch(() => {});

  const make = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const button = (text, title, onClick, className = 'full') => {
    const b = make('button', { type: 'button', textContent: text, title, className });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', onClick);
    return b;
  };

  /* ---------- drawing ---------- */

  const paint = () => {
    frame = 0;
    if (!ui) return;
    const { canvas } = ui;
    const dpr = devicePixelRatio;
    if (canvas.width !== Math.round(innerWidth * dpr) || canvas.height !== Math.round(innerHeight * dpr)) {
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    const now = performance.now();
    shapes = shapes.filter((s) => !(s.fade && s !== active && now - s.done > 3500));
    for (const s of shapes) {
      g.save();
      g.globalAlpha = s.fade && s !== active ? Math.min(1, Math.max(0, (3500 - (now - s.done)) / 800)) : 1;
      g.strokeStyle = g.fillStyle = s.color;
      g.lineWidth = 5;
      g.lineCap = g.lineJoin = 'round';
      if (s.tool === 'highlight') {
        g.globalAlpha *= 0.4;
        g.lineWidth = 20;
      }
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      g.beginPath();
      if (s.tool === 'rect') g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      else if (s.tool === 'arrow') {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        g.moveTo(a.x, a.y);
        g.lineTo(b.x - Math.cos(angle) * 12, b.y - Math.sin(angle) * 12);
        g.stroke();
        g.beginPath();
        g.moveTo(b.x, b.y);
        g.lineTo(b.x - Math.cos(angle - 0.45) * 22, b.y - Math.sin(angle - 0.45) * 22);
        g.lineTo(b.x - Math.cos(angle + 0.45) * 22, b.y - Math.sin(angle + 0.45) * 22);
        g.fill();
      } else {
        g.moveTo(a.x, a.y);
        for (const p of s.points) g.lineTo(p.x + 0.01, p.y);
        g.stroke();
      }
      g.restore();
    }
    if (shapes.some((s) => s.fade)) schedule();
  };
  const schedule = () => (frame ||= requestAnimationFrame(paint));

  const setDrawing = (on) => {
    drawing = on;
    ui.canvas.classList.toggle('drawing', on);
    ui.tools.classList.toggle('open', on);
    ui.drawButton.classList.toggle('on', on);
    keepInside();
  };

  /* ---------- UI ---------- */

  const keepInside = () => {
    if (!ui) return;
    const r = ui.bar.getBoundingClientRect();
    ui.bar.style.left = `${Math.max(6, Math.min(innerWidth - r.width - 6, r.left))}px`;
    ui.bar.style.top = `${Math.max(6, Math.min(innerHeight - r.height - 6, r.top))}px`;
  };

  const build = () => {
    host = document.createElement('snap5-rec');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483646';
    root = host.attachShadow({ mode: 'open' });
    root.append(make('style', { textContent: CSS }));
    const canvas = make('canvas');
    const dot = make('span', { className: 'dot' });
    const time = make('span', { className: 'time', textContent: '00:00' });
    const pause = button('❚❚', 'Pause or resume', () => send('toggle'));
    const stop = button('■ Stop', 'Stop and save  (⌥⇧R)', () => send('stop'), 'stop');
    const mic = button('Mic', 'Mute or unmute the microphone', () => send('mic'));
    const cam = button('Cam', 'Show or hide the camera in the video', () => send('camera'));
    const drawButton = button('✏️ Draw', 'Draw on this page  (Esc to finish)', () => setDrawing(!drawing));
    const tools = make('span', { className: 'tools full' });
    const toolButtons = [['pen', '✎', 'Pen'], ['highlight', '▍', 'Highlighter'], ['arrow', '➜', 'Arrow'], ['rect', '▢', 'Box']].map(([id, text, title]) => {
      const b = button(text, title, () => {
        tool = id;
        toolButtons.forEach((x) => x.classList.toggle('on', x === b));
      }, id === tool ? 'on' : '');
      return b;
    });
    const swatches = COLORS.map((c) => {
      const b = button('', c, () => {
        color = c;
        swatches.forEach((x) => x.classList.toggle('on', x === b));
      }, `swatch${c === color ? ' on' : ''}`);
      b.style.background = c;
      return b;
    });
    const fadeButton = button('Fade', 'Drawings disappear after a few seconds', () => {
      fade = !fade;
      fadeButton.classList.toggle('on', fade);
    }, fade ? 'on' : '');
    const clear = button('Clear', 'Erase all drawings', () => {
      shapes = [];
      schedule();
    }, '');
    tools.append(...toolButtons, ...swatches, fadeButton, clear);
    const collapse = button('–', 'Shrink the controls', () => {
      mini = !mini;
      if (mini) setDrawing(false);
      ui.bar.classList.toggle('mini', mini);
      collapse.textContent = mini ? '+' : '–';
      keepInside();
    }, '');
    const bar = make('div', { className: 'bar' }, dot, time, pause, stop, mic, cam, drawButton, tools, collapse);
    bar.style.left = '18px';
    bar.style.top = `${Math.max(6, innerHeight - 62)}px`;

    let from = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.composedPath()[0].tagName === 'BUTTON') return;
      from = { x: e.clientX - bar.offsetLeft, y: e.clientY - bar.offsetTop };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!from) return;
      bar.style.left = `${e.clientX - from.x}px`;
      bar.style.top = `${e.clientY - from.y}px`;
    });
    bar.addEventListener('pointerup', () => {
      if (!from) return;
      from = null;
      keepInside();
      chrome.storage.local.set({ recBar: { x: bar.offsetLeft, y: bar.offsetTop } });
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (!drawing || e.button !== 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      active = { tool, color, fade, points: [{ x: e.clientX, y: e.clientY }], done: 0 };
      shapes.push(active);
      schedule();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!active) return;
      active.points.push({ x: e.clientX, y: e.clientY });
      schedule();
    });
    const finish = () => {
      if (!active) return;
      active.done = performance.now();
      active = null;
      schedule();
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    ui = { canvas, bar, time, pause, mic, cam, drawButton, tools };
    root.append(canvas, bar);
    chrome.storage.local.get('recBar', ({ recBar }) => {
      if (!recBar || !ui) return;
      ui.bar.style.left = `${recBar.x}px`;
      ui.bar.style.top = `${recBar.y}px`;
      keepInside();
    });
  };

  const attach = () => {
    const parent = document.querySelector('dialog:modal') || document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    try {
      if (!host.matches(':popover-open')) host.showPopover();
    } catch {}
  };

  const elapsed = () => (state.status === 'recording' ? state.elapsed + (Date.now() - received) : state.elapsed);

  const refresh = () => {
    if (!state || !ui) return;
    const total = Math.floor(elapsed() / 1000);
    ui.time.textContent = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  const teardown = () => {
    clearInterval(timer);
    host?.remove();
    host = root = ui = null;
    shapes = [];
    active = null;
    drawing = false;
    mini = false;
  };

  let countBox;
  const update = (next) => {
    state = next;
    received = Date.now();
    if (!state) return teardown();
    if (!host) build();
    attach();
    countBox?.remove();
    countBox = null;
    const counting = state.status === 'countdown';
    ui.bar.style.display = !counting && state.floating ? '' : 'none';
    if (counting) {
      countBox = make('div', { className: 'count', textContent: String(state.seconds) });
      root.append(countBox);
    }
    ui.bar.classList.toggle('paused', state.status === 'paused');
    ui.pause.textContent = state.status === 'paused' ? '▶' : '❚❚';
    ui.mic.style.display = state.mic === null ? 'none' : '';
    ui.mic.textContent = state.mic ? '🎙 On' : '🔇 Off';
    ui.cam.style.display = state.camera === null ? 'none' : '';
    ui.cam.textContent = state.camera ? '📷 On' : '📷 Off';
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 500);
  };

  /* ---------- clicks and shortcut keys ---------- */

  window.addEventListener('pointerdown', (e) => {
    if (!state?.clicks || state.status !== 'recording' || !root || e.composedPath().includes(host)) return;
    const ring = make('div', { className: 'ripple' });
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    root.append(ring);
    setTimeout(() => ring.remove(), 600);
  }, true);

  window.addEventListener('keydown', (e) => {
    if (!state || !root) return;
    if (drawing && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setDrawing(false);
      return;
    }
    if (!state.keys || state.status !== 'recording' || e.repeat) return;
    const target = e.composedPath()[0];
    if (target?.type === 'password') return;
    const modified = e.metaKey || e.ctrlKey || e.altKey;
    // Only shortcuts and navigation keys are shown, never ordinary typing.
    if (!modified && !KEY_NAMES[e.key]) return;
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    const base = KEY_NAMES[e.key] || e.code.replace(/^Key|^Digit|^Numpad/, '');
    const label = `${e.ctrlKey ? '⌃ ' : ''}${e.altKey ? '⌥ ' : ''}${e.shiftKey ? '⇧ ' : ''}${e.metaKey ? '⌘ ' : ''}${base}`;
    root.querySelector('.keys')?.remove();
    const badge = make('div', { className: 'keys', textContent: label });
    root.append(badge);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => badge.remove(), 1400);
  }, true);

  window.addEventListener('resize', () => {
    keepInside();
    schedule();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'rec-ui' || sender.id !== chrome.runtime.id) return false;
    update(message.state);
    sendResponse({ ok: true });
    return false;
  });
})();
