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

  const render = async () => {
    const shots = await S.db.list();
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    grid.replaceChildren();
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

  document.addEventListener('visibilitychange', () => !document.hidden && render());
  render();
})();
