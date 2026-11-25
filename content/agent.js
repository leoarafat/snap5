/* Receives commands from the background worker. Injected on demand into the top frame. */
(() => {
  if (globalThis.__snap5Agent) return;
  globalThis.__snap5Agent = true;
  const S = globalThis.Snap5;

  const finishFullPage = async ({ dataUrl, id, title }) => {
    const settings = await S.getSettings();
    const blob = S.exporter.dataUrlToBlob(dataUrl);
    const send = (m) => chrome.runtime.sendMessage(m);

    const downloadAs = async (format) => {
      let url = dataUrl;
      if (format !== 'png') {
        const img = await S.exporter.loadImage(dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const out = format === 'pdf' ? await S.exporter.toPdf(canvas, { split: true }) : await S.exporter.toBlob(canvas, format, settings.jpgQuality);
        url = await S.exporter.blobToDataUrl(out);
      }
      await send({ type: 'download', dataUrl: url, filename: S.fileName(settings, format, title) });
    };

    let copied = true;
    try {
      await S.exporter.copyImage(blob);
    } catch {
      copied = false;
    }
    if (settings.fullAutoDownload) await downloadAs(settings.format);
    if (!copied && !document.hidden) {
      // The clipboard is blocked here (http page or lost focus): copy from the editor tab.
      await send({ type: 'open-editor', id, dataUrl, copy: true });
      return;
    }
    if (settings.sound) S.exporter.shutter();
    S.ui.toast({
      title: copied ? '✅ Full page copied' : 'Full page captured',
      text: copied ? 'Paste it anywhere with ⌘V and send' : 'Click a button below to copy',
      thumb: dataUrl,
      timeout: 12000,
      actions: [
        { label: '✏️ Edit / Mark up', main: true, onClick: () => send({ type: 'open-editor', id, dataUrl }) },
        { label: 'Download', onClick: () => downloadAs(settings.format) },
        { label: 'PDF', onClick: () => downloadAs('pdf') },
        { label: 'Copy again', keep: true, onClick: () => S.exporter.copyImage(blob).catch(() => send({ type: 'open-editor', id, dataUrl, copy: true })) },
      ],
    });
  };

  const handlers = {
    state: async () => ({ overlayOpen: S.overlay.isOpen }),
    'hide-ui': async () => S.ui.hideTransient(),
    countdown: async ({ seconds }) => S.ui.countdown(seconds),
    overlay: async (message) => S.overlay.start(message),
    toast: async ({ title, text }) => S.ui.toast({ title, text }),
    'fp-prepare': async () => S.pageCapture.prepare(),
    'fp-scroll': async (message) => S.pageCapture.scroll(message),
    'fp-restore': async () => S.pageCapture.restore(),
    'fp-done': async (message) => {
      finishFullPage(message).catch((e) => S.ui.toast({ title: 'Something went wrong', text: e.message }));
    },
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler || sender.id !== chrome.runtime.id) return false;
    handler(message).then(
      (result) => sendResponse(result ?? { ok: true }),
      (error) => {
        console.warn('Snap5:', error);
        sendResponse({ ok: false, error: error.message });
      },
    );
    return true;
  });
})();
