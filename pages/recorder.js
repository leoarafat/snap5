/* Recorder studio page: setup, region, countdown, live controls and review. */
(async () => {
  const S = globalThis.Snap5;
  const $ = (id) => document.getElementById(id);
  const settings = await S.getSettings();

  const DEFAULTS = {
    mode: 'screen', surface: 'monitor', region: false,
    micOn: true, micId: '', noise: true, micVolume: 1, systemAudio: true,
    cameraId: '', camShape: 'circle', camSize: 0.2, camX: 0.02, camY: 0.96, mirror: true,
    resolution: '1080', fps: '30', quality: 'high', format: 'mp4',
    countdown: '3', floating: true, clicks: true, keys: false, limit: '0', autoDownload: false,
  };
  const opts = { ...DEFAULTS, ...((await chrome.storage.local.get('recorder')).recorder || {}) };
  const saveOpts = () => chrome.storage.local.set({ recorder: opts });

  document.querySelectorAll('[data-icon]').forEach((b) => b.insertAdjacentHTML('afterbegin', S.icon(b.dataset.icon)));

  let mic = null;
  let camera = null;
  let meterAudio = null;
  let session = null; // the active S.Recording
  let current = null; // the recording shown in review
  let playerUrl = '';
  let view = 'setup';
  let ticker = null;
  let countAbort = null;
  let trimAbort = null;
  let starting = false;

  /* ---------- helpers ---------- */

  let toastTimer;
  const toast = (text, ms = 3200) => {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), ms);
  };
  const problem = (text) => {
    $('problem').textContent = text || '';
    $('problem').hidden = !text;
  };

  const show = (name) => {
    view = name;
    for (const id of ['setup', 'regionView', 'countView', 'live', 'review']) $(id).hidden = id !== name;
    if (name !== 'review') $('player').pause();
  };

  const myTab = await chrome.tabs.getCurrent();
  // Memory Saver must never unload this tab in the middle of a recording.
  if (myTab) chrome.tabs.update(myTab.id, { autoDiscardable: false }).catch(() => {});
  const focusMe = async () => {
    if (!myTab) return;
    await chrome.tabs.update(myTab.id, { active: true }).catch(() => {});
    await chrome.windows.update(myTab.windowId, { focused: true }).catch(() => {});
  };

  /* ---------- shared state for badge, popup and page controls ---------- */

  const publish = (extra = {}) => {
    const active = session && ['recording', 'paused'].includes(session.state);
    const state = extra.status === 'countdown' || active
      ? {
          status: extra.status || session.state,
          seconds: extra.seconds,
          elapsed: active ? session.elapsed : 0,
          at: Date.now(),
          mic: mic ? !session?.micMuted : null,
          camera: session?.options.mode === 'both' && camera ? session.cameraVisible : null,
          floating: opts.floating,
          clicks: opts.clicks,
          keys: opts.keys,
        }
      : null;
    chrome.runtime.sendMessage({ type: 'rec-state', state }).catch(() => {});
  };

  /* ---------- devices ---------- */

  const deviceMessage = (kind, error) =>
    error.name === 'NotAllowedError'
      ? `${kind} is blocked. Click the icon at the right of the address bar to allow it. On Mac also check System Settings → Privacy & Security → ${kind}.`
      : `Could not open the ${kind.toLowerCase()}: ${error.message}`;

  const fillDevices = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [select, kind, key, label] of [[$('micSelect'), 'audioinput', 'micId', 'Microphone'], [$('cameraSelect'), 'videoinput', 'cameraId', 'Camera']]) {
      const list = devices.filter((d) => d.kind === kind && d.deviceId);
      select.replaceChildren(new Option(`Default ${label.toLowerCase()}`, ''), ...list.map((d, i) => new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
      select.value = list.some((d) => d.deviceId === opts[key]) ? opts[key] : '';
    }
  };

  const stopMeter = () => {
    meterAudio?.close().catch(() => {});
    meterAudio = null;
    $('meter').style.width = '0';
  };

  const startMeter = () => {
    stopMeter();
    if (!mic) return;
    meterAudio = new AudioContext();
    meterAudio.resume().catch(() => {});
    const analyser = meterAudio.createAnalyser();
    analyser.fftSize = 512;
    meterAudio.createMediaStreamSource(mic).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const context = meterAudio;
    const draw = () => {
      if (meterAudio !== context) return;
      analyser.getByteTimeDomainData(data);
      const peak = data.reduce((m, v) => Math.max(m, Math.abs(v - 128)), 0) / 128;
      $('meter').style.width = `${Math.min(100, peak * 140)}%`;
      requestAnimationFrame(draw);
    };
    draw();
  };

  const deviceWanted = (id) => (id ? { deviceId: { ideal: id } } : {});

  let micRequest = 0;
  const openMic = async () => {
    const mine = ++micRequest;
    S.stopTracks(mic);
    mic = null;
    stopMeter();
    if (!opts.micOn) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...deviceWanted(opts.micId), noiseSuppression: opts.noise, echoCancellation: opts.noise, autoGainControl: true },
      });
      if (mine !== micRequest) return S.stopTracks(stream);
      mic = stream;
      startMeter();
      await fillDevices();
    } catch (error) {
      toast(deviceMessage('Microphone', error), 8000);
    }
  };

  let cameraRequest = 0;
  const openCamera = async () => {
    const mine = ++cameraRequest;
    S.stopTracks(camera);
    camera = null;
    if (opts.mode !== 'screen') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...deviceWanted(opts.cameraId), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        });
        if (mine !== cameraRequest) return S.stopTracks(stream);
        camera = stream;
        await fillDevices();
      } catch (error) {
        toast(deviceMessage('Camera', error), 8000);
      }
    }
    $('cameraFull').srcObject = opts.mode === 'camera' ? camera : null;
    $('cameraBubble').srcObject = opts.mode === 'both' ? camera : null;
    renderSetup();
  };

  const releaseDevices = () => {
    micRequest++;
    cameraRequest++;
    S.stopTracks(mic);
    S.stopTracks(camera);
    mic = camera = null;
    stopMeter();
  };

  const openDevices = async () => {
    await openMic();
    await openCamera();
  };

  /* ---------- setup view ---------- */

  const renderBubble = () => {
    const stage = $('setupStage');
    const bubble = $('bubble');
    const w = stage.clientWidth * opts.camSize;
    const h = opts.camShape === 'wide' ? (w * 9) / 16 : w;
    Object.assign(bubble.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${opts.camX * (stage.clientWidth - w)}px`,
      top: `${opts.camY * (stage.clientHeight - h)}px`,
      borderRadius: opts.camShape === 'circle' ? '50%' : `${Math.min(w, h) * 0.12}px`,
    });
  };

  const renderSetup = () => {
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === opts.mode);
      b.setAttribute('aria-checked', b.dataset.mode === opts.mode);
    });
    $('sourceBox').hidden = opts.mode === 'camera';
    $('systemLine').hidden = opts.mode === 'camera';
    $('cameraBox').hidden = opts.mode === 'screen';
    document.querySelectorAll('[data-bubble]').forEach((n) => (n.hidden = opts.mode !== 'both'));
    $('micBox').hidden = !opts.micOn;
    $('cameraFull').hidden = opts.mode !== 'camera' || !camera;
    $('placeholder').hidden = opts.mode === 'camera' && !!camera;
    $('bubble').hidden = opts.mode !== 'both' || !camera;
    $('cameraFull').classList.toggle('mirrored', opts.mirror);
    $('cameraBubble').classList.toggle('mirrored', opts.mirror);
    if (!$('bubble').hidden) renderBubble();
  };

  document.querySelectorAll('[data-opt]').forEach((input) => {
    const key = input.dataset.opt;
    if (input.type === 'checkbox') input.checked = opts[key];
    else input.value = opts[key];
    input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
      opts[key] = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value;
      saveOpts();
      if (['micOn', 'micId', 'noise'].includes(key)) openMic();
      if (key === 'cameraId') openCamera();
      renderSetup();
    });
  });

  document.querySelectorAll('[data-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      opts.mode = button.dataset.mode;
      saveOpts();
      renderSetup();
      openCamera();
    }),
  );

  /* Drag the camera bubble, both before and during recording. */
  const dragCamera = (surface, rectOf, apply) => {
    let dragging = false;
    const move = (e) => {
      const area = rectOf();
      const w = area.width * opts.camSize;
      const h = opts.camShape === 'wide' ? (w * 9) / 16 : w;
      opts.camX = Math.max(0, Math.min(1, (e.clientX - area.left - w / 2) / Math.max(1, area.width - w)));
      opts.camY = Math.max(0, Math.min(1, (e.clientY - area.top - h / 2) / Math.max(1, area.height - h)));
      apply();
    };
    surface.addEventListener('pointerdown', (e) => {
      dragging = true;
      surface.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    surface.addEventListener('pointermove', (e) => dragging && move(e));
    surface.addEventListener('pointerup', () => {
      dragging = false;
      saveOpts();
    });
  };

  dragCamera($('bubble'), () => $('setupStage').getBoundingClientRect(), renderBubble);

  /* The picture inside the live stage is letterboxed, so map the pointer to the picture. */
  const pictureRect = () => {
    const box = $('liveVideo').getBoundingClientRect();
    const k = Math.min(box.width / (session?.width || 16), box.height / (session?.height || 9));
    const width = (session?.width || 16) * k;
    const height = (session?.height || 9) * k;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  };
  dragCamera($('liveDrag'), pictureRect, () => {
    if (!session) return;
    Object.assign(session.options.cameraLayout, { x: opts.camX, y: opts.camY });
    session.updateLayout();
  });

  /* ---------- start flow ---------- */

  const sessionOptions = () => ({
    mode: opts.mode,
    surface: opts.surface,
    region: opts.region && opts.mode !== 'camera',
    systemAudio: opts.systemAudio,
    micVolume: opts.micVolume,
    resolution: opts.resolution,
    fps: Number(opts.fps),
    quality: opts.quality,
    format: opts.format,
    crop: null,
    cameraLayout: { shape: opts.camShape, size: opts.camSize, x: opts.camX, y: opts.camY, mirror: opts.mirror },
  });

  const chooseRegion = () =>
    new Promise((resolve) => {
      show('regionView');
      const video = $('regionVideo');
      const wrap = $('regionWrap');
      const box = $('regionBox');
      video.srcObject = new MediaStream(session.display.getVideoTracks());
      box.hidden = true;
      $('regionOk').disabled = true;
      let from = null;
      let crop = null;
      const point = (e) => {
        const r = video.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
      };
      wrap.onpointerdown = (e) => {
        from = point(e);
        wrap.setPointerCapture(e.pointerId);
      };
      wrap.onpointermove = (e) => {
        if (!from) return;
        const to = point(e);
        crop = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
        box.hidden = false;
        Object.assign(box.style, { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` });
        $('regionOk').disabled = crop.w < 0.04 || crop.h < 0.04;
      };
      wrap.onpointerup = () => (from = null);
      const finish = (value) => {
        video.srcObject = null;
        resolve(value);
      };
      $('regionOk').onclick = () => finish({ crop });
      $('regionAll').onclick = () => finish({ crop: null });
      $('regionCancel').onclick = () => finish(null);
    });

  const countdown = async (seconds) => {
    if (!seconds) return true;
    show('countView');
    countAbort = new AbortController();
    const { signal } = countAbort;
    for (let left = seconds; left > 0 && !signal.aborted; left--) {
      $('count').textContent = left;
      document.title = `${left}… — Snap5 Recorder`;
      publish({ status: 'countdown', seconds: left });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    countAbort = null;
    publish();
    // Give the on-page countdown a moment to disappear before the first frame.
    if (!signal.aborted) await new Promise((r) => setTimeout(r, 250));
    return !signal.aborted;
  };

  const abandon = () => {
    countAbort?.abort();
    session?.release();
    session = null;
    publish();
    document.title = 'Snap5 Recorder';
    show('setup');
    renderSetup();
  };
  $('countCancel').onclick = abandon;

  const begin = async () => {
    if (starting || view !== 'setup') return;
    starting = true;
    $('start').disabled = true;
    problem('');
    try {
      const recording = new S.Recording(sessionOptions());
      if (opts.mode === 'camera' && !camera) await openCamera();
      if (opts.mode !== 'screen' && !camera) throw new Error('The camera is not available. Allow it, or choose “Screen”.');
      // Chrome requires this to be the first thing after the click.
      if (opts.mode !== 'camera') await recording.pickScreen();
      session = recording;
      if (opts.micOn && !mic) await openMic();
      session.mic = mic;
      session.camera = camera;
      if (opts.systemAudio && session.display && !session.display.getAudioTracks().length) {
        toast('No tab or system sound is being shared. Your microphone still works if it is on.', 6000);
      }
      let cancelled = false;
      recording.addEventListener('cancelled', () => {
        cancelled = true;
        if (session === recording) abandon();
      });

      if (recording.options.region) {
        await focusMe();
        const region = await chooseRegion();
        if (session !== recording) return;
        if (!region) return abandon();
        recording.options.crop = region.crop;
      }
      if (!(await countdown(Number(opts.countdown))) || cancelled || session !== recording) {
        if (session === recording) abandon();
        return;
      }
      wire(recording);
      await recording.start();
      stopMeter();
      showLive();
    } catch (error) {
      console.warn('Snap5 recorder:', error);
      abandon();
      if (error.name === 'NotAllowedError') {
        problem('Screen capture was cancelled or blocked. On a Mac, allow Google Chrome in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Chrome.');
      } else problem(`Could not start recording: ${error.message}`);
    } finally {
      starting = false;
      $('start').disabled = false;
    }
  };
  $('start').onclick = begin;

  /* ---------- live view ---------- */

  const renderLive = () => {
    if (!session) return;
    const paused = session.state === 'paused';
    $('liveStatus').classList.toggle('paused', paused);
    $('liveStatus').lastChild.textContent = session.state === 'saving' ? ' Saving…' : paused ? ' Paused' : ' Recording';
    $('pauseBtn').textContent = paused ? '▶ Resume' : '❚❚ Pause';
    $('micBtn').hidden = !mic;
    $('micBtn').textContent = session.micMuted ? 'Unmute mic' : 'Mute mic';
    const hasBubble = session.options.mode === 'both' && !!camera;
    $('camBtn').hidden = !hasBubble;
    $('camBtn').textContent = session.cameraVisible ? 'Hide camera' : 'Show camera';
    $('liveDrag').hidden = !hasBubble || !session.cameraVisible;
    for (const id of ['pauseBtn', 'micBtn', 'camBtn', 'stopBtn', 'restartBtn', 'discardBtn']) $(id).disabled = session.state === 'saving';
  };

  const tick = () => {
    if (!session || !['recording', 'paused'].includes(session.state)) return;
    const time = S.formatTime(session.elapsed);
    $('clock').textContent = time;
    $('liveSize').textContent = `${S.formatSize(session.size)} · ${session.width}×${session.height} · ${session.ext.toUpperCase()}`;
    document.title = `${session.state === 'paused' ? '❚❚' : '●'} ${time} — Snap5`;
    const limit = Number(opts.limit) * 60000;
    if (limit && session.elapsed >= limit) session.stop();
  };

  const showLive = () => {
    show('live');
    $('liveVideo').srcObject = new MediaStream(session.output.getVideoTracks());
    $('liveVideo').play().catch(() => {});
    renderLive();
    tick();
    clearInterval(ticker);
    ticker = setInterval(tick, 250);
    publish();
  };

  const endLive = () => {
    clearInterval(ticker);
    $('liveVideo').srcObject = null;
    document.title = 'Snap5 Recorder';
  };

  const wire = (recording) => {
    recording.addEventListener('state', () => {
      if (session !== recording) return;
      renderLive();
      tick();
      publish();
    });
    recording.addEventListener('problem', (e) => problem(e.detail));
    recording.addEventListener('saved', async (e) => {
      endLive();
      session = null;
      publish();
      releaseDevices();
      await focusMe();
      await openReview(e.detail);
      if (opts.autoDownload) download(false);
    });
  };

  const discard = async () => {
    const recording = session;
    if (!recording) return;
    endLive();
    session = null;
    await recording.discard();
    publish();
  };

  const commands = {
    toggle: () => (session?.state === 'paused' ? session.resume() : session?.pause()),
    stop: () => {
      if (countAbort) return abandon();
      return session?.stop();
    },
    mic: () => session && mic && session.setMicMuted(!session.micMuted),
    camera: () => session?.setCameraVisible(!session.cameraVisible),
  };

  $('pauseBtn').onclick = commands.toggle;
  $('stopBtn').onclick = () => session?.stop();
  $('micBtn').onclick = commands.mic;
  $('camBtn').onclick = commands.camera;
  $('discardBtn').onclick = async () => {
    if (!confirm('Throw away this recording? This cannot be undone.')) return;
    await discard();
    show('setup');
    renderSetup();
  };
  $('restartBtn').onclick = async () => {
    if (!confirm('Delete what you recorded so far and start again?')) return;
    await discard();
    show('setup');
    renderSetup();
    await begin();
  };

  const snapshot = async (video) => {
    if (!video.videoWidth) return toast('No picture yet');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return S.db.add(blob, { title: 'Video frame' });
  };
  $('frameBtn').onclick = async () => {
    if (await snapshot($('liveVideo'))) toast('📸 Saved to screenshot history');
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'recorder-cmd' || sender.id !== chrome.runtime.id) return false;
    commands[message.cmd]?.();
    sendResponse({ ok: true });
    return false;
  });

  /* ---------- review ---------- */

  const baseName = () => $('fileName').value.trim() || 'Snap5 recording';

  const fileFor = (record) => {
    const clean = baseName().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/^\.+/, '').trim() || 'Snap5 recording';
    const folder = S.fileName({ ...settings, filename: 'x' }, record.ext).replace(/x\.\w+$/, '');
    return `${folder}${clean}.${record.ext}`;
  };

  const download = async (saveAs) => {
    if (!current) return;
    const url = URL.createObjectURL(current.blob);
    try {
      await chrome.downloads.download({ url, filename: fileFor(current), saveAs });
      toast(saveAs ? 'Choose where to save it' : '⬇ Saved to your Downloads folder');
    } catch (error) {
      toast(`Download failed: ${error.message}`, 6000);
    }
    // Large files need a while to be written.
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  };

  const updateTrim = () => {
    $('trimStartText').textContent = S.formatTime($('trimStart').value * 1000);
    $('trimEndText').textContent = S.formatTime($('trimEnd').value * 1000);
  };

  const openReview = async (record) => {
    current = record;
    show('review');
    URL.revokeObjectURL(playerUrl);
    playerUrl = URL.createObjectURL(record.blob);
    const player = $('player');
    player.src = playerUrl;
    const defaultName = S.fileName({ filename: 'Snap5_Recording_{date}_{time}' }, record.ext).replace(/\.\w+$/, '');
    $('fileName').value = record.title || defaultName;
    $('fileInfo').textContent = `${S.formatTime(record.duration)} · ${S.formatSize(record.size)} · ${record.width}×${record.height} · ${record.ext.toUpperCase()}`;
    history.replaceState(null, '', `recorder.html?view=${record.id}`);
    $('trimBox').open = false;
    try {
      await S.makeSeekable(player);
    } catch {}
    const duration = Number.isFinite(player.duration) ? player.duration : record.duration / 1000;
    for (const id of ['trimStart', 'trimEnd']) $(id).max = duration.toFixed(1);
    $('trimStart').value = 0;
    $('trimEnd').value = duration.toFixed(1);
    player.playbackRate = Number($('speed').value);
    updateTrim();
  };

  $('fileName').addEventListener('change', () => current && S.recordings.update(current.id, { title: baseName() }));
  $('downloadBtn').onclick = () => download(false);
  $('saveAsBtn').onclick = () => download(true);
  $('shareBtn').onclick = async () => {
    const file = new File([current.blob], `${baseName()}.${current.ext}`, { type: current.blob.type });
    if (!navigator.canShare?.({ files: [file] })) return toast('Sharing is not supported for this file. Download it and send it instead.', 5000);
    await navigator.share({ files: [file] }).catch(() => {});
  };
  $('snapBtn').onclick = async () => {
    const id = await snapshot($('player'));
    if (id) chrome.tabs.create({ url: chrome.runtime.getURL(`pages/editor.html?id=${id}`) });
  };
  $('speed').onchange = () => ($('player').playbackRate = Number($('speed').value));

  const bounds = () => ({ start: Number($('trimStart').value), end: Number($('trimEnd').value) });
  $('trimStart').oninput = () => {
    if (bounds().start > bounds().end - 0.5) $('trimStart').value = Math.max(0, bounds().end - 0.5);
    $('player').currentTime = bounds().start;
    updateTrim();
  };
  $('trimEnd').oninput = () => {
    if (bounds().end < bounds().start + 0.5) $('trimEnd').value = bounds().start + 0.5;
    $('player').currentTime = bounds().end;
    updateTrim();
  };
  $('markStart').onclick = () => {
    $('trimStart').value = $('player').currentTime;
    $('trimStart').oninput();
  };
  $('markEnd').onclick = () => {
    $('trimEnd').value = $('player').currentTime;
    $('trimEnd').oninput();
  };
  $('trimPlay').onclick = () => {
    const player = $('player');
    const { start, end } = bounds();
    player.currentTime = start;
    player.play();
    const watch = () => {
      if (player.currentTime >= end) {
        player.pause();
        player.removeEventListener('timeupdate', watch);
      }
    };
    player.addEventListener('timeupdate', watch);
  };
  $('trimCancel').onclick = () => trimAbort?.abort();
  $('trimExport').onclick = async () => {
    if (trimAbort) return;
    const { start, end } = bounds();
    if (end - start < 0.5) return toast('The clip is too short');
    $('player').pause();
    trimAbort = new AbortController();
    const source = current;
    $('trimExport').disabled = true;
    $('trimProgress').hidden = false;
    $('trimCancel').hidden = false;
    try {
      const clip = await S.trimVideo(source.blob, {
        start, end, ext: source.ext, signal: trimAbort.signal,
        onProgress: (p) => ($('trimProgress').value = p),
      });
      const created = await S.recordings.create({
        title: `${baseName()} (trimmed)`, mime: clip.mime, ext: clip.ext, width: source.width, height: source.height,
      });
      const record = await S.recordings.update(created.id, {
        blob: clip.blob, size: clip.blob.size, duration: clip.duration, thumb: await S.videoThumb(clip.blob).catch(() => null), done: true,
      });
      await openReview(record);
      toast('✂ Trimmed copy saved. Press Download to export it.', 5000);
    } catch (error) {
      if (error.message !== 'cancelled') toast(`Trim failed: ${error.message}`, 6000);
    } finally {
      trimAbort = null;
      $('trimExport').disabled = false;
      $('trimProgress').hidden = true;
      $('trimCancel').hidden = true;
    }
  };

  const backToSetup = async () => {
    trimAbort?.abort();
    current = null;
    $('player').removeAttribute('src');
    $('player').load();
    URL.revokeObjectURL(playerUrl);
    history.replaceState(null, '', 'recorder.html');
    problem('');
    show('setup');
    renderSetup();
    await openDevices();
  };
  $('newBtn').onclick = backToSetup;
  $('deleteBtn').onclick = async () => {
    if (!confirm('Delete this recording? This cannot be undone.')) return;
    await S.recordings.remove(current.id);
    await backToSetup();
  };

  /* ---------- keyboard and page lifetime ---------- */

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input[type=text], select, textarea')) return;
    if (e.key === 'Escape' && countAbort) return abandon();
    if (e.code === 'Space' && view === 'live') {
      e.preventDefault();
      commands.toggle();
    }
    if (e.key === 'Enter' && view === 'setup' && !e.target.closest('button, a, input')) begin();
  });

  const busy = () => !!trimAbort || (!!session && ['recording', 'paused', 'saving'].includes(session.state));
  window.addEventListener('beforeunload', (e) => {
    if (busy()) e.preventDefault();
  });
  window.addEventListener('pagehide', () => chrome.runtime.sendMessage({ type: 'rec-state', state: null }).catch(() => {}));
  window.addEventListener('resize', () => view === 'setup' && renderSetup());
  navigator.mediaDevices.addEventListener('devicechange', fillDevices);

  /* ---------- recovery of interrupted recordings ---------- */

  const offerRecovery = async () => {
    const broken = (await S.recordings.list()).find((r) => !r.done);
    $('recover').hidden = !broken;
    if (!broken) return;
    $('recoverText').textContent = `A recording from ${new Date(broken.ts).toLocaleString('en-GB')} was interrupted (${S.formatTime(broken.duration)}).`;
    $('recoverBtn').onclick = async () => {
      try {
        const record = await S.Recording.finalize(broken.id);
        $('recover').hidden = true;
        releaseDevices();
        await openReview(record);
      } catch (error) {
        problem(`Could not recover it: ${error.message}`);
        offerRecovery();
      }
    };
    $('recoverDrop').onclick = async () => {
      if (!confirm('Delete the interrupted recording? This cannot be undone.')) return;
      await S.recordings.remove(broken.id);
      offerRecovery();
    };
  };

  /* ---------- start ---------- */

  chrome.runtime.sendMessage({ type: 'rec-state', state: null }).catch(() => {});
  const wanted = new URLSearchParams(location.search).get('view');
  const record = wanted ? await S.recordings.get(wanted) : null;
  if (record?.done) await openReview(record);
  else {
    show('setup');
    renderSetup();
    await offerRecovery();
    await fillDevices();
    await openDevices();
  }
})();
