import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sourceArg = '--all', outputRoot = 'dist'] = process.argv.slice(2);

function validateIdentity(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function validateQdu(buffer, source) {
  if (buffer.length < 8 || buffer.subarray(0, 4).toString('ascii') !== 'QDU1') throw new Error('invalid QDU magic');
  const manifestSize = buffer.readUInt32BE(4);
  if (!manifestSize || manifestSize > 1024 * 1024 || 8 + manifestSize > buffer.length) throw new Error('invalid QDU manifest size');
  const manifest = JSON.parse(buffer.subarray(8, 8 + manifestSize).toString('utf8'));
  if (manifest.schemaVersion !== 1 || Number(manifest.versionCode) !== Number(source.versionCode)) throw new Error('QDU versionCode mismatch');
  if (manifest.brandId !== source.brandId) throw new Error('QDU brandId mismatch');
  if (manifest.platform !== source.platform || manifest.arch !== source.arch) throw new Error('QDU platform mismatch');
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

async function findSources(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(item);
      else if (entry.name === 'source.json') found.push(item);
    }
  }
  try { await walk(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return found.sort();
}

async function stageSource(sourcePath) {
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  validateIdentity(source.brandId, 'brandId');
  validateIdentity(source.platform, 'platform');
  validateIdentity(source.arch, 'arch');
  validateIdentity(source.channel || 'stable', 'channel');
  if (!Number.isInteger(source.versionCode) || !source.releaseUrl || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('invalid desktop source manifest');
  const response = await fetch(source.releaseUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`QDU download failed: HTTP ${response.status}`);
  const qdu = Buffer.from(await response.arrayBuffer());
  if (qdu.length !== source.size || sha256(qdu) !== source.sha256) throw new Error('QDU artifact verification failed');
  validateQdu(qdu, source);

  const platformDir = `${source.platform === 'win32' ? 'windows' : source.platform}-${source.arch}`;
  const relativeDir = path.join('desktop', source.brandId, source.channel || 'stable', platformDir);
  const releaseDir = path.join(outputRoot, relativeDir, 'releases', String(source.versionCode));
  await mkdir(releaseDir, { recursive: true });
  await writeFile(path.join(releaseDir, source.fileName), qdu);
  const update = {
    schemaVersion: 2,
    versionCode: source.versionCode,
    version: source.version || null,
    brandId: source.brandId,
    platform: source.platform,
    arch: source.arch,
    package: { url: `releases/${source.versionCode}/${source.fileName}`, size: source.size, sha256: source.sha256 },
  };
  await mkdir(path.join(outputRoot, relativeDir), { recursive: true });
  await writeFile(path.join(outputRoot, relativeDir, 'update.json'), JSON.stringify(update, null, 2) + '\n');
  console.log(`staged ${source.brandId} desktop update v${source.versionCode}`);
}

const sourcePaths = sourceArg === '--all' ? await findSources('desktop') : [sourceArg];
for (const sourcePath of sourcePaths) await stageSource(sourcePath);
