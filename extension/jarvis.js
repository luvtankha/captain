async function health() {
  if (document.hidden) return;
  try {
    const h = await fetch('http://127.0.0.1:4317/health').then(r => r.json());
    document.querySelector('#connection').textContent = h.ok ? 'Online' : 'Offline';
    document.querySelector('#dot').classList.toggle('online', !!h.ok);
  } catch { document.querySelector('#connection').textContent = 'Offline'; }
}
void health();
setInterval(health, 10000);
