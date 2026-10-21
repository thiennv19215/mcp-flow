import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILD_MARKER_RELATIVE_PATH = 'build-revision.js';

export async function fingerprintExtension(extensionDir) {
  const extensionRoot = resolve(extensionDir);
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '_metadata' || entry.name === '.DS_Store') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && relative(extensionRoot, path).split(sep).join('/') !== BUILD_MARKER_RELATIVE_PATH) files.push(path);
    }
  }
  await collect(extensionRoot);
  files.sort();

  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(extensionRoot, path).split(sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function writeExtensionBuildRevision(extensionDir) {
  const extensionRoot = resolve(extensionDir);
  const revision = await fingerprintExtension(extensionRoot);
  const markerPath = resolve(extensionRoot, BUILD_MARKER_RELATIVE_PATH);
  const marker = `globalThis.__flowMcpExtensionBuildRevision = ${JSON.stringify(revision)};\n`;
  let existing = '';
  try { existing = await readFile(markerPath, 'utf8'); } catch {}
  if (existing !== marker) await writeFile(markerPath, marker, 'utf8');
  return revision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const extensionDir = resolve(fileURLToPath(new URL('../dist/extension/', import.meta.url)));
  console.log(await writeExtensionBuildRevision(extensionDir));
}
