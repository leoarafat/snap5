(async () => {
  const S = globalThis.Snap5;
  const settings = await S.getSettings();
  const $ = (id) => document.getElementById(id);

  let timer;
  const save = async (patch) => {
    Object.assign(settings, patch);
    await chrome.storage.sync.set(patch);
    $('saved').classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => $('saved').classList.remove('show'), 1200);
  };

  document.querySelectorAll('[data-key]').forEach((input) => {
    const name = input.dataset.key;
    if (input.type === 'checkbox') input.checked = settings[name];
    else input.value = settings[name];
    input.addEventListener('change', () => {
      let value = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'number') {
        value = Math.min(+input.max, Math.max(+input.min, Number(value) || S.DEFAULTS[name]));
        input.value = value;
      }
      save({ [name]: value });
    });
  });

  const showKey = () => {
    const key = S.keyLabel(settings.triggerCode);
    $('triggerKey').value = key;
    document.querySelector('.k2').textContent = `${key} ${key}`;
    document.querySelector('.k3').textContent = `${key} ${key} ${key}`;
  };
  showKey();
  $('triggerKey').addEventListener('keydown', async (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (!/^(Digit\d|Numpad\d|Key[A-Z]|Backquote)$/.test(e.code)) return;
    await save({ triggerCode: e.code });
    showKey();
  });

  $('disabledSites').value = settings.disabledSites.join('\n');
  $('disabledSites').addEventListener('change', () => {
    const sites = $('disabledSites').value
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
      .filter(Boolean);
    $('disabledSites').value = sites.join('\n');
    save({ disabledSites: sites });
  });

  $('chromeShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
})();
