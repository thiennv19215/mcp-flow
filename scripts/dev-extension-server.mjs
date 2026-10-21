import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fingerprintExtension } from './extension-build-revision.mjs';

export const DEV_RELOAD_HOST = '127.0.0.1';
export const DEV_RELOAD_PATH = '/reload';
export const DEV_RELOAD_HEADER = 'x-flow-mcp-reload';

const extensionOrigin = value => typeof value === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(value);

export async function createDevExtensionServer({ extensionDir, epochFile, port = 0, onRevisionChange = () => {} }) {
  const epochPath = resolve(epochFile);
  let reloadEpoch = 0;
  try {
    const saved = Number((await readFile(epochPath, 'utf8')).trim());
    if (Number.isSafeInteger(saved) && saved >= 0) reloadEpoch = saved;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const makeBuildRevision = async () => {
    return fingerprintExtension(extensionDir);
  };
  const reloadKey = () => createHash('sha256').update(`${buildRevision}:${reloadEpoch}`).digest('hex');
  let buildRevision = await makeBuildRevision();
  let revision = reloadKey();

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const trustedOrigin = extensionOrigin(origin);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    if (trustedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (request.method === 'OPTIONS') {
      if (!trustedOrigin || request.headers['access-control-request-method'] !== 'POST' ||
          request.headers['access-control-request-headers']?.toLowerCase().split(/,\s*/).includes(DEV_RELOAD_HEADER) !== true) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': DEV_RELOAD_HEADER,
      }).end();
      return;
    }

    if (request.method === 'GET' && request.url === '/status') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ revision, buildRevision, reloadEpoch, reloadKey: revision }));
      return;
    }

    if (request.method !== 'POST' || request.url !== DEV_RELOAD_PATH) {
      response.writeHead(404).end();
      return;
    }
    if ((origin && !trustedOrigin) || request.headers[DEV_RELOAD_HEADER] !== '1') {
      response.writeHead(403).end();
      return;
    }

    const nextEpoch = reloadEpoch + 1;
    const temporaryPath = `${epochPath}.tmp`;
    try {
      await writeFile(temporaryPath, `${nextEpoch}\n`, 'utf8');
      await rename(temporaryPath, epochPath);
      reloadEpoch = nextEpoch;
      revision = reloadKey();
      onRevisionChange(revision, reloadEpoch);
      response.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ accepted: true, revision, buildRevision, reloadEpoch, reloadKey: revision }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'reload_trigger_failed' }));
    }
  });

  return {
    server,
    host: DEV_RELOAD_HOST,
    port,
    getRevision: () => revision,
    getReloadEpoch: () => reloadEpoch,
    listen: () => new Promise((resolveListen, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolveListen(server.address()); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, DEV_RELOAD_HOST);
    }),
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
    refreshFiles: async () => {
      const next = await makeBuildRevision();
      if (next === buildRevision) return false;
      buildRevision = next;
      revision = reloadKey();
      onRevisionChange(revision, reloadEpoch);
      return true;
    },
  };
}
