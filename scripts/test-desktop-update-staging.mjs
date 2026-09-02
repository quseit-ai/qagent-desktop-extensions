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

function buildQdu(brandId, versionCode) {
  const asar = Buffer.from(`${brandId}-asar`);
  const pack = Buffer.from(`${brandId}-pack`);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    versionCode,
    version: null,
    brandId,
    platform: 'win32',
    arch: 'x64',
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

const packages = new Map([
  ['/qagent.qdu', buildQdu('qagent', 101)],
  ['/eduai.qdu', buildQdu('eduai', 202)],
]);
const server = http.createServer((request, response) => {
  const payload = packages.get(request.url);
  if (!payload) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Length': payload.length });
  response.end(payload);
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  for (const [brandId, versionCode] of [['qagent', 101], ['eduai', 202]]) {
    const payload = packages.get(`/${brandId}.qdu`);
    const dir = path.join(temp, 'desktop', brandId, 'stable', 'windows-x64');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'source.json'), JSON.stringify({
      brandId,
      channel: 'stable',
      platform: 'win32',
      arch: 'x64',
      versionCode,
      fileName: `${brandId}-desktop-${versionCode}.qdu`,
      releaseUrl: `http://127.0.0.1:${port}/${brandId}.qdu`,
      size: payload.length,
      sha256: sha256(payload),
    }));
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--all', 'dist'], { cwd: temp, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`stager exited ${code}`)));
  });
  for (const [brandId, versionCode] of [['qagent', 101], ['eduai', 202]]) {
    const update = JSON.parse(await readFile(path.join(temp, 'dist', 'desktop', brandId, 'stable', 'windows-x64', 'update.json')));
    if (update.brandId !== brandId || update.versionCode !== versionCode) throw new Error(`wrong staged update for ${brandId}`);
  }
  console.log('desktop update staging test passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
