/* Markup toolbar and keyboard shortcuts, shared by the in-page overlay and the editor page. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const PATHS = {
    move: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
    pen: '<path d="M4 20l1-4L16 5a2.1 2.1 0 013 3L8 19z"/><path d="M14 7l3 3"/>',
    highlight: '<path d="M9 14l-4 4v2h4l2-2"/><path d="M8 13l8-9 5 5-9 8z"/><path d="M14 20h7"/>',
    arrow: '<path d="M5 19L19 5"/><path d="M9 5h10v10"/>',
    line: '<path d="M5 19L19 5"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    text: '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
    number: '<circle cx="12" cy="12" r="9"/><path d="M10.5 9.5L13 8v8"/>',
    blur: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.500 6-11 6-11z"/><path d="M9 14a3 3 0 003 3"/>',
    pixelate: '<path d="M4 4h5v5H4zM15 4h5v5h-5zM9.500 9.500h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z"/>',
    redact: '<rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor"/>',
    spotlight: '<rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 3"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
    magnify: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M15.500 15.500L21 21M10.500 8v5M8 10.500h5"/>',
    measure: '<path d="M3 16L16 3l5 5L8 21z"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2"/>',
    emoji: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.500 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    eyedropper: '<path d="M14 6l4 4M16 3.500a2.100 2.100 0 013 3L16 10l-9 9-3 1 1-3 9-9z"/>',
    undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 016 6"/>',
    redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 00-6 6"/>',
    trash: '<path d="M4 7h16M10 3h4M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    pdf: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    fullpage: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 7v10M9 14l3 3 3-3M9 10l3-3 3 3"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    fill: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>',
    textbg: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 9V8h8v1M12 8v9"/>',
    crop: '<path d="M7 2v15h15M2 7h15v15"/>',
    rotate: '<path d="M20 12a8 8 0 11-3-6.200"/><path d="M20 3v5h-5"/>',
    sparkle: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 16v5M16.500 18.500h5"/>',
    resize: '<path d="M4 20l6-6M4 15v5h5M20 4l-6 6M15 4h5v5"/>',
    open: '<path d="M3 7a2 2 0 012-2h4l2 3h8a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/>',
    share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v8h14v-8"/>',
    history: '<path d="M4 12a8 8 0 103-6.200L4 8"/><path d="M4 3v5h5M12 8v4l3 2"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2"/>',
    zoomin: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M15.500 15.500L21 21M10.500 8v5M8 10.500h5"/>',
    zoomout: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="M15.500 15.500L21 21M8 10.500h5"/>',
    area: '<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3"/><rect x="9" y="9" width="6" height="6"/>',
    element: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/><path d="M10 10l9 3.500-4 1.500-1.500 4z"/>',
    visible: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.500 2M9 2h6"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  };

  S.icon = (name) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;

  const TOOLS = [
    ['move', 'Move / Select', 'V'],
    ['arrow', 'Arrow', 'A'],
    ['rect', 'Rectangle', 'R'],
    ['ellipse', 'Ellipse', 'O'],
    ['line', 'Line', 'L'],
    ['pen', 'Pen', 'P'],
    ['highlight', 'Highlighter', 'H'],
    ['text', 'Text', 'T'],
    ['number', 'Step numbers 1, 2, 3', 'N'],
    ['blur', 'Blur', 'B'],
    ['pixelate', 'Pixelate', 'X'],
    ['redact', 'Black out (private info)', 'K'],
    ['spotlight', 'Spotlight', 'S'],
    ['magnify', 'Magnify', 'M'],
    ['measure', 'Ruler / Measure', 'U'],
    ['emoji', 'Emoji / Sticker', 'E'],
    ['eyedropper', 'Color picker', 'I'],
  ];

  const COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#111111', '#ffffff'];
  const EMOJIS = ['👍', '👎', '✅', '❌', '⚠️', '❓', '❗', '⭐', '🔥', '❤️', '😀', '😂', '😮', '😢', '👉', '👈', '👆', '👇', '🎯', '💡', '🐞', '🔒', '📌', '✔️'];

  S.toolbarCSS = `
    .s5-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px;background:#16181d;color:#e7e9ee;
      border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:5px;box-shadow:0 12px 34px rgba(0,0,0,.45);
      font:13px/1.3 system-ui,-apple-system,"Kohinoor Bangla",sans-serif;user-select:none;position:relative}
    .s5-btn{all:unset;box-sizing:border-box;min-width:31px;height:31px;display:inline-flex;align-items:center;justify-content:center;gap:6px;
      border-radius:8px;cursor:pointer;color:inherit;position:relative}
    .s5-btn:hover{background:rgba(255,255,255,.11)}
    .s5-btn:focus-visible{outline:2px solid #818cf8}
    .s5-btn.on{background:#4f46e5;color:#fff}
    .s5-btn:disabled{opacity:.35;cursor:default;background:none}
    .s5-btn.primary{background:#16a34a;color:#fff;padding:0 12px;font-weight:600}
    .s5-btn.primary:hover{background:#15803d}
    .s5-btn.blue{background:#4f46e5;color:#fff;padding:0 12px;font-weight:600}
    .s5-btn.blue:hover{background:#4338ca}
    .s5-btn.danger:hover{background:#dc2626;color:#fff}
    .s5-btn[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%);
      white-space:nowrap;background:#000;color:#fff;padding:5px 9px;border-radius:6px;font:12px/1.3 system-ui,"Kohinoor Bangla",sans-serif;
      z-index:20;pointer-events:none}
    .s5-bar.tips-below .s5-btn[data-tip]:hover::after{bottom:auto;top:calc(100% + 9px)}
    .s5-sep{width:1px;height:21px;background:rgba(255,255,255,.14);margin:0 4px}
    .s5-swatch{width:19px;height:19px;border-radius:50%;border:2px solid rgba(255,255,255,.8);box-sizing:border-box}
    .s5-pop{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#16181d;border:1px solid rgba(255,255,255,.12);
      border-radius:12px;padding:10px;display:none;z-index:30;box-shadow:0 12px 34px rgba(0,0,0,.5);width:226px}
    .s5-pop.up{top:auto;bottom:calc(100% + 8px)}
    .s5-pop.open{display:block}
    .s5-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;justify-items:center}
    .s5-grid .s5-swatch{width:26px;height:26px;cursor:pointer;padding:0}
    .s5-grid button.emo{all:unset;cursor:pointer;font-size:21px;width:30px;height:30px;text-align:center;border-radius:6px}
    .s5-grid button.emo:hover,.s5-grid button.emo.on{background:rgba(255,255,255,.15)}
    .s5-row{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#c3c7d0}
    .s5-row input[type=range]{flex:1;accent-color:#6366f1;min-width:0}
    .s5-row input[type=color]{width:100%;height:28px;border:0;background:none;padding:0;cursor:pointer}
    .s5-range{width:78px;accent-color:#6366f1;margin:0 4px}
    .snap5-text-input{position:absolute;z-index:6;margin:0;padding:0 .3em;border:1.5px dashed #6366f1;border-radius:6px;outline:none;resize:none;
      overflow:hidden;white-space:pre;box-sizing:content-box;min-height:1.35em;transform:translate(calc(-.3em - 1.5px),-1.5px)}
  `;

  const button = (icon, tip, onClick, className = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `s5-btn ${className}`;
    b.innerHTML = S.icon(icon);
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    // Keep focus on the page/text box while clicking toolbar buttons.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  };

  const separator = () => Object.assign(document.createElement('span'), { className: 's5-sep' });

  S.createToolbar = ({ getAnnotator, actions, onStyle }) => {
    const bar = document.createElement('div');
    bar.className = 's5-bar';
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    const annotator = () => getAnnotator();
    const toolButtons = {};
    const popups = [];

    const popover = (anchor) => {
      const pop = document.createElement('div');
      pop.className = 's5-pop';
      popups.push(pop);
      const wrap = document.createElement('span');
      wrap.style.cssText = 'position:relative;display:inline-flex';
      wrap.append(anchor, pop);
      return { wrap, pop };
    };
    const togglePop = (pop, force) => {
      const open = force ?? !pop.classList.contains('open');
      popups.forEach((p) => p.classList.remove('open'));
      if (!open) return;
      pop.classList.remove('up');
      pop.classList.add('open');
      if (pop.getBoundingClientRect().bottom > innerHeight - 4) pop.classList.add('up');
    };
    const style = (patch) => {
      annotator().setStyle(patch);
      onStyle?.(annotator().style);
    };

    let emojiPop;
    for (const [id, label, key] of TOOLS) {
      const b = button(id, `${label}  (${key})`, () => {
        annotator().setTool(id);
        if (id === 'emoji') togglePop(emojiPop, true);
        else togglePop(null, false);
      });
      toolButtons[id] = b;
      if (id === 'emoji') {
        const { wrap, pop } = popover(b);
        emojiPop = pop;
        const grid = document.createElement('div');
        grid.className = 's5-grid';
        for (const emoji of EMOJIS) {
          const e = document.createElement('button');
          e.type = 'button';
          e.className = 'emo';
          e.textContent = emoji;
          e.addEventListener('click', () => {
            style({ emoji });
            togglePop(pop, false);
          });
          grid.append(e);
        }
        pop.append(grid);
        bar.append(wrap);
      } else bar.append(b);
    }
    bar.append(separator());

    /* colour + size */
    const colorButton = button('move', 'Color and size', () => togglePop(colorPop));
    colorButton.innerHTML = '<span class="s5-swatch"></span>';
    const { wrap: colorWrap, pop: colorPop } = popover(colorButton);
    const grid = document.createElement('div');
    grid.className = 's5-grid';
    for (const color of COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 's5-swatch';
      sw.style.background = color;
      sw.setAttribute('aria-label', color);
      sw.addEventListener('pointerdown', (e) => e.preventDefault());
      sw.addEventListener('click', () => {
        style({ color });
        togglePop(colorPop, false);
      });
      grid.append(sw);
    }
    const row = (label, input) => {
      const r = document.createElement('label');
      r.className = 's5-row';
      const span = document.createElement('span');
      span.textContent = label;
      r.append(span, input);
      return r;
    };
    const custom = Object.assign(document.createElement('input'), { type: 'color' });
    custom.addEventListener('change', () => style({ color: custom.value }));
    const size = Object.assign(document.createElement('input'), { type: 'range', min: 1, max: 24, step: 1 });
    size.addEventListener('change', () => style({ size: +size.value }));
    const font = Object.assign(document.createElement('input'), { type: 'range', min: 10, max: 96, step: 1 });
    font.addEventListener('change', () => style({ fontSize: +font.value }));
    colorPop.append(grid, row('Custom', custom), row('Width  [ ]', size), row('Font', font));
    bar.append(colorWrap);

    const fillButton = button('fill', 'Filled shape  (F)', () => style({ filled: !annotator().style.filled }));
    const bgButton = button('textbg', 'Text background  (G)', () => style({ textBg: !annotator().style.textBg }));
    bar.append(fillButton, bgButton, separator());

    const undo = button('undo', 'Undo  (⌘Z)', () => annotator().undo());
    const redo = button('redo', 'Redo  (⌘⇧Z)', () => annotator().redo());
    const clear = button('trash', 'Delete selected, or clear all  (⌫)', () => annotator().deleteSelected() || annotator().clearAll());
    bar.append(undo, redo, clear);

    if (actions.length) bar.append(separator());
    for (const action of actions) {
      if (action.separator) {
        bar.append(separator());
        continue;
      }
      const b = button(action.icon, action.tip, action.onClick, action.className || '');
      if (action.label) b.append(Object.assign(document.createElement('span'), { textContent: action.label }));
      if (action.id) b.dataset.action = action.id;
      bar.append(b);
    }
    for (const [id, b] of Object.entries(toolButtons)) b.dataset.tool = id;

    bar.refresh = (a = annotator()) => {
      for (const [id, b] of Object.entries(toolButtons)) b.classList.toggle('on', a.tool === id);
      colorButton.firstElementChild.style.background = a.style.color;
      toolButtons.emoji.title = a.style.emoji;
      custom.value = a.style.color;
      size.value = a.style.size;
      font.value = a.style.fontSize;
      fillButton.classList.toggle('on', a.style.filled);
      bgButton.classList.toggle('on', a.style.textBg);
      undo.disabled = !a.undoStack.length;
      redo.disabled = !a.redoStack.length;
      clear.disabled = !a.objects.length;
    };
    bar.closePopups = () => togglePop(null, false);
    return bar;
  };

  /* Tool shortcuts use event.code so they work with a Bangla keyboard layout too. */
  S.handleEditorKey = (event, annotator, onStyle) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.code === 'KeyZ') {
      event.shiftKey ? annotator.redo() : annotator.undo();
      return true;
    }
    if (mod && event.code === 'KeyY') {
      annotator.redo();
      return true;
    }
    if (mod && event.code === 'KeyD' && annotator.selected) {
      annotator.duplicate();
      return true;
    }
    if (mod || event.altKey) return false;
    if (event.key === 'Delete' || event.key === 'Backspace') return annotator.deleteSelected();
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key] && annotator.selected) {
      const step = event.shiftKey ? 10 : 1;
      return annotator.nudge(arrows[event.key][0] * step, arrows[event.key][1] * step);
    }
    const apply = (patch) => {
      annotator.setStyle(patch);
      onStyle?.(annotator.style);
    };
    if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
      const d = event.code === 'BracketRight' ? 1 : -1;
      apply({
        size: Math.max(1, Math.min(24, annotator.style.size + d)),
        fontSize: Math.max(10, Math.min(96, annotator.style.fontSize + d * 2)),
      });
      return true;
    }
    if (event.code === 'KeyF') {
      apply({ filled: !annotator.style.filled });
      return true;
    }
    if (event.code === 'KeyG') {
      apply({ textBg: !annotator.style.textBg });
      return true;
    }
    const tool = TOOLS.find(([, , key]) => event.code === `Key${key}`);
    if (tool) {
      annotator.setTool(tool[0]);
      return true;
    }
    return false;
  };

  /* Remembers colour, size and other style choices between captures. */
  S.loadStyle = async () => (await chrome.storage.local.get('style')).style || {};
  S.saveStyle = (style) => chrome.storage.local.set({ style });
})();
