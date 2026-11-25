/* Gives the extension's capture code the small part of the `chrome` API it uses,
   answered by the Mac app instead of the browser. */
(() => {
  const native = (message) => window.webkit.messageHandlers.snap5.postMessage(message);
  const area = (name) => {
    const read = () => {
      try { return JSON.parse(localStorage.getItem(name)) || {}; } catch { return {}; }
    };
    return {
      get: async (key) => (typeof key === 'string' ? { [key]: read()[key] } : read()),
      set: async (patch) => {
        try { localStorage.setItem(name, JSON.stringify({ ...read(), ...patch })); } catch {}
      },
    };
  };
  window.snap5Native = native;
  window.snap5Settings = {};
  window.chrome = {
    storage: { sync: { get: async () => window.snap5Settings, set: async () => {} }, local: area('snap5-local') },
    runtime: { id: 'snap5-mac', sendMessage: (message) => native(message) },
  };
})();
