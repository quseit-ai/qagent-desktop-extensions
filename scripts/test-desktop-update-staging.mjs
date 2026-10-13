import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage-desktop-update.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'desktop-update-stage-'));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function buildQdu(brandId, versionCode, platform, arch) {
  const asar = Buffer.from(`${brandId}-asar`);
  const pack = Buffer.from(`${brandId}-pack`);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    versionCode,
    version: null,
    brandId,
    platform,
    arch,
    files: {
      'app.asar': { size: asar.length, sha256: sha256(asar) },
      'app.pack': { size: pack.length, sha256: sha256(pack) },
    },
  }));
  const header = Buffer.alloc(8);
  header.write('QDU1');
  header.writeUInt32BE(manifest.length, 4);
  return Buffer.concat([header, manifest, asar, pack]);
}

// qagent is deliberately released for two targets at different version codes so
// the brand-level version check has to pick the newest one rather than the last
// source it happened to walk.
const cases = [
  { brandId: 'qagent', versionCode: 101, platform: 'win32', arch: 'x64' },
  { brandId: 'eduai', versionCode: 202, platform: 'win32', arch: 'x64' },
  { brandId: 'qagent', versionCode: 104, platform: 'darwin', arch: 'arm64' },
];
const expectedBrandVersion = new Map([['qagent', 104], ['eduai', 202]]);

function platformDir(item) {
  return `${item.platform === 'win32' ? 'windows' : item.platform}-${item.arch}`;
}

const packages = new Map();
for (const item of cases) {
  packages.set(
    `/${item.brandId}-${item.platform}-${item.arch}.qdu`,
    buildQdu(item.brandId, item.versionCode, item.platform, item.arch)
  );
}

const server = http.createServer((request, response) => {
  const payload = packages.get(request.url);
  if (!payload) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Length': payload.length });
  response.end(payload);
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  for (const item of cases) {
    const payload = packages.get(`/${item.brandId}-${item.platform}-${item.arch}.qdu`);
    const dir = path.join(temp, 'desktop', item.brandId, 'stable', platformDir(item));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'source.json'), JSON.stringify({
      brandId: item.brandId,
      channel: 'stable',
      platform: item.platform,
      arch: item.arch,
      versionCode: item.versionCode,
      fileName: `${item.brandId}-desktop-${item.versionCode}.qdu`,
      releaseUrl: `http://127.0.0.1:${port}/${item.brandId}-${item.platform}-${item.arch}.qdu`,
      size: payload.length,
      sha256: sha256(payload),
    }));
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--all', 'dist'], { cwd: temp, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`stager exited ${code}`)));
  });
  for (const item of cases) {
    const update = JSON.parse(await readFile(path.join(temp, 'dist', 'desktop', item.brandId, 'stable', platformDir(item), 'update.json')));
    if (update.brandId !== item.brandId || update.versionCode !== item.versionCode) throw new Error(`wrong staged update for ${item.brandId}`);
  }
  for (const [brandId, versionCode] of expectedBrandVersion) {
    const check = JSON.parse(await readFile(path.join(temp, 'dist', 'desktop', brandId, 'update.json')));
    if (check.versionCode !== versionCode) throw new Error(`wrong brand version check for ${brandId}: ${check.versionCode}`);
    if (check.brandId !== brandId) throw new Error(`wrong brand id in version check for ${brandId}`);
  }
  console.log('desktop update staging test passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
