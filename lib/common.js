/* Shared settings and helpers. Loaded in content scripts, extension pages and the service worker. */
(() => {
  const S = (globalThis.Snap5 ||= {});

  S.DEFAULTS = {
    enabled: true,
    triggerCode: 'Digit5',
    interval: 350,
    ignoreInputs: true,
    disabledSites: [],
    format: 'png',
    jpgQuality: 0.92,
    filename: 'Snap5_{date}_{time}',
    subfolder: '',
    saveHistory: true,
    historyLimit: 60,
    fullAutoDownload: false,
    fullOpenEditor: false,
    closeAfterCopy: true,
    sound: true,
    delaySeconds: 3,
    scrollDelay: 250,
  };

  S.getSettings = async () => ({ ...S.DEFAULTS, ...(await chrome.storage.sync.get(null)) });

  S.fileName = (settings, ext, title = '') => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const clean = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
    let name = (settings.filename || S.DEFAULTS.filename)
      .replaceAll('{date}', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
      .replaceAll('{time}', `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`)
      .replaceAll('{title}', clean(title).slice(0, 60));
    name = clean(name).replace(/^\.+/, '') || 'Snap5';
    const folder = String(settings.subfolder || '')
      .split('/')
      .map((part) => clean(part).replace(/^\.+/, ''))
      .filter(Boolean)
      .join('/');
    return `${folder ? folder + '/' : ''}${name}.${ext}`;
  };

  S.keyLabel = (code) => code.replace(/^Digit|^Key|^Numpad/, '');

  /* The number row and the numpad count as the same key. */
  S.matchesTrigger = (code, trigger) => {
    if (code === trigger) return true;
    const digit = /^(?:Digit|Numpad)(\d)$/;
    const a = digit.exec(code);
    const b = digit.exec(trigger);
    return !!a && !!b && a[1] === b[1];
  };
})();
