// Sequential live audit. Generation probes accept only a zero-credit quote.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = 'http://127.0.0.1:18899';
const token = readFileSync(join(homedir(), '.flow-mcp', 'token'), 'utf8').trim();
const directory = new URL('../diagnostics/', import.meta.url);
mkdirSync(directory, { recursive: true });
const report = { started: new Date().toISOString(), probes: [] };
const paidVideo = process.argv.includes('--paid-video');
const supplemental = process.argv.includes('--supplemental');
const runtimeRetest = process.argv.includes('--runtime-retest');
const output = new URL(runtimeRetest ? 'native-runtime-retest.json' : paidVideo ? 'native-video-audit.json' : supplemental ? 'native-supplemental-audit.json' : 'native-audit.json', directory);
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
async function api(method, body = {}, timeout = 130000) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'x-flow-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function probe(name, action) {
  const start = Date.now();
  try {
    const result = await action();
    report.probes.push({ name, status: 'passed', seconds: (Date.now() - start) / 1000, result });
    console.log(JSON.stringify({ name, status: 'passed', result }));
    save(); return result;
  } catch (error) {
    const status = /above max_credits=0/.test(error.message) ? 'guarded' : 'failed';
    report.probes.push({ name, status, seconds: (Date.now() - start) / 1000, error: error.message });
    console.log(JSON.stringify({ name, status, error: error.message }));
    save();
    // A client timeout does not cancel the operation in Flow. Stop instead of overlapping it.
    if (error.name === 'TimeoutError') throw error;
  }
}
async function generation(scene) {
  const queued = await api('generate', { project: 'NativeDiagnostic1019', scenes: [{ ...scene, max_credits: scene.max_credits ?? 0, retries: 0, variants: 1 }] });
  const ids = queued.jobs.map(job => job.id);
  for (let attempt = 0; attempt < 65; attempt++) {
    const state = await api('wait', { job_ids: ids, timeout_seconds: 5 }, 15000);
    if (state.finished) {
      const job = state.jobs[0];
      if (job.status !== 'done') throw new Error(`${job.error || job.status} (job ${job.id}; outcome_unknown=${job.outcome_unknown})`);
      return job;
    }
  }
  throw Object.assign(new Error('Job still running; audit stopped without replay.'), { name: 'TimeoutError' });
}
const initial = await probe('status', async () => (await api('status', { detailed: true })).flow);
const projectId = initial?.url?.match(/\/project\/([0-9a-f-]{36})/i)?.[1];
if (!projectId) throw new Error('No selected Flow project.');
async function mainProject() {
  const state = (await api('status', { detailed: false })).flow;
  if (/\/character(?:\/|$)|\/edit(?:\/|$)/.test(new URL(state.url).pathname)) {
    await api('open_project', { project_id: projectId }, 65000);
  }
}
const ready = await probe('project.ready', async () => { await mainProject(); return true; });
if (!ready) {
  report.finished = new Date().toISOString();
  save();
  process.exit(1);
}
if (runtimeRetest) {
  const uploaded = await probe('upload.local-image.current-runtime', () => api('upload_media', { path: join(homedir(), 'flow-mcp-out', 'NativeDiagnostic1019', 'audit-upload.png') }, 210000));
  await probe('characters.list.current-runtime', () => api('characters'));
  // A failed content-script response may precede completion of its navigation.
  await api('open_project', { project_id: projectId }, 65000);
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = (await api('status', { detailed: false })).flow;
    if (state.composer && !/\/character(?:\/|$)|\/edit(?:\/|$)/.test(new URL(state.url).pathname)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (uploaded) await probe('character.create.current-runtime', () => api('character', { name: 'MCP Diagnostic Mug 1019', image: `asset:${uploaded.name}` }));
  report.finished = new Date().toISOString();
  save();
  console.log(`Report: ${output.pathname}`);
  process.exit(0);
}
if (supplemental) {
  await probe('download.original.fresh-project', () => api('download', { project: 'NativeDiagnostic1019', assets: ['image.png'], quality: 'original' }, 210000));
  await probe('upload.local-image', () => api('upload_media', { path: join(homedir(), 'flow-mcp-out', 'NativeDiagnostic1019', 'audit-upload.png') }, 210000));
  await probe('image.text.fresh-project', () => generation({ type: 'image', prompt: 'A single red ceramic mug on a plain white background, studio product photo, no text.', model: 'latest', aspect_ratio: '1:1' }));
  report.finished = new Date().toISOString();
  report.credits_after = (await api('status', { detailed: true })).flow.credits_remaining;
  save();
  console.log(`Report: ${output.pathname}`);
  process.exit(0);
}
if (paidVideo) {
  // Explicit opt-in only: one requested clip, at most 15 quoted credits, no retries.
  await probe('video.text.render-and-download', () => generation({
    type: 'video', prompt: 'A red ceramic mug on a wooden table. Slow gentle camera push in, natural daylight. No text.',
    aspect_ratio: '16:9', max_credits: 15,
  }));
  report.finished = new Date().toISOString();
  report.credits_after = (await api('status', { detailed: true })).flow.credits_remaining;
  save();
  console.log(`Report: ${output.pathname}`);
  process.exit(0);
}
const assets = await probe('assets', () => api('assets'));
const characters = await probe('characters.list', () => api('characters'));
await mainProject();
const image = assets?.find(item => item.name === 'image.png') || assets?.find(item => item.kind === 'image');
if (image) await probe('download.original', () => api('download', { project: 'NativeDiagnostic1019', assets: [image.name], quality: 'original' }));
await probe('image.text', () => generation({ type: 'image', prompt: 'A single red ceramic mug on a plain white background, studio product photo, no text.', model: 'latest', aspect_ratio: '1:1' }));
await probe('video.text.zero-credit-guard', () => generation({ type: 'video', prompt: 'A red ceramic mug on a table. Slow camera push in.', aspect_ratio: '16:9' }));
if (image) {
  await probe('video.first-frame.zero-credit-guard', () => generation({ type: 'video', prompt: 'A gentle slow camera push in.', first_frame: `asset:${image.name}`, aspect_ratio: '16:9' }));
  await probe('image.reference', () => generation({ type: 'image', prompt: 'Show the same subject on a plain white background, no text.', reference_images: [`asset:${image.name}`], model: 'latest', aspect_ratio: '1:1' }));
  await probe('character.create.project-image', () => api('character', { name: 'MCP Diagnostic 1019', image: `asset:${image.name}` }));
  await mainProject();
}
if (characters?.length) {
  await probe('character.portrait-download', () => api('character_edit', { name: characters[0].name }));
  await mainProject();
} else report.probes.push({ name: 'character.edit', status: 'blocked', reason: 'Character listing/creation did not succeed; no verified character available to edit.' });
const videos = assets?.filter(item => item.kind === 'video') || [];
report.probes.push({ name: 'video.edit', status: 'blocked', reason: videos.length ? 'Unquoted paid operation; requires an explicit diagnostic credit budget.' : 'No video in the selected project. Video generation must work first.' });
report.finished = new Date().toISOString();
report.credits_after = (await api('status', { detailed: true })).flow.credits_remaining;
save();
console.log(`Report: ${output.pathname}`);
