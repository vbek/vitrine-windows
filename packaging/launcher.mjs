// Starts Vitrine for the Windows download: data in the user's profile, owner setup limited to this PC.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3400);
const url = `http://localhost:${PORT}`;

// In the profile, not the app folder, so replacing the app with a new version keeps the data.
process.env.VITRINE_DATA_DIR ||= path.join(process.env.LOCALAPPDATA || os.homedir(), 'Vitrine', 'data');
process.env.VITRINE_LOCAL_SETUP = 'true';
process.env.PORT = String(PORT);

const openBrowser = () => process.env.VITRINE_NO_BROWSER || spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();


const portInUse = () => new Promise((resolve) => {
  const socket = net.connect({ port: PORT, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

const isVitrine = async () => {
  try {
    const state = await (await fetch(`http://127.0.0.1:${PORT}/api/auth/state`, { signal: AbortSignal.timeout(2000) })).json();
    return typeof state.needsSetup === 'boolean';
  } catch { return false; }
};

if (await portInUse()) {
  if (await isVitrine()) {
    console.log('Vitrine is already running, so this opened it in your browser.');
    openBrowser();
    process.exit(0);
  }
  console.error(`Another program is using port ${PORT}. Close it, then start Vitrine again.`);
  process.exit(1);
}

await import('./server/index.js');

for (let i = 0; i < 50 && !(await isVitrine()); i++) await new Promise((r) => setTimeout(r, 200));
openBrowser();

const lan = Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'));
console.log(`
On this PC:  ${url}
Your data:   ${process.env.VITRINE_DATA_DIR}
`);
if (lan.length) {
  console.log('On a phone or another screen on the same Wi-Fi, try:');
  for (const n of lan) console.log(`  http://${n.address}:${PORT}`);
  console.log('If Windows asks, allow Vitrine on private networks.\n');
}
console.log('Keep this window open while you use Vitrine. Closing it stops Vitrine.');
