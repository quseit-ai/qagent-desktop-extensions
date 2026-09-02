import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sourcePath = 'desktop/stable/windows-x64/source.json', outputRoot = 'dist'] = process.argv.slice(2);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function validateQdu(buffer, expectedVersionCode) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('ascii') !== 'QDU1') throw new Error('invalid QDU magic');
  const manifestSize = buffer.readUInt32BE(4);
  if (!manifestSize || manifestSize > 1024 * 1024 || 8 + manifestSize > buffer.length) throw new Error('invalid QDU manifest size');
  const manifest = JSON.parse(buffer.subarray(8, 8 + manifestSize).toString('utf8'));
  if (manifest.schemaVersion !== 1 || Number(manifest.versionCode) !== Number(expectedVersionCode)) throw new Error('QDU versionCode mismatch');
  let offset = 8 + manifestSize;
  for (const name of ['app.asar', 'app.pack']) {
    const descriptor = manifest.files?.[name];
    if (!descriptor || !Number.isInteger(descriptor.size) || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '')) throw new Error(`invalid ${name} descriptor`);
    const payload = buffer.subarray(offset, offset + descriptor.size);
    if (payload.length !== descriptor.size || sha256(payload) !== descriptor.sha256) throw new Error(`${name} verification failed`);
    offset += descriptor.size;
  }
  if (offset !== buffer.length) throw new Error('unexpected trailing QDU data');
}

const source = JSON.parse(await readFile(sourcePath, 'utf8'));
if (!Number.isInteger(source.versionCode) || !source.releaseUrl || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('invalid desktop source manifest');
const response = await fetch(source.releaseUrl, { redirect: 'follow' });
if (!response.ok) throw new Error(`QDU download failed: HTTP ${response.status}`);
const qdu = Buffer.from(await response.arrayBuffer());
if (qdu.length !== source.size || sha256(qdu) !== source.sha256) throw new Error('QDU artifact verification failed');
await validateQdu(qdu, source.versionCode);

const relativeDir = path.join('desktop', 'stable', 'windows-x64');
const releaseDir = path.join(outputRoot, relativeDir, 'releases', String(source.versionCode));
await mkdir(releaseDir, { recursive: true });
await writeFile(path.join(releaseDir, source.fileName), qdu);
const update = {
  schemaVersion: 2,
  versionCode: source.versionCode,
  version: source.version || null,
  package: {
    url: `releases/${source.versionCode}/${source.fileName}`,
    size: source.size,
    sha256: source.sha256,
  },
};
await mkdir(path.join(outputRoot, relativeDir), { recursive: true });
await writeFile(path.join(outputRoot, relativeDir, 'update.json'), JSON.stringify(update, null, 2) + '\n');
console.log(`staged desktop update v${source.versionCode}`);
