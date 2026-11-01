// Builds dist/Vitrine-Windows-x64.zip and site/release.js. Run on Windows: node packaging/build.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'app');
const dist = path.join(root, 'dist');
const zipName = 'Vitrine-Windows-x64.zip';
const nodeVersion = 'v24.22.2';
const nodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2';
const nodeName = `node-${nodeVersion}-win-x64`;
const { version } = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrine-build-'));
try {
  console.log(`Downloading Node ${nodeVersion}`);
  const res = await fetch(`https://nodejs.org/dist/${nodeVersion}/${nodeName}.zip`);
  if (!res.ok) throw new Error(`Node download failed (${res.status})`);
  const nodeZip = Buffer.from(await res.arrayBuffer());
  if (sha256(nodeZip) !== nodeSha256) throw new Error('Node download does not match its checksum');
  const nodeZipPath = path.join(work, 'node.zip');
  fs.writeFileSync(nodeZipPath, nodeZip);
  execFileSync(tar, ['-xf', nodeZipPath, '-C', work]);

  const out = path.join(work, 'Vitrine');
  const appOut = path.join(out, 'app');
  const runtime = path.join(out, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(path.join(work, nodeName, 'node.exe'), path.join(runtime, 'node.exe'));
  fs.copyFileSync(path.join(work, nodeName, 'LICENSE'), path.join(runtime, 'NODE-LICENSE.txt'));

  // An allow-list, so a local data folder can never end up in the download.
  fs.mkdirSync(appOut);
  for (const item of ['server', 'public', 'shared', 'plugins', 'package.json', 'package-lock.json']) {
    fs.cpSync(path.join(app, item), path.join(appOut, item), { recursive: true });
  }
  fs.mkdirSync(path.join(appOut, 'scripts'));
  fs.copyFileSync(path.join(app, 'scripts', 'kiosk-windows.ps1'), path.join(appOut, 'scripts', 'kiosk-windows.ps1'));
  fs.copyFileSync(path.join(root, 'packaging', 'launcher.mjs'), path.join(appOut, 'launcher.mjs'));
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appOut, stdio: 'inherit', shell: true });

  for (const name of ['Start Vitrine.cmd', 'README.txt']) {
    const text = fs.readFileSync(path.join(root, 'packaging', name), 'utf8').replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(out, name), text);
  }

  fs.mkdirSync(dist, { recursive: true });
  const zipPath = path.join(dist, zipName);
  fs.rmSync(zipPath, { force: true });
  execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', work, 'Vitrine']);

  const zip = fs.readFileSync(zipPath);
  const release = { version, sizeMb: Math.round(zip.length / 1048576), sha256: sha256(zip) };
  fs.writeFileSync(path.join(root, 'site', 'release.js'),
    `// Written by packaging/build.mjs. Do not edit by hand.\nwindow.VITRINE_RELEASE = ${JSON.stringify(release, null, 2)};\n`);
  console.log(`${zipPath}\n${release.sizeMb} MB, version ${version}\nSHA-256 ${release.sha256}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
