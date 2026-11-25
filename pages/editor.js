(async () => {
  const S = globalThis.Snap5;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const frame = $('frame');
  const canvas = $('canvas');
  const cropBox = $('cropBox');
  const settings = await S.getSettings();
  const params = new URLSearchParams(location.search);

  let annotator = null;
  let bar = null;
  let zoom = 1;
  let fitted = true;
  let title = '';
  let dirty = false;
  let crop = null;

  const toolbarStyle = document.createElement('style');
  toolbarStyle.textContent = S.toolbarCSS;
  document.head.append(toolbarStyle);

  document.querySelectorAll('[data-icon]').forEach((b) => b.insertAdjacentHTML('afterbegin', S.icon(b.dataset.icon)));
  $('format').value = settings.format;

  let toastTimer;
  const toast = (text, ms = 3000) => {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  };

  const enable = () => {
    document.querySelectorAll('.need').forEach((b) => (b.disabled = !annotator));
    frame.hidden = !annotator;
    $('emptyState').hidden = !!annotator;
  };

  /* ---------- zoom ---------- */

  const applyZoom = () => {
    if (!annotator) return;
    const w = (annotator.base.width / annotator.unit) * zoom;
    frame.style.width = `${w}px`;
    frame.style.height = `${w * (annotator.base.height / annotator.base.width)}px`;
    $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
    $('sizeInfo').textContent = `${annotator.base.width} × ${annotator.base.height} px`;
    annotator.render();
    annotator.styleEditor(false);
  };

  const fitZoom = () => {
    const cssW = annotator.base.width / annotator.unit;
    const cssH = annotator.base.height / annotator.unit;
    const byWidth = (stage.clientWidth - 48) / cssW;
    // Very tall captures fit by width so they stay readable.
    const tall = cssH / cssW > 2;
    return Math.max(0.05, Math.min(1, byWidth, tall ? 1 : (stage.clientHeight - 48) / cssH));
  };

  const setZoom = (value, isFit = false) => {
    zoom = Math.max(0.05, Math.min(6, value));
    fitted = isFit;
    applyZoom();
  };

  /* ---------- loading ---------- */

  const toCanvas = (source, w = source.width, h = source.height) => {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    return out;
  };

  const decode = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 32000 / Math.max(bmp.width, bmp.height), Math.sqrt(180e6 / (bmp.width * bmp.height)));
    const out = toCanvas(bmp, Math.round(bmp.width * k), Math.round(bmp.height * k));
    bmp.close();
    return out;
  };

  const openImage = async (base, unit) => {
    unit ||= Math.max(1, Math.min(devicePixelRatio, base.width / 700));
    if (annotator) {
      annotator.finishText();
      annotator.unit = unit;
      annotator.undoStack = [];
      annotator.redoStack = [];
      annotator.objects = [];
      annotator.selected = null;
      annotator.base = base;
      canvas.width = base.width;
      canvas.height = base.height;
    } else {
      annotator = new S.Annotator({
        base,
        canvas,
        unit,
        host: stage,
        style: await S.loadStyle(),
        onChange: (a) => {
          bar?.refresh(a);
          if (a.undoStack.length) dirty = true;
          const label = `${a.base.width} × ${a.base.height} px`;
          if ($('sizeInfo').textContent && $('sizeInfo').textContent !== label) applyZoom();
        },
        onPickColor: (color) => {
          S.exporter.copyText(color.toUpperCase());
          annotator.setStyle({ color });
          S.saveStyle(annotator.style);
          annotator.setTool('move');
          toast(`🎨 ${color.toUpperCase()} copied`);
        },
      });
      bar = S.createToolbar({ getAnnotator: () => annotator, actions: [], onStyle: S.saveStyle });
      bar.classList.add('tips-below');
      $('toolbar').append(bar);
    }
    enable();
    stage.scrollTo(0, 0);
    setZoom(fitZoom(), true);
    bar.refresh(annotator);
    dirty = false;
  };

  const openFile = async (file) => {
    if (!file?.type.startsWith('image/')) return toast('Only image files are supported');
    title = file.name?.replace(/\.[^.]+$/, '') || title;
    await openImage(await decode(file));
  };

  /* Paste or drop onto an existing capture adds the picture as a movable layer. */
  const addLayer = async (file) => {
    const image = await decode(file);
    const k = Math.min(1, (annotator.base.width * 0.6) / image.width, (annotator.base.height * 0.6) / image.height);
    const w = image.width * k;
    const h = image.height * k;
    const box = canvas.getBoundingClientRect();
    const view = stage.getBoundingClientRect();
    const cy = ((view.top + view.height / 2 - box.top) * canvas.height) / box.height;
    const y = Math.max(0, Math.min(annotator.base.height - h, cy - h / 2));
    const x = (annotator.base.width - w) / 2;
    annotator.setTool('move');
    annotator.selected = annotator.add({ type: 'image', image, x1: x, y1: y, x2: x + w, y2: y + h });
    annotator.changed();
  };

  const takeImage = (file) => (annotator ? addLayer(file) : openFile(file));

  /* ---------- output ---------- */

  const output = () => annotator.export();

  const save = async (blob, ext, saveAs = false) => {
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: S.fileName(settings, ext, title), saveAs });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    dirty = false;
    toast('⬇️ Downloaded');
  };

  const keep = async (out) => {
    if (!settings.saveHistory) return;
    await S.db.add(await S.exporter.toBlob(out), { title });
    await S.db.prune(settings.historyLimit);
  };

  const download = async (saveAs) => {
    const out = output();
    const format = $('format').value;
    await save(await S.exporter.toBlob(out, format, settings.jpgQuality), format, saveAs);
    await keep(out);
  };

  const copy = async () => {
    const out = output();
    await S.exporter.copyImage(S.exporter.toBlob(out));
    if (settings.sound) S.exporter.shutter();
    dirty = false;
    toast('✅ Copied. Paste anywhere with ⌘V');
    await keep(out);
  };

  /* ---------- crop ---------- */

  const startCrop = () => {
    annotator.setTool('move');
    crop = { rect: null, from: null };
    frame.classList.add('cropping');
    $('cropBar').hidden = false;
    cropBox.hidden = true;
  };

  const endCrop = (apply) => {
    if (!crop) return;
    const rect = crop.rect;
    crop = null;
    frame.classList.remove('cropping');
    $('cropBar').hidden = true;
    cropBox.hidden = true;
    if (apply && rect && rect.w > 4 && rect.h > 4) {
      annotator.crop(rect);
      setZoom(fitZoom(), true);
    }
  };

  const cropDraw = () => {
    const k = frame.clientWidth / canvas.width;
    const r = crop.rect;
    cropBox.hidden = false;
    Object.assign(cropBox.style, { left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${r.w * k}px`, height: `${r.h * k}px` });
    $('sizeInfo').textContent = `${Math.round(r.w)} × ${Math.round(r.h)} px`;
  };

  const clampPoint = (p) => ({ x: Math.max(0, Math.min(canvas.width, p.x)), y: Math.max(0, Math.min(canvas.height, p.y)) });

  /* ---------- pointer ---------- */

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !annotator) return;
    e.preventDefault();
    bar.closePopups();
    canvas.setPointerCapture(e.pointerId);
    if (crop) crop.from = clampPoint(annotator.toImage(e));
    else annotator.down(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!annotator) return;
    if (crop) {
      if (!crop.from) return;
      const p = clampPoint(annotator.toImage(e));
      crop.rect = { x: Math.min(p.x, crop.from.x), y: Math.min(p.y, crop.from.y), w: Math.abs(p.x - crop.from.x), h: Math.abs(p.y - crop.from.y) };
      cropDraw();
    } else if (annotator.drag) annotator.move(e);
    else canvas.style.cursor = annotator.cursorFor(annotator.toImage(e)) || 'default';
  });
  const release = () => {
    if (crop) crop.from = null;
    else annotator?.up();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', (e) => !crop && annotator.doubleClick(e));

  stage.addEventListener('wheel', (e) => {
    if (!annotator || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.006));
  }, { passive: false });

  /* ---------- transforms ---------- */

  const rotate = () => {
    const source = output();
    const out = document.createElement('canvas');
    out.width = source.height;
    out.height = source.width;
    const ctx = out.getContext('2d');
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, 0, 0);
    annotator.replaceBase(out, []);
    setZoom(fitZoom(), true);
  };

  const openResize = () => {
    $('resizeW').value = annotator.base.width;
    $('resizeH').value = annotator.base.height;
    $('resizeDialog').showModal();
  };
  $('resizeW').addEventListener('input', () => ($('resizeH').value = Math.round(($('resizeW').value * annotator.base.height) / annotator.base.width)));
  $('resizeH').addEventListener('input', () => ($('resizeW').value = Math.round(($('resizeH').value * annotator.base.width) / annotator.base.height)));

  const resizeTo = (w, h) => {
    if (!(w >= 1 && h >= 1 && w <= 32000 && h <= 32000 && w * h <= 180e6)) return toast('That size is not valid');
    annotator.replaceBase(toCanvas(output(), Math.round(w), Math.round(h)), []);
    $('resizeDialog').close();
    setZoom(fitZoom(), true);
  };

  /* ---------- beautify ---------- */

  const BACKGROUNDS = [
    ['#6366f1', '#ec4899'], ['#0ea5e9', '#22c55e'], ['#f97316', '#facc15'], ['#111827', '#4b5563'],
    ['#8b5cf6', '#06b6d4'], ['#f43f5e', '#7c3aed'], ['#e2e8f0', '#f8fafc'], ['#ffffff', '#ffffff'], ['#000000', '#000000'], null,
  ];
  let background = 0;
  let beautySource;

  BACKGROUNDS.forEach((colors, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = colors ? `linear-gradient(135deg,${colors.join(',')})` : 'repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/12px 12px';
    b.title = colors ? '' : 'Transparent';
    b.addEventListener('click', () => {
      background = i;
      previewBeauty();
    });
    $('backgrounds').append(b);
  });

  const compose = (source) => {
    const u = annotator.unit;
    const pad = +$('bPadding').value * u;
    const radius = +$('bRadius').value * u;
    const shadow = +$('bShadow').value * u;
    let w = source.width + pad * 2;
    let h = source.height + pad * 2;
    const ratio = +$('bRatio').value;
    if (ratio) {
      if (w / h < ratio) w = h * ratio;
      else h = w / ratio;
    }
    const k = Math.min(1, 32000 / Math.max(w, h), Math.sqrt(180e6 / (w * h)));
    const out = document.createElement('canvas');
    out.width = Math.round(w * k);
    out.height = Math.round(h * k);
    const ctx = out.getContext('2d');
    ctx.scale(k, k);
    const colors = BACKGROUNDS[background];
    if (colors) {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, colors[0]);
      g.addColorStop(1, colors[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    const x = (w - source.width) / 2;
    const y = (h - source.height) / 2;
    if (shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.45)';
      ctx.shadowBlur = shadow * k;
      ctx.shadowOffsetY = shadow * k * 0.35;
      ctx.beginPath();
      ctx.roundRect(x, y, source.width, source.height, radius);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, source.width, source.height, radius);
    ctx.clip();
    ctx.drawImage(source, x, y);
    ctx.restore();
    const mark = $('bMark').value.trim();
    if (mark) {
      ctx.font = `600 ${15 * u}px system-ui, "Kohinoor Bangla", sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.strokeText(mark, w - 12 * u, h - 9 * u);
      ctx.fillText(mark, w - 12 * u, h - 9 * u);
    }
    return out;
  };

  const previewBeauty = () => {
    [...$('backgrounds').children].forEach((b, i) => b.classList.toggle('on', i === background));
    const full = compose(beautySource);
    const k = Math.min(1, 1000 / full.width, 1400 / full.height);
    const preview = $('beautyPreview');
    preview.width = Math.max(1, Math.round(full.width * k));
    preview.height = Math.max(1, Math.round(full.height * k));
    preview.getContext('2d').drawImage(full, 0, 0, preview.width, preview.height);
  };
  ['bPadding', 'bRadius', 'bShadow', 'bRatio', 'bMark'].forEach((id) => $(id).addEventListener('input', previewBeauty));

  /* ---------- desktop capture ---------- */

  const desktopCapture = async (delay) => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return toast('Capture cancelled, or Chrome lacks the Mac Screen Recording permission', 6000);
    }
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();
      for (let left = delay; left > 0; left--) {
        toast(`${left}…`, 1100);
        document.title = `⏱ ${left} — Snap5`;
        await new Promise((r) => setTimeout(r, 1000));
      }
      $('toast').hidden = true;
      await new Promise((r) => setTimeout(r, 400));
      const shot = document.createElement('canvas');
      shot.width = video.videoWidth;
      shot.height = video.videoHeight;
      shot.getContext('2d').drawImage(video, 0, 0);
      title = 'screen';
      await openImage(shot, devicePixelRatio);
      if (settings.sound) S.exporter.shutter();
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      document.title = 'Snap5 Editor';
      const tab = await chrome.tabs.getCurrent();
      if (tab) chrome.tabs.update(tab.id, { active: true });
    }
  };

  /* ---------- commands ---------- */

  const commands = {
    open: () => $('fileInput').click(),
    desktop: () => $('desktopDialog').showModal(),
    desktopStart: () => {
      $('desktopDialog').close();
      return desktopCapture(+$('desktopDelay').value);
    },
    history: () => chrome.tabs.create({ url: chrome.runtime.getURL('pages/history.html') }),
    crop: () => (crop ? endCrop(false) : startCrop()),
    cropApply: () => endCrop(true),
    cropCancel: () => {
      endCrop(false);
      applyZoom();
    },
    rotate,
    resize: openResize,
    half: () => resizeTo(annotator.base.width / 2, annotator.base.height / 2),
    resizeApply: () => resizeTo(+$('resizeW').value, +$('resizeH').value),
    beautify: () => {
      beautySource = output();
      $('beautyDialog').showModal();
      previewBeauty();
    },
    beautyApply: () => {
      annotator.replaceBase(compose(beautySource), []);
      $('beautyDialog').close();
      setZoom(fitZoom(), true);
    },
    qr: async () => {
      if (!('BarcodeDetector' in window)) return toast('This browser cannot read QR codes');
      const codes = await new BarcodeDetector().detect(output());
      if (!codes.length) return toast('No QR code or barcode found');
      $('qrText').value = codes.map((c) => c.rawValue).join('\n');
      $('qrDialog').showModal();
    },
    qrCopy: async () => {
      await S.exporter.copyText($('qrText').value);
      $('qrDialog').close();
      toast('✅ Copied');
    },
    zoomin: () => setZoom(zoom * 1.25),
    zoomout: () => setZoom(zoom / 1.25),
    fit: () => (fitted ? setZoom(1) : setZoom(fitZoom(), true)),
    print: async () => {
      const img = new Image();
      img.src = output().toDataURL('image/png');
      await img.decode();
      $('printArea').replaceChildren(img);
      window.print();
    },
    share: async () => {
      const blob = await S.exporter.toBlob(output());
      const file = new File([blob], S.fileName({ ...settings, subfolder: '' }, 'png', title), { type: 'image/png' });
      if (!navigator.canShare?.({ files: [file] })) return toast('Sharing is not supported. Copy and paste instead');
      await navigator.share({ files: [file] }).catch(() => {});
    },
    pdf: async () => {
      const out = output();
      await save(await S.exporter.toPdf(out, { split: out.height > out.width * 1.6 }), 'pdf');
    },
    download: () => download(false),
    copy,
  };

  const run = async (name) => {
    try {
      await commands[name]();
    } catch (error) {
      console.warn(error);
      toast(`Error: ${error.message}`, 5000);
    }
  };

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-cmd]');
    if (target) run(target.dataset.cmd);
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
    if (!e.target.closest('.s5-bar')) bar?.closePopups();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, dialog[open]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const hit = (name) => {
      e.preventDefault();
      run(name);
    };
    if (mod && e.code === 'KeyO') return hit('open');
    if (!annotator) return;
    if (crop) {
      if (e.key === 'Enter') hit('cropApply');
      else if (e.key === 'Escape') hit('cropCancel');
      return;
    }
    if (mod && e.code === 'KeyC') return hit('copy');
    if (mod && e.code === 'KeyS') {
      e.preventDefault();
      download(e.shiftKey).catch((err) => toast(err.message));
      return;
    }
    if (mod && e.code === 'KeyP') return hit('print');
    if (mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) return hit('zoomin');
    if (mod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) return hit('zoomout');
    if (mod && e.code === 'Digit0') return hit('fit');
    if (!mod && e.code === 'KeyC') return hit('crop');
    if (e.key === 'Escape') {
      annotator.selected = null;
      annotator.setTool('move');
      return;
    }
    if (S.handleEditorKey(e, annotator, S.saveStyle)) e.preventDefault();
  });

  document.addEventListener('paste', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      takeImage(file);
    }
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) takeImage(file);
  });
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = '';
  });
  window.addEventListener('resize', () => annotator && fitted && setZoom(fitZoom(), true));
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  /* ---------- start ---------- */

  enable();
  const id = params.get('id');
  const record = id ? await S.db.get(id) : null;
  if (record) {
    title = record.title || '';
    await openImage(await decode(record.blob), devicePixelRatio);
    if (params.get('tool') === 'crop') startCrop();
    if (params.has('copy')) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await S.exporter.copyImage(S.exporter.toBlob(output()));
        toast('✅ Copied. Paste anywhere with ⌘V', 5000);
      } catch {
        toast('Press the green “Copy” button above to copy', 6000);
      }
    }
  } else if (params.has('desktop')) $('desktopDialog').showModal();
})();
