/* Tiny always-on script: detects the "5 5" / "5 5 5" key sequence in every frame. */
(() => {
  window.__snap5Trigger?.destroy();

  let settings = { enabled: true, triggerCode: 'Digit5', interval: 350, ignoreInputs: true, disabledSites: [] };
  let count = 0;
  let last = 0;
  let timer = null;

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  const load = () => {
    if (!alive()) return;
    chrome.storage.sync.get(settings, (value) => { if (value) settings = value; });
  };
  const onStorage = () => load();
  load();
  chrome.storage.onChanged.addListener(onStorage);

  const reset = () => {
    count = 0;
    clearTimeout(timer);
    timer = null;
  };

  const isEditable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable || document.designMode === 'on') return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      return !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'color', 'range'].includes(el.type);
    }
    const role = el.getAttribute('role');
    return role === 'textbox' || role === 'combobox' || role === 'searchbox';
  };

  const deepTarget = (event) => {
    let el = event.composedPath()[0] || event.target;
    // Closed shadow roots only expose the host; fall back to the focused element.
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  const siteDisabled = () => {
    const host = location.hostname;
    return (settings.disabledSites || []).some((s) => host === s || host.endsWith('.' + s));
  };

  const matches = (code) => {
    if (code === settings.triggerCode) return true;
    const a = /^(?:Digit|Numpad)(\d)$/.exec(code);
    const b = /^(?:Digit|Numpad)(\d)$/.exec(settings.triggerCode);
    return !!a && !!b && a[1] === b[1];
  };

  const fire = (times) => {
    reset();
    if (!alive()) return;
    chrome.runtime.sendMessage({ type: 'sequence', times }).catch(() => {});
  };

  const onKeyDown = (event) => {
    // While the capture overlay is open it owns the keyboard.
    if (window.__snap5KeyHandler) {
      window.__snap5KeyHandler(event);
      return;
    }
    if (!event.isTrusted || !settings.enabled) return;
    if (!matches(event.code) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      reset();
      return;
    }
    if (event.repeat || event.isComposing) return;
    if ((settings.ignoreInputs && isEditable(deepTarget(event))) || siteDisabled()) {
      reset();
      return;
    }
    const now = performance.now();
    if (now - last > settings.interval) count = 0;
    last = now;
    count += 1;
    clearTimeout(timer);
    if (count >= 3) fire(3);
    else if (count === 2) timer = setTimeout(() => fire(2), settings.interval);
  };

  const swallow = (event) => {
    if (window.__snap5KeyHandler) event.stopImmediatePropagation();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', swallow, true);
  window.addEventListener('keypress', swallow, true);

  window.__snap5Trigger = {
    destroy() {
      reset();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', swallow, true);
      window.removeEventListener('keypress', swallow, true);
      try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    },
  };
})();
