const defaults = { serverUrl: 'http://127.0.0.1:4317', maxSteps: 12, includeScreenshot: true };
chrome.storage.sync.get(defaults).then(s => {
  for (const [k, v] of Object.entries(s)) { const el = document.querySelector(`#${k}`); if (!el) continue; if (el.type === 'checkbox') el.checked = v; else el.value = v; }
});
document.querySelector('#save').onclick = async () => {
  const rawServerUrl = document.querySelector('#serverUrl').value.trim();
  let serverUrl;
  try {
    const parsed = new URL(rawServerUrl);
    const port = Number(parsed.port);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
        parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname !== '/' || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        /[\s\\]/.test(rawServerUrl)) throw new Error('invalid endpoint');
    serverUrl = `http://127.0.0.1:${port}`;
  } catch {
    document.querySelector('#saved').textContent = 'CAPTAIN server must use http://127.0.0.1 with an explicit local port';
    return;
  }
  await chrome.storage.sync.set({ serverUrl, maxSteps: Number(document.querySelector('#maxSteps').value), includeScreenshot: document.querySelector('#includeScreenshot').checked });
  document.querySelector('#saved').textContent = 'Saved — reopen the CAPTAIN controller'; setTimeout(() => document.querySelector('#saved').textContent = '', 2500);
};
