importScripts('lib/common.js', 'lib/db.js');

const S = globalThis.Snap5;

const PAGE_FILES = [
  'lib/common.js',
  'lib/export.js',
  'lib/annotator.js',
  'lib/toolbar.js',
  'content/ui.js',
  'content/overlay.js',
  'content/page-capture.js',
  'content/agent.js',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = new Set();
const cancelled = new Set();

/* ---------- helpers ---------- */

const blobToDataUrl = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
};

const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

/* Chrome allows only 2 captureVisibleTab calls per second. */
let lastShot = 0;
let shotQueue = Promise.resolve();
const captureVisible = (windowId) => {
  const task = shotQueue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastShot + 520 - Date.now();
      if (wait > 0) await sleep(wait);
      lastShot = Date.now();
      try {
        return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      } catch (error) {
        if (attempt >= 3 || !/MAX_CAPTURE|readback|capture/i.test(error.message)) throw error;
        await sleep(600);
      }
    }
  });
  shotQueue = task.catch(() => {});
  return task;
};

const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

const ensureAgent = async (tabId) => {
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => !!globalThis.__snap5Agent,
  });
  if (!probe?.result) await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_FILES });
};

const toPage = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 });

const flashBadge = async (text, color = '#e11d48', ms = 2500) => {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  if (ms) setTimeout(async () => setRecordingBadge(await getRecording()), ms);
};

const openPage = async (path, near) => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(path),
    ...(near ? { index: near.index + 1, windowId: near.windowId } : {}),
  });
};

const openEditorWithBlob = async (blob, tab, query = '') => {
  const id = await S.db.add(blob, { title: tab?.title, url: tab?.url, temp: true });
  await openPage(`pages/editor.html?id=${id}${query}`, tab);
};

const remember = async (blob, meta) => {
  const settings = await S.getSettings();
  if (!settings.saveHistory) return null;
  const id = await S.db.add(blob, meta);
  await S.db.prune(settings.historyLimit);
  return id;
};

/* ---------- full page ---------- */

const stitchFullPage = async (tab) => {
  const tabId = tab.id;
  const info = await toPage(tabId, { type: 'fp-prepare' });
  const settings = await S.getSettings();
  let canvas;
  let ctx;
  let scale = 1; // source pixels per CSS pixel
  let fit = 1; // extra down-scale for very tall pages
  let lastFrame = null;
  let drawnTo = 0;
  const { viewW, viewH, area } = info;
  const maxScroll = () => Math.max(0, info.scrollHeight - area.h);

  try {
    let y = 0;
    let first = true;
    for (let i = 0; i < 400; i++) {
      if (cancelled.has(tabId)) throw new Error('CANCELLED');
      const step = await toPage(tabId, {
        type: 'fp-scroll',
        y,
        first,
        last: y >= maxScroll() - 1,
        delay: settings.scrollDelay,
      });
      if (step.cancelled) throw new Error('CANCELLED');

      const now = await chrome.tabs.get(tabId);
      if (!now.active) throw new Error('The tab changed, so the full page capture stopped');
      const frame = await createImageBitmap(await dataUrlToBlob(await captureVisible(tab.windowId)));

      if (first) {
        // Page height is locked at the first frame so infinite feeds still finish.
        info.scrollHeight = Math.min(step.scrollHeight, 60000);
        scale = frame.width / viewW;
        const cssH = viewH + maxScroll();
        const rawW = frame.width;
        const rawH = cssH * scale;
        fit = Math.min(1, 32000 / rawH, Math.sqrt(180e6 / (rawW * rawH)));
        canvas = new OffscreenCanvas(Math.round(rawW * fit), Math.round(rawH * fit));
        ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = info.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(frame, 0, 0, canvas.width, Math.round(frame.height * fit));
        drawnTo = area.h;
      } else {
        // Draw only the rows not covered yet, so overlaps never leave seams or duplicates.
        const top = Math.max(drawnTo, step.y);
        const bottom = step.y + area.h;
        if (bottom > top) {
          const k = scale * fit;
          const sy = (area.y + (top - step.y)) * scale;
          const sh = (bottom - top) * scale;
          const dy = Math.round((area.y + top) * k);
          const dh = Math.round((area.y + bottom) * k) - dy;
          ctx.drawImage(frame, area.x * scale, sy, area.w * scale, sh, Math.round(area.x * k), dy, Math.round(area.w * k), dh);
          drawnTo = bottom;
        }
      }

      lastFrame?.close();
      lastFrame = frame;
      first = false;
      const total = maxScroll();
      flashBadge(`${total ? Math.min(99, Math.round((step.y / total) * 100)) : 99}%`, '#4f46e5', 0);
      if (step.y >= total - 1) break;
      const next = Math.min(total, step.y + Math.max(80, area.h - 2));
      if (next <= step.y) break;
      y = next;
    }

    // Anything under an inner scroll area (footers, bottom bars) moves to the very end.
    const below = viewH - (area.y + area.h);
    if (info.inner && below > 1 && lastFrame) {
      const k = scale * fit;
      ctx.drawImage(
        lastFrame,
        0, (area.y + area.h) * scale, lastFrame.width, below * scale,
        0, Math.round((area.y + area.h + maxScroll()) * k), canvas.width, Math.round(below * k),
      );
    }
  } finally {
    lastFrame?.close();
    await toPage(tabId, { type: 'fp-restore' }).catch(() => {});
  }
  return canvas.convertToBlob({ type: 'image/png' });
};

