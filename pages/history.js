(async () => {
  const S = globalThis.Snap5;
  const grid = document.getElementById('grid');
  const settings = await S.getSettings();
  let urls = [];

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  let tab = location.hash === '#recordings' ? 'recordings' : 'shots';

  const renderRecordings = async () => {
    const list = (await S.recordings.list()).filter((r) => r.done);
    const empty = document.getElementById('empty');
    empty.textContent = 'No recordings yet.';
    empty.hidden = list.length > 0;
    for (const item of list) {
      const thumb = item.thumb ? URL.createObjectURL(item.thumb) : '../icons/128.png';
      if (item.thumb) urls.push(thumb);
      const open = () => chrome.tabs.create({ url: chrome.runtime.getURL(`pages/recorder.html?view=${item.id}`) });
      const name = item.title || `Recording ${new Date(item.ts).toLocaleString('en-GB')}`;
      const download = el('button', {
        className: 'btn',
        textContent: 'Download',
        onclick: async () => {
          const url = URL.createObjectURL(item.blob);
          await chrome.downloads.download({ url, filename: S.fileName({ ...settings, filename: 'Snap5_Recording_{date}_{time}' }, item.ext) });
          setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
        },
      });
      const remove = el('button', {
        className: 'btn danger',
        textContent: 'Delete',
        onclick: async () => {
          if (!confirm('Delete this recording? This cannot be undone.')) return;
          await S.recordings.remove(item.id);
          render();
        },
      });
      grid.append(
        el('article', { className: 'shot' },
          el('div', { className: 'thumb' }, el('img', { src: thumb, alt: name, onclick: open }), el('span', { textContent: S.formatTime(item.duration) })),
          el('div', { className: 'meta' },
            el('b', { textContent: name, title: name }),
            el('small', { textContent: `${new Date(item.ts).toLocaleString('en-GB')} · ${S.formatSize(item.size)} · ${item.ext.toUpperCase()}` })),
          el('div', { className: 'row' }, el('button', { className: 'btn main', textContent: 'Open', onclick: open }), download, remove),
        ),
      );
    }
  };

  let renderId = 0;
  const render = async () => {
    const mine = ++renderId;
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    document.getElementById('clear').hidden = tab !== 'shots';
    const shots = tab === 'shots' ? await S.db.list() : [];
    if (mine !== renderId) return;
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    grid.replaceChildren();
    if (tab === 'recordings') return renderRecordings();
    document.getElementById('empty').textContent = 'No screenshots yet.';
    document.getElementById('empty').hidden = shots.length > 0;
    document.getElementById('clear').disabled = !shots.length;

    for (const shot of shots) {
      const thumb = URL.createObjectURL(shot.thumb);
      urls.push(thumb);
      const open = () => chrome.tabs.create({ url: chrome.runtime.getURL(`pages/editor.html?id=${shot.id}`) });
      const copy = el('button', { className: 'btn', textContent: 'Copy' });
      copy.addEventListener('click', async () => {
        try {
          await S.exporter.copyImage(shot.blob);
          copy.textContent = '✓ Done';
        } catch {
          copy.textContent = 'Failed';
        }
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      });
      const download = el('button', {
        className: 'btn',
        textContent: 'Download',
        onclick: async () => {
          const url = URL.createObjectURL(shot.blob);
          await chrome.downloads.download({ url, filename: S.fileName(settings, 'png', shot.title) });
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        },
      });
      const remove = el('button', {
        className: 'btn danger',
        textContent: 'Delete',
        onclick: async () => {
          await S.db.remove(shot.id);
          render();
        },
      });
      grid.append(
        el('article', { className: 'shot' },
          el('img', { src: thumb, alt: shot.title || 'Screenshot', onclick: open }),
          el('div', { className: 'meta' },
            el('b', { textContent: shot.title || 'Screenshot', title: shot.url || '' }),
            el('small', { textContent: `${new Date(shot.ts).toLocaleString('en-GB')} · ${shot.width}×${shot.height}` })),
          el('div', { className: 'row' }, el('button', { className: 'btn main', textContent: 'Edit', onclick: open }), copy, download, remove),
        ),
      );
    }
  };

  document.getElementById('clear').addEventListener('click', async () => {
    if (!confirm('Delete every screenshot in history? This cannot be undone.')) return;
    await S.db.clear();
    render();
  });

  document.querySelectorAll('[data-tab]').forEach((button) =>
    button.addEventListener('click', () => {
      tab = button.dataset.tab;
      history.replaceState(null, '', tab === 'recordings' ? '#recordings' : '#');
      render();
    }),
  );
  document.addEventListener('visibilitychange', () => !document.hidden && render());
  render();
})();
