/* Connects the shared selection overlay to the Mac app: clipboard, files, pins and notices. */
(() => {
  const S = globalThis.Snap5;
  const native = window.snap5Native;
  const toDataUrl = async (blobOrPromise) => S.exporter.blobToDataUrl(await blobOrPromise);

  // The Mac clipboard and notices replace their browser versions.
  S.exporter.copyImage = async (blobOrPromise) => {
    const reply = await native({ type: 'copy', dataUrl: await toDataUrl(blobOrPromise) });
    if (!reply?.ok) throw new Error('Could not copy');
  };
  S.exporter.copyText = (text) => native({ type: 'copy-text', text });
  S.ui.toast = ({ title }) => native({ type: 'notice', title });
  S.ui.pin = (dataUrl, rect) => native({ type: 'pin', dataUrl, rect });

  window.addEventListener('keydown', (event) => window.__snap5KeyHandler?.(event), true);
  window.addEventListener('error', (event) => native({ type: 'log', text: `${event.message} (${event.filename}:${event.lineno})` }));

  window.snap5Start = async ({ dataUrl, windows, settings, preset }) => {
    window.snap5Settings = settings;
    // Back-most first, so the front window is on top.
    for (const w of [...windows].reverse()) {
      const box = document.createElement('div');
      box.className = 'mac-window';
      Object.assign(box.style, { left: `${w.x}px`, top: `${w.y}px`, width: `${w.w}px`, height: `${w.h}px` });
      document.body.append(box);
    }
    await S.overlay.start({ dataUrl, preset, title: '' });

    const root = S.ui.host.shadowRoot;
    const style = document.createElement('style');
    // Browser-only buttons.
    style.textContent = '[data-action="editor"],[data-action="full"]{display:none!important}';
    root.append(style);
    for (const button of root.querySelectorAll('.hint button')) {
      if (button.textContent.startsWith('Full page')) button.textContent = 'Whole screen (F)';
    }
    const watcher = new MutationObserver(() => {
      if (root.querySelector('.ov')) return;
      watcher.disconnect();
      native({ type: 'closed' });
    });
    watcher.observe(root, { childList: true });
    native({ type: 'ready' });
  };
})();