const captureFull = async (tab) => {
  await ensureAgent(tab.id);
  cancelled.delete(tab.id);
  let blob;
  try {
    blob = await stitchFullPage(tab);
  } finally {
    await setRecordingBadge(await getRecording());
  }
  const settings = await S.getSettings();
  const meta = { title: tab.title, url: tab.url };
  const id = (await remember(blob, meta)) || (await S.db.add(blob, { ...meta, temp: true }));

  if (settings.fullOpenEditor) {
    await openPage(`pages/editor.html?id=${id}&copy=1`, tab);
    return;
  }
  // Extension messages are capped at 64MB.
  if (blob.size > 44 * 1024 * 1024) {
    await openPage(`pages/editor.html?id=${id}&copy=1`, tab);
    return;
  }
  await toPage(tab.id, { type: 'fp-done', dataUrl: await blobToDataUrl(blob), id, title: tab.title });
};

/* ---------- other modes ---------- */

const restrictedFallback = async (tab, mode) => {
  // chrome:// pages and the Web Store do not allow scripts: capture and edit in our own tab.
  const blob = await dataUrlToBlob(await captureVisible(tab.windowId));
  await openEditorWithBlob(blob, tab, mode === 'area' ? '&tool=crop' : '&copy=1');
};

const capture = async (mode, tab, options = {}) => {
  tab ||= await activeTab();
  if (!tab?.id) return;
  if (mode === 'desktop') return openPage('pages/editor.html?desktop=1', tab);
  if (busy.has(tab.id)) return;
  busy.add(tab.id);
  try {
    try {
      await ensureAgent(tab.id);
    } catch {
      await restrictedFallback(tab, mode);
      if (mode === 'full') flashBadge('!');
      return;
    }
    const state = await toPage(tab.id, { type: 'state' });
    if (state?.overlayOpen) return;

    if (options.delay) {
      const result = await toPage(tab.id, { type: 'countdown', seconds: options.delay });
      if (result?.cancelled) return;
    }

    if (mode === 'full') {
      await captureFull(tab);
      return;
    }
    await toPage(tab.id, { type: 'hide-ui' });
    const dataUrl = await captureVisible(tab.windowId);
    if (mode === 'visible') {
      const id = await remember(await dataUrlToBlob(dataUrl), { title: tab.title, url: tab.url });
      await toPage(tab.id, { type: 'overlay', dataUrl, preset: 'all', id, title: tab.title });
    } else {
      await toPage(tab.id, { type: 'overlay', dataUrl, preset: mode, title: tab.title });
    }
  } catch (error) {
    if (error.message !== 'CANCELLED') {
      console.warn('Snap5:', error);
      flashBadge('ERR');
      toPage(tab.id, { type: 'toast', title: 'Could not take the screenshot', text: error.message }).catch(() => {});
    }
  } finally {
    busy.delete(tab.id);
    cancelled.delete(tab.id);
  }
};

/* ---------- screen recording ---------- */

const RECORDER = 'pages/recorder.html';

const getRecording = async () => (await chrome.storage.session.get('rec')).rec || null;

const recorderTab = async () => (await chrome.tabs.query({ url: chrome.runtime.getURL(RECORDER) + '*' }))[0];

const openRecorder = async (near) => {
  const existing = await recorderTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await openPage(RECORDER, near);
};

/* Page controls only live in the tab you are looking at. */
const showControls = async (tabId, state) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/rec-toolbar.js'] });
    await toPage(tabId, { type: 'rec-ui', state });
  } catch {
    // chrome:// pages and the Web Store cannot show controls; the popup and shortcut still work.
  }
};

const setRecordingBadge = async (state) => {
  if (!state) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Snap5' });
    return;
  }
  const text = state.status === 'countdown' ? String(state.seconds) : state.status === 'paused' ? 'II' : 'REC';
  await flashBadge(text, state.status === 'paused' ? '#b45309' : '#dc2626', 0);
  await chrome.action.setTitle({ title: 'Snap5: recording' });
};

const applyRecording = async (state, recorderId) => {
  const previous = await getRecording();
  if (state) await chrome.storage.session.set({ rec: { ...state, tabId: recorderId } });
  else await chrome.storage.session.remove('rec');
  await setRecordingBadge(state);
  if (state) {
    const visible = await chrome.tabs.query({ active: true });
    await Promise.all(visible.filter((t) => t.id !== recorderId).map((t) => showControls(t.id, state)));
  } else if (previous) {
    const all = await chrome.tabs.query({});
    all.forEach((t) => toPage(t.id, { type: 'rec-ui', state: null }).catch(() => {}));
  }
};

