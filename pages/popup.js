(async () => {
  const S = globalThis.Snap5;
  const settings = await S.getSettings();
  const $ = (id) => document.getElementById(id);
  const key = S.keyLabel(settings.triggerCode);

  document.querySelectorAll('[data-icon]').forEach((b) => b.insertAdjacentHTML('afterbegin', S.icon(b.dataset.icon)));
  document.querySelector('.key2').textContent = `${key} ${key}`;
  document.querySelector('.key3').textContent = `${key} ${key} ${key}`;
  $('keyName').textContent = key;
  $('delayText').textContent = String(settings.delaySeconds);

  const commands = await chrome.commands.getAll();
  document.querySelectorAll('[data-command]').forEach((node) => {
    const shortcut = commands.find((c) => c.name === node.dataset.command)?.shortcut;
    if (shortcut) node.textContent = shortcut;
    else node.remove();
  });

  $('enabled').checked = settings.enabled;
  $('enabled').addEventListener('change', (e) => chrome.storage.sync.set({ enabled: e.target.checked }));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (/^https?:/.test(tab?.url || '')) {
    const host = new URL(tab.url).hostname;
    $('siteRow').hidden = false;
    $('siteText').textContent = `Turn the ${key} key off on ${host}`;
    $('siteOff').checked = settings.disabledSites.includes(host);
    $('siteOff').addEventListener('change', (e) => {
      const sites = new Set(settings.disabledSites);
      e.target.checked ? sites.add(host) : sites.delete(host);
      settings.disabledSites = [...sites];
      chrome.storage.sync.set({ disabledSites: settings.disabledSites });
    });
  }

  document.querySelectorAll('[data-mode]').forEach((button) =>
    button.addEventListener('click', async () => {
      const mode = button.dataset.mode;
      await chrome.runtime.sendMessage(
        mode === 'delayed' ? { type: 'capture', mode: 'area', delay: settings.delaySeconds } : { type: 'capture', mode },
      );
      window.close();
    }),
  );

  document.querySelectorAll('[data-page]').forEach((button) =>
    button.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(button.dataset.page) });
      window.close();
    }),
  );
})();
