/* Area / element selection over a frozen screenshot, with in-place markup. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  const CSS = `
    .ov{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;overflow:hidden;outline:none;user-select:none;touch-action:none;
      font:13px/1.4 system-ui,-apple-system,"Kohinoor Bangla",sans-serif;color:#fff}
    .ov canvas.main{position:absolute;left:0;top:0;display:block}
    .shade{position:absolute;background:rgba(8,10,18,.5);pointer-events:none}
    .sel{position:absolute;border:1.5px solid #fff;outline:1px solid rgba(79,70,229,.95);pointer-events:none}
    .sel.hover{border:2px solid #818cf8;background:rgba(99,102,241,.1);outline:none}
    .grip{position:absolute;width:11px;height:11px;background:#fff;border:2px solid #4f46e5;border-radius:50%;pointer-events:auto}
    .dims{position:absolute;background:#111827;padding:2px 8px;border-radius:6px;font:12px ui-monospace,Menlo,monospace;pointer-events:none;white-space:nowrap}
    .hint{position:absolute;left:50%;top:14px;transform:translateX(-50%);background:rgba(17,24,39,.93);border-radius:12px;padding:8px 10px 8px 14px;
      display:flex;gap:10px;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.4);white-space:nowrap;cursor:default;max-width:96vw}
    .hint kbd{background:rgba(255,255,255,.15);border-radius:5px;padding:1px 6px;font:11px ui-monospace,Menlo,monospace}
    .hint button{all:unset;cursor:pointer;background:rgba(255,255,255,.12);padding:5px 10px;border-radius:8px}
    .hint button:hover{background:#4f46e5}
    .loupe{position:absolute;width:132px;border-radius:10px;overflow:hidden;background:#111827;box-shadow:0 8px 26px rgba(0,0,0,.5);pointer-events:none}
    .loupe canvas{display:block;width:132px;height:100px}
    .loupe div{padding:4px 6px;font:11px/1.5 ui-monospace,Menlo,monospace;text-align:center}
    .cross{position:absolute;background:rgba(255,255,255,.55);pointer-events:none;mix-blend-mode:difference}
    .barwrap{position:absolute;display:flex;justify-content:center;cursor:default;width:max-content;max-width:min(640px,calc(100vw - 16px))}
  `;

  let current = null;

  const start = async ({ dataUrl, preset = 'area', id, title = '' }) => {
    if (current) return;
    const ui = S.ui;
    const root = ui.mount();
    const settings = await S.getSettings();
    const savedStyle = await S.loadStyle();
    const image = await S.exporter.loadImage(dataUrl);
    const W = innerWidth;
    const H = innerHeight;
    const unit = image.naturalWidth / W;
    const previousFocus = document.activeElement;

    const el = (className, parent, tag = 'div') => {
      const node = document.createElement(tag);
      node.className = className;
      parent?.append(node);
      return node;
    };

    const style = el('', null, 'style');
    style.textContent = CSS;
    const ov = el('ov');
    ov.tabIndex = -1;
    const canvas = el('main', ov, 'canvas');
    canvas.style.width = `${W}px`;
    canvas.style.height = `${(image.naturalHeight / image.naturalWidth) * W}px`;
    const shades = [0, 1, 2, 3].map(() => el('shade', ov));
    const crossX = el('cross', ov);
    const crossY = el('cross', ov);
    const selBox = el('sel', ov);
    const dims = el('dims', ov);
    const grips = ['nw', 'nm', 'ne', 'mw', 'me', 'sw', 'sm', 'se'].map((pos) => {
      const g = el('grip', ov);
      g.dataset.grip = pos;
      g.style.cursor = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', nm: 'ns-resize', sm: 'ns-resize', mw: 'ew-resize', me: 'ew-resize' }[pos];
      return g;
    });
    const hint = el('hint', ov);
    const loupe = el('loupe', ov);
    const loupeCanvas = el('', loupe, 'canvas');
    loupeCanvas.width = 264;
    loupeCanvas.height = 200;
    const loupeText = el('', loupe);

    let sel = null;
    let drag = null;
    let hoverRect = null;
    let pointer = { x: W / 2, y: H / 2, color: '#000000' };
    let busy = false;
    let aimed = false;
    let annotator;
    let bar;
    const barWrap = el('barwrap', ov);

    const closeOverlay = () => {
      if (!current) return;
      current = null;
      window.__snap5KeyHandler = null;
      window.removeEventListener('resize', onResize);
      ov.remove();
      style.remove();
      ui.showPins();
      previousFocus?.focus?.({ preventScroll: true });
    };

    const onResize = () => closeOverlay();

    /* ---------- output ---------- */

    const region = () => ({ x: sel.x * unit, y: sel.y * unit, w: sel.w * unit, h: sel.h * unit });
    const result = () => annotator.export(region());

    const send = (message) => chrome.runtime.sendMessage(message);
    const history = (canvasOut) => send({ type: 'history-add', dataUrl: canvasOut.toDataURL('image/png') }).catch(() => {});

    const guard = (fn) => async () => {
      if (!sel || busy) return;
      busy = true;
      try {
        await fn();
      } catch (error) {
        ui.toast({ title: 'Something went wrong', text: error.message });
      } finally {
        busy = false;
      }
    };

    const copy = guard(async () => {
      const out = result();
      try {
        await S.exporter.copyImage(S.exporter.toBlob(out, 'png'));
      } catch {
        // Plain http pages block the clipboard: finish the copy in our editor tab.
        await send({ type: 'open-editor', dataUrl: out.toDataURL('image/png'), copy: true });
        closeOverlay();
        return;
      }
      if (settings.sound) S.exporter.shutter();
      history(out);
      const url = out.toDataURL('image/png');
      if (settings.closeAfterCopy) closeOverlay();
      ui.toast({
        title: '✅ Copied',
        text: 'Now paste it anywhere with ⌘V',
        thumb: url,
        timeout: 3500,
        actions: [
          { label: 'Download', onClick: () => send({ type: 'download', dataUrl: url, filename: S.fileName(settings, 'png', title) }) },
          { label: 'Open in editor', onClick: () => send({ type: 'open-editor', dataUrl: url }) },
        ],
      });
    });

    const download = (saveAs = false) => guard(async () => {
      const out = result();
      const blob = await S.exporter.toBlob(out, settings.format, settings.jpgQuality);
      const response = await send({
        type: 'download',
        dataUrl: await S.exporter.blobToDataUrl(blob),
        filename: S.fileName(settings, settings.format, title),
        saveAs,
      });
      if (response?.ok === false) throw new Error(response.error);
      history(out);
      closeOverlay();
      ui.toast({ title: '⬇️ Downloaded', text: 'Check your Downloads folder', timeout: 2500 });
    });

    const savePdf = guard(async () => {
      const out = result();
      const pdf = await S.exporter.toPdf(out);
      await send({ type: 'download', dataUrl: await S.exporter.blobToDataUrl(pdf), filename: S.fileName(settings, 'pdf', title) });
      history(out);
      closeOverlay();
      ui.toast({ title: '⬇️ PDF downloaded', timeout: 2500 });
    });

    const openEditor = guard(async () => {
      const dataUrl = result().toDataURL('image/png');
      closeOverlay();
      await send({ type: 'open-editor', dataUrl });
    });

    const pinIt = guard(async () => {
      const url = result().toDataURL('image/png');
      const rect = { ...sel };
      closeOverlay();
      ui.pin(url, rect);
    });

    const fullPage = () => {
      closeOverlay();
      send({ type: 'capture', mode: 'full' });
    };

    /* ---------- layout ---------- */

    const place = (node, x, y, w, h) => {
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      if (w !== undefined) {
        node.style.width = `${Math.max(0, w)}px`;
        node.style.height = `${Math.max(0, h)}px`;
      }
    };

    const layout = () => {
      const r = sel || hoverRect;
      const selecting = drag?.kind === 'new';
      if (r) {
        place(shades[0], 0, 0, W, r.y);
        place(shades[1], 0, r.y + r.h, W, H - r.y - r.h);
        place(shades[2], 0, r.y, r.x, r.h);
        place(shades[3], r.x + r.w, r.y, W - r.x - r.w, r.h);
        selBox.style.display = '';
        selBox.classList.toggle('hover', !sel);
        place(selBox, r.x, r.y, r.w, r.h);
        dims.style.display = '';
        dims.textContent = `${Math.round(r.w * unit)} × ${Math.round(r.h * unit)}`;
        place(dims, Math.max(4, Math.min(W - 110, r.x)), r.y >= 28 ? r.y - 26 : r.y + 6);
      } else {
        place(shades[0], 0, 0, W, H);
        for (const s of shades.slice(1)) place(s, 0, 0, 0, 0);
        selBox.style.display = 'none';
        dims.style.display = 'none';
      }
      const ready = !!sel && !selecting;
      for (const g of grips) {
        g.style.display = ready && annotator.tool === 'move' ? '' : 'none';
        if (!sel) continue;
        const [v, hz] = g.dataset.grip;
        place(g, sel.x + { w: 0, m: sel.w / 2, e: sel.w }[hz] - 5.5, sel.y + { n: 0, m: sel.h / 2, s: sel.h }[v] - 5.5);
      }
      hint.style.display = sel ? 'none' : '';
      const showAim = !sel || selecting || drag?.kind === 'grip';
      loupe.style.display = showAim && aimed ? '' : 'none';
      crossX.style.display = crossY.style.display = !sel && aimed ? '' : 'none';
      barWrap.style.display = ready && (!drag || drag.kind === 'draw') ? 'flex' : 'none';
      if (ready) {
        barWrap.style.left = '8px';
        const bw = barWrap.offsetWidth;
        const bh = barWrap.offsetHeight || 80;
        let top = sel.y + sel.h + 10;
        if (top + bh > H - 6) top = sel.y - bh - 32;
        if (top < 6) top = Math.max(6, H - bh - 12);
        place(barWrap, Math.max(8, Math.min(W - bw - 8, sel.x + sel.w - bw)), top);
        bar.classList.toggle('tips-below', top < 60);
      }
    };

    const updateLoupe = () => {
      const g = loupeCanvas.getContext('2d');
      const ix = Math.floor(pointer.x * unit);
      const iy = Math.floor(pointer.y * unit);
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#000';
      g.fillRect(0, 0, 264, 200);
      g.drawImage(image, ix - 16, iy - 12, 33, 25, 0, 0, 264, 200);
      const sample = document.createElement('canvas');
      sample.width = sample.height = 1;
      const sg = sample.getContext('2d', { willReadFrequently: true });
      sg.drawImage(image, ix, iy, 1, 1, 0, 0, 1, 1);
      const d = sg.getImageData(0, 0, 1, 1).data;
      pointer.color = '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      g.strokeStyle = '#6366f1';
      g.lineWidth = 2;
      g.strokeRect(128, 96, 8, 8);
      loupeText.textContent = `${ix}, ${iy}  ${pointer.color.toUpperCase()} · C`;
      place(loupe, pointer.x + 160 > W ? pointer.x - 150 : pointer.x + 18, pointer.y + 165 > H ? pointer.y - 155 : pointer.y + 18);
      place(crossX, 0, pointer.y, W, 1);
      place(crossY, pointer.x, 0, 1, H);
    };

    /* Element under the pointer, so a single click grabs a card, image, table and so on. */
    const elementRect = (x, y) => {
      const hostEl = ui.host;
      const found = document.elementsFromPoint(x, y).find((n) => n !== hostEl && n !== document.documentElement && n !== document.body);
      if (!found) return { x: 0, y: 0, w: W, h: H };
      let target = found;
      // Descend into open shadow roots.
      while (target.shadowRoot) {
        const inner = target.shadowRoot.elementsFromPoint(x, y).find((n) => n !== target && target.shadowRoot.contains(n));
        if (!inner) break;
        target = inner;
      }
      const r = target.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const w = Math.min(W, r.right) - left;
      const h = Math.min(H, r.bottom) - top;
      return w >= 6 && h >= 6 ? { x: left, y: top, w, h } : { x: 0, y: 0, w: W, h: H };
    };

    const rectFrom = (a, b, square) => {
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      if (square) {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        dx = side * Math.sign(dx || 1);
        dy = side * Math.sign(dy || 1);
      }
      const x = Math.max(0, Math.min(a.x, a.x + dx));
      const y = Math.max(0, Math.min(a.y, a.y + dy));
      return { x, y, w: Math.min(W, Math.max(a.x, a.x + dx)) - x, h: Math.min(H, Math.max(a.y, a.y + dy)) - y };
    };

    const point = (e) => ({ x: Math.max(0, Math.min(W, e.clientX)), y: Math.max(0, Math.min(H, e.clientY)) });

    const insideSel = (p) => sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h;

    const selectAll = () => {
      sel = { x: 0, y: 0, w: W, h: H };
      layout();
    };

    ov.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (sel && !annotator.objects.length) {
        sel = null;
        layout();
        updateLoupe();
      } else closeOverlay();
    });

    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.composedPath().includes(hint) || e.composedPath().includes(barWrap)) return;
      e.preventDefault();
      bar.closePopups();
      ov.setPointerCapture(e.pointerId);
      const p = point(e);
      const grip = e.target.dataset?.grip;
      if (grip) {
        drag = { kind: 'grip', grip, start: { ...sel } };
      } else if (sel && (insideSel(p) || annotator.editing)) {
        if (annotator.down(e)) drag = { kind: 'draw' };
        else drag = { kind: 'move', from: p, start: { ...sel } };
      } else if (!sel || (!annotator.objects.length && annotator.tool === 'move')) {
        drag = { kind: 'new', from: p, moved: false };
        sel = null;
      }
      layout();
    });

    ov.addEventListener('pointermove', (e) => {
      const p = point(e);
      pointer.x = p.x;
      pointer.y = p.y;
      aimed = true;
      if (!drag) {
        if (!sel) {
          hoverRect = e.composedPath().includes(hint) ? null : elementRect(p.x, p.y);
          updateLoupe();
          layout();
        } else {
          ov.style.cursor = insideSel(p) ? annotator.cursorFor(annotator.toImage(e)) || 'move' : annotator.tool === 'move' && !annotator.objects.length ? 'crosshair' : 'default';
        }
        return;
      }
      if (drag.kind === 'new') {
        if (!drag.moved && Math.hypot(p.x - drag.from.x, p.y - drag.from.y) < 4) return;
        drag.moved = true;
        sel = rectFrom(drag.from, p, e.shiftKey);
        updateLoupe();
      } else if (drag.kind === 'draw') {
        annotator.move(e);
        return;
      } else if (drag.kind === 'move') {
        sel = {
          ...drag.start,
          x: Math.max(0, Math.min(W - drag.start.w, drag.start.x + p.x - drag.from.x)),
          y: Math.max(0, Math.min(H - drag.start.h, drag.start.y + p.y - drag.from.y)),
        };
      } else {
        const s = drag.start;
        let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
        if (drag.grip[0] === 'n') top = p.y;
        if (drag.grip[0] === 's') bottom = p.y;
        if (drag.grip[1] === 'w') left = p.x;
        if (drag.grip[1] === 'e') right = p.x;
        sel = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(bottom - top) };
        updateLoupe();
      }
      layout();
    });

    const release = () => {
      if (!drag) return;
      const finished = drag;
      drag = null;
      if (finished.kind === 'draw') annotator.up();
      if (finished.kind === 'new') {
        if (!finished.moved) sel = hoverRect || elementRect(finished.from.x, finished.from.y);
        else if (sel.w < 4 || sel.h < 4) sel = null;
      }
      layout();
    };
    ov.addEventListener('pointerup', release);
    ov.addEventListener('pointercancel', release);
    ov.addEventListener('dblclick', (e) => {
      if (!sel || e.composedPath().includes(barWrap) || !insideSel(point(e))) return;
      if (!annotator.doubleClick(e) && annotator.tool === 'move') copy();
    });
    ov.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

    const onKey = (e) => {
      const typing = !!annotator.editing;
      e.stopImmediatePropagation();
      if (typing) {
        // The textarea handles its own keys; stopping here would block it, so forward Enter/Escape.
        if (!e.isComposing && (e.code === 'Escape' || ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.shiftKey))) {
          e.preventDefault();
          annotator.finishText();
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const done = () => e.preventDefault();
      if (e.code === 'Escape') {
        done();
        if (annotator.selected) {
          annotator.selected = null;
          annotator.changed();
        } else if (annotator.tool !== 'move') annotator.setTool('move');
        else closeOverlay();
        return;
      }
      if (!sel) {
        if (e.code === 'KeyC' && !mod) {
          done();
          S.exporter.copyText(pointer.color.toUpperCase());
          closeOverlay();
          ui.toast({ title: `🎨 ${pointer.color.toUpperCase()} copied`, timeout: 2500 });
        } else if (e.code === 'Enter' || e.code === 'KeyA') {
          done();
          selectAll();
        } else if (e.code === 'KeyF') {
          done();
          fullPage();
        }
        return;
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || (mod && e.code === 'KeyC')) {
        done();
        copy();
      } else if (mod && e.code === 'KeyS') {
        done();
        download(e.shiftKey)();
      } else if (mod && e.code === 'KeyA') {
        done();
        selectAll();
      } else if (mod && e.code === 'KeyP') {
        done();
        pinIt();
      } else if (S.handleEditorKey(e, annotator, S.saveStyle)) {
        done();
      } else if (e.key.startsWith('Arrow')) {
        done();
        const step = e.altKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (e.shiftKey) {
          sel.w = Math.max(4, Math.min(W - sel.x, sel.w + dx));
          sel.h = Math.max(4, Math.min(H - sel.y, sel.h + dy));
        } else {
          sel.x = Math.max(0, Math.min(W - sel.w, sel.x + dx));
          sel.y = Math.max(0, Math.min(H - sel.h, sel.y + dy));
        }
        layout();
      }
    };

    /* ---------- hint ---------- */

    const hintText = el('', hint, 'span');
    hintText.innerHTML = preset === 'element'
      ? '<b>Click</b> the part you want · <kbd>Esc</kbd> cancel'
      : '<b>Drag</b> to select or <b>click</b> an element · <kbd>Enter</kbd> whole screen · <kbd>C</kbd> copy color · <kbd>Esc</kbd>';
    const fullButton = el('', hint, 'button');
    fullButton.textContent = 'Full page (F)';
    fullButton.addEventListener('click', fullPage);
    const closeButton = el('', hint, 'button');
    closeButton.textContent = '✕';
    closeButton.addEventListener('click', closeOverlay);

    /* ---------- mount ---------- */

    root.append(style, ov);
    ui.raise();
    annotator = new S.Annotator({
      base: image,
      canvas,
      unit,
      host: ov,
      style: savedStyle,
      onPickColor: (color) => {
        S.exporter.copyText(color.toUpperCase());
        annotator.setStyle({ color });
        S.saveStyle(annotator.style);
        annotator.setTool('move');
        ui.toast({ title: `🎨 ${color.toUpperCase()} copied`, timeout: 2000 });
      },
      onChange: () => {
        if (bar) {
          bar.refresh(annotator);
          layout();
        }
      },
    });

    bar = S.createToolbar({
      getAnnotator: () => annotator,
      onStyle: S.saveStyle,
      actions: [
        { id: 'pin', icon: 'pin', tip: 'Pin to screen  (⌘P)', onClick: pinIt },
        { id: 'editor', icon: 'expand', tip: 'Open in full editor', onClick: openEditor },
        { id: 'pdf', icon: 'pdf', tip: 'Download PDF', onClick: savePdf },
        { id: 'full', icon: 'fullpage', tip: 'Capture full page', onClick: fullPage },
        { id: 'close', icon: 'close', tip: 'Close  (Esc)', className: 'danger', onClick: closeOverlay },
        { id: 'download', icon: 'download', tip: 'Download  (⌘S · ⌘⇧S = Save As)', label: 'Download', className: 'blue', onClick: download(false) },
        { id: 'copy', icon: 'copy', tip: 'Copy  (Enter or ⌘C)', label: 'Copy', className: 'primary', onClick: copy },
      ],
    });
    barWrap.append(bar);
    bar.refresh(annotator);

    current = { close: closeOverlay };
    window.__snap5KeyHandler = onKey;
    window.addEventListener('resize', onResize);
    document.activeElement?.blur?.();
    window.focus();
    ov.focus({ preventScroll: true });

    if (preset === 'all') {
      selectAll();
      if (id) hint.style.display = 'none';
    } else layout();
  };

  S.overlay = { start, get isOpen() { return !!current; }, close: () => current?.close() };
})();