/* Updates arrive quickly during a countdown, so they are applied strictly in order. */
let recordingQueue = Promise.resolve();
const queueRecording = (state, recorderId) => {
  recordingQueue = recordingQueue.then(() => applyRecording(state, recorderId)).catch((e) => console.warn('Snap5:', e.message));
  return recordingQueue;
};

const followTab = async (tabId) => {
  const rec = await getRecording();
  if (!rec || rec.tabId === tabId) return;
  const now = Date.now();
  const elapsed = rec.status === 'recording' ? rec.elapsed + (now - rec.at) : rec.elapsed;
  await showControls(tabId, { ...rec, elapsed, at: now });
};

chrome.tabs.onActivated.addListener(({ tabId }) => followTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' && tab.active) followTab(tabId);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getRecording())?.tabId === tabId) queueRecording(null);
});

const recorderCommand = (cmd) => chrome.runtime.sendMessage({ type: 'recorder-cmd', cmd }).catch(() => {});

const toggleRecording = async (tab) => {
  if (await getRecording()) recorderCommand('stop');
  else await openRecorder(tab);
};

/* ---------- messages ---------- */

const handlers = {
  async 'rec-state'(msg, sender) {
    await queueRecording(msg.state, sender.tab?.id);
  },
  async 'rec-cmd'(msg) {
    recorderCommand(msg.cmd);
  },
  async 'open-recorder'(msg, sender) {
    await openRecorder(sender.tab);
  },
  async sequence(msg, sender) {
    if (!sender.tab?.active) return;
    capture(msg.times >= 3 ? 'full' : 'area', sender.tab);
  },
  async capture(msg) {
    capture(msg.mode, null, { delay: msg.delay });
  },
  async 'fp-cancel'(msg, sender) {
    cancelled.add(sender.tab.id);
  },
  async download(msg) {
    await chrome.downloads.download({ url: msg.dataUrl, filename: msg.filename, saveAs: !!msg.saveAs });
    return { ok: true };
  },
  async 'history-add'(msg, sender) {
    await remember(await dataUrlToBlob(msg.dataUrl), { title: sender.tab?.title, url: sender.tab?.url });
    return { ok: true };
  },
  async 'open-editor'(msg, sender) {
    const query = msg.copy ? '&copy=1' : '';
    if (msg.id && (await S.db.get(msg.id))) await openPage(`pages/editor.html?id=${msg.id}${query}`, sender.tab);
    else await openEditorWithBlob(await dataUrlToBlob(msg.dataUrl), sender.tab, query);
    return { ok: true };
  },
  async 'open-page'(msg, sender) {
    await openPage(msg.path, sender.tab);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(msg, sender).then(
    (result) => sendResponse(result ?? { ok: true }),
    (error) => sendResponse({ ok: false, error: error.message }),
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const settings = await S.getSettings();
  if (command === 'toggle-recording') await toggleRecording(tab);
  else if (command === 'pause-recording') recorderCommand('toggle');
  else if (command === 'capture-delayed') capture('area', tab, { delay: settings.delaySeconds });
  else capture(command.replace('capture-', ''), tab);
});

/* ---------- context menu and install ---------- */

const MENUS = [
  { id: 'area', title: 'Capture area' },
  { id: 'visible', title: 'Capture visible part' },
  { id: 'full', title: 'Capture full page (auto copy)' },
  { id: 'element', title: 'Capture an element' },
];

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'edit-image') {
    try {
      const blob = await dataUrlToBlob(info.srcUrl);
      if (!blob.type.startsWith('image/')) throw new Error('not an image');
      await openEditorWithBlob(blob, tab);
    } catch {
      flashBadge('ERR');
    }
    return;
  }
  if (info.menuItemId === 'record') openRecorder(tab);
  else capture(info.menuItemId, tab);
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'snap5', title: 'Snap5 screenshot', contexts: ['page', 'selection', 'link', 'image'] });
  for (const menu of MENUS) {
    chrome.contextMenus.create({ ...menu, parentId: 'snap5', contexts: ['page', 'selection', 'link', 'image'] });
  }
  chrome.contextMenus.create({ id: 'record', parentId: 'snap5', title: 'Record screen', contexts: ['page', 'selection', 'link', 'image'] });
  chrome.contextMenus.create({ id: 'edit-image', parentId: 'snap5', title: 'Edit this image', contexts: ['image'] });

  // Make already-open tabs work immediately, without a reload.
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] })) {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          window.__snap5Trigger?.destroy();
          document.querySelectorAll('snap5-root, snap5-rec').forEach((n) => n.remove());
          window.__snap5KeyHandler = null;
          delete globalThis.Snap5;
          delete globalThis.__snap5Agent;
          delete globalThis.__snap5Rec;
        },
      })
      .then(() => chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/trigger.js'] }))
      .catch(() => {});
  }
});
