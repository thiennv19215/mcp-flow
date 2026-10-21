// Local Flow audit. The default mode only reads the current session and libraries.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditLatestJob, auditRequestDiagnostics } from './audit-native-report.mjs';
import { assertVerifiedQuoteWithinCap, parseAuditOptions } from './audit-native-options.mjs';
import { buildCharacterSnapshot, runCharacterCreateAudit } from './audit-native-character.mjs';

const configuredBase = process.env.FLOW_LOCAL_API_BASE || 'http://127.0.0.1:18899';
const baseUrl = new URL(configuredBase);
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (baseUrl.protocol !== 'http:' || !loopbackHosts.has(baseUrl.hostname) || baseUrl.username || baseUrl.password ||
    (baseUrl.pathname !== '/' && baseUrl.pathname !== '') || baseUrl.search || baseUrl.hash) {
  throw new Error('FLOW_LOCAL_API_BASE must be a plain http://127.0.0.1, http://localhost, or http://[::1] URL with an optional port; remote hosts are refused.');
}
const base = baseUrl.origin;
const tokenPath = join(homedir(), '.flow-mcp', 'token');
const token = readFileSync(tokenPath, 'utf8').trim();
if (!token) throw new Error(`The local Flow API token is empty: ${tokenPath}`);

const { mode, assetNames, filePath, characterName, characterNameProvided, renameCharacter, voice, timeoutSeconds, forceContinue } =
  parseAuditOptions(process.argv.slice(2));

const directory = new URL('../diagnostics/', import.meta.url);
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const output = new URL(`native-${mode}-${stamp}.json`, directory);
const report = { started: new Date().toISOString(), mode, api: base, probes: [] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));

async function api(method, body = {}, timeout = 130000) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'x-flow-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function probe(name, action) {
  const start = Date.now();
  try {
    const result = await action();
    report.probes.push({ name, status: 'passed', seconds: (Date.now() - start) / 1000, result });
    console.log(JSON.stringify({ name, status: 'passed', result }));
    save();
    return result;
  } catch (error) {
    report.probes.push({ name, status: 'failed', seconds: (Date.now() - start) / 1000, error: error.message });
    console.log(JSON.stringify({ name, status: 'failed', error: error.message }));
    save();
    throw error;
  }
}

async function requireAsset(name, kind) {
  const assets = await api('assets');
  const matches = assets.filter(item => item.name === name && item.kind === kind);
  if (matches.length !== 1) throw new Error(`Expected exactly one Flow ${kind} titled "${name}"; found ${matches.length}. No operation was started.`);
  return matches[0];
}

async function requireCharacter(name) {
  const characters = await api('characters');
  if (!characters.some(item => item.name === name)) throw new Error(`Flow character "${name}" was not found. No operation was started.`);
}

async function pollSubmittedJob(queued, label, maxCredits) {
  const jobs = queued?.jobs || [];
  if (jobs.length !== 1 || !jobs[0]?.id) throw new Error(`Flow API did not return exactly one job id. Inspect response before retrying: ${JSON.stringify(queued)}`);
  const jobId = jobs[0].id;
  report.job_id = jobId;
  report.probes.push({ name: label, status: 'queued', job_id: jobId });
  save();
  console.log(JSON.stringify({ name: label, status: 'queued', job_id: jobId }));

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await api('wait', { job_ids: [jobId], timeout_seconds: 5 }, 15000);
    const job = state?.jobs?.find(item => item.id === jobId);
    if (!job) throw new Error(`Job ${jobId} disappeared from the local queue. Its outcome may be unknown; inspect Flow before any retry.`);
    report.latest_job = auditLatestJob(job);
    save();
    if (job.request_dispatched === true || job.status === 'submitted') {
      try {
        assertVerifiedQuoteWithinCap(job, maxCredits);
      } catch (error) {
        const message = `${error.message} The request may already have reached Flow; do not replay it.`;
        report.probes.push({ name: label, status: 'dispatch_without_verified_in-cap_quote', evidence: report.latest_job, error: message });
        report.finished = new Date().toISOString();
        save();
        throw Object.assign(new Error(message), { outcome_unknown: true });
      }
      const evidence = { job_id: job.id, status: job.status, request_dispatched: job.request_dispatched === true,
        server_acceptance_observed: job.server_acceptance_observed === true, credits: job.credits ?? null,
        credit_quote_verified: job.credit_quote_verified ?? null, note: job.note,
        request_diagnostics: auditRequestDiagnostics(job) };
      report.probes.push({ name: label, status: 'submitted', evidence });
      report.finished = new Date().toISOString();
      save();
      console.log(JSON.stringify({ name: label, status: 'submitted', evidence }));
      return evidence;
    }
    if (job.status === 'failed' || job.status === 'cancelled' || state.finished) {
      const unknown = job.outcome_unknown === true;
      const request_diagnostics = unknown ? auditRequestDiagnostics(job) : null;
      const error = `Job ${job.id} ended as ${job.status} before confirmed dispatch (outcome_unknown=${unknown}): ${job.error || job.note || 'no error detail'}. Do not replay this job.`;
      report.probes.push({ name: label, status: unknown ? 'outcome_unknown' : 'failed_before_dispatch', error, request_diagnostics });
      report.finished = new Date().toISOString();
      save();
      throw new Error(error);
    }
  }
  const error = `Stopped polling job ${jobId} after ${timeoutSeconds}s without dispatch evidence. The job may still be active; inspect its existing id and do not replay.`;
  report.probes.push({ name: label, status: 'still_running', error });
  report.finished = new Date().toISOString();
  save();
  throw Object.assign(new Error(error), { name: 'TimeoutError' });
}

async function submitOperation(method, payload, label, maxCredits) {
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    throw new Error(`E2E ${method} has no configured, verifiable credit cap; nothing was submitted.`);
  }
  let queued;
  try {
    queued = await api(method, payload);
  } catch (error) {
    const message = `The ${method} API call did not return a job id (${error.message}). Its outcome may be unknown; inspect Flow and the local queue before any retry.`;
    report.probes.push({ name: label, status: 'submission_outcome_unknown', error: message });
    report.finished = new Date().toISOString();
    save();
    throw new Error(message);
  }
  return pollSubmittedJob(queued, label, maxCredits);
}

async function submitGeneration(scene, label) {
  if (!Number.isFinite(scene.max_credits) || scene.max_credits < 0) {
    throw new Error('E2E generation requires an explicit non-negative max_credits cap; nothing was submitted.');
  }
  return submitOperation('generate', {
    project: `NativeE2E-${mode}-${stamp}`,
    scenes: [{ ...scene, submit_only: true, retries: 0, variants: 1 }],
  }, label, scene.max_credits);
}

try {
  if (mode === 'readonly') {
    const status = await probe('status', () => api('status', { detailed: false }));
    const projects = await probe('projects', () => api('projects'));
    const assets = await probe('assets', () => api('assets'));
    const characters = await probe('characters.list', () => api('characters'));
    report.flow = status.flow;
    report.counts = { projects: projects.length, assets: assets.length, characters: characters.length };
  } else if (mode === 'voice-options') {
    report.voice_options = await probe('voice_options.read_only_picker_inspection', () => api('voice_options'));
  } else if (mode === 'create-project') {
    const created = await probe('project.create', () => api('create_project', {}, 45_000));
    const project = created?.project;
    if (!project?.id) throw new Error('Create-project API returned no confirmed project ID.');
    const projects = await probe('projects.confirm_created', () => api('projects', {}, 90_000));
    if (!Array.isArray(projects) || !projects.some(item => item.id === project.id)) {
      throw new Error(`Project ID ${project.id} was returned but was not found in the project list.`);
    }
    report.project = project;
    report.project_list_confirmed = true;
  } else if (mode === 'upload') {
    report.upload = await probe('upload_media', () => api('upload_media', { path: filePath }, 210000));
  } else if (mode === 'image') {
    await submitGeneration({ type: 'image', prompt: 'A single red ceramic mug on a plain white background, studio product photo, no text.', model: 'latest', aspect_ratio: '1:1', max_credits: 0 }, 'image.submit_only');
  } else if (mode === 'video') {
    await submitGeneration({ type: 'video', prompt: 'A red ceramic mug on a wooden table. Slow gentle camera push in, natural daylight. No text.', ...(voice ? { voice } : {}), max_credits: 15 }, 'video.submit_only');
  } else if (mode === 'frame') {
    await requireAsset(assetNames[0], 'image');
    await submitGeneration({ type: 'video', prompt: 'A gentle slow camera push in from the supplied first frame.', first_frame: `asset:${assetNames[0]}`, max_credits: 15 }, 'video.first_frame.submit_only');
  } else if (mode === 'last-frame') {
    await requireAsset(assetNames[0], 'image');
    await submitGeneration({ type: 'video', prompt: 'Continue into a gentle slow camera push ending on the supplied last frame.', last_frame: `asset:${assetNames[0]}`, max_credits: 15 }, 'video.last_frame.submit_only');
  } else if (mode === 'reference') {
    for (const name of assetNames) await requireAsset(name, 'image');
    if (characterNameProvided) await requireCharacter(characterName);
    const references = assetNames.length ? assetNames.map(name => `asset:${name}`) : [`character:${characterName}`];
    await submitGeneration({ type: 'image', prompt: 'Show the same subject on a plain white background, no text.', model: 'latest', reference_images: references, max_credits: 0 }, 'image.reference.submit_only');
  } else if (mode === 'frame-pair') {
    for (const name of assetNames) await requireAsset(name, 'image');
    await submitGeneration({ type: 'video', prompt: 'Make a smooth, continuous transition from the supplied first image to the supplied last image.', first_frame: `asset:${assetNames[0]}`, last_frame: `asset:${assetNames[1]}`, max_credits: 15 }, 'video.first_and_last_frame.submit_only');
  } else if (mode === 'video-reference') {
    for (const name of assetNames) await requireAsset(name, 'image');
    if (characterNameProvided) await requireCharacter(characterName);
    const references = assetNames.length ? assetNames.map(name => `asset:${name}`) : [`character:${characterName}`];
    await submitGeneration({ type: 'video', prompt: 'Create a slow camera push-in showing the subject from the supplied reference image.', reference_images: references, ...(voice ? { voice } : {}), max_credits: 15 }, 'video.image_references.submit_only');
  } else if (mode === 'edit') {
    await requireAsset(assetNames[0], 'video');
    await submitOperation('edit', { project: `NativeE2E-${mode}-${stamp}`, asset: assetNames[0], prompt: 'Change the scene lighting to soft natural daylight while preserving the subject and composition.', acknowledge_cost: true, submit_only: true }, 'video.edit.submit_only');
  } else if (mode === 'continue-exact' || mode === 'continue-likeness') {
    await requireAsset(assetNames[0], 'video');
    const attach = mode === 'continue-likeness' ? [characterName] : [];
    if (attach.length) await requireCharacter(characterName);
    await submitOperation('continue_shot', {
      project: `NativeE2E-${mode}-${stamp}`, from_asset: assetNames[0],
      prompt: 'Continue with a slow, steady camera push-in and subtle natural movement.', attach,
      aspect_ratio: '16:9', mode: mode === 'continue-likeness' ? 'likeness' : 'exact',
      acknowledge_cost: true, submit_only: true, force: forceContinue,
    }, `video.continue_${mode === 'continue-likeness' ? 'likeness' : 'exact'}.submit_only`);
  } else if (mode === 'agent') {
    await submitOperation('agent', {
      project: `NativeE2E-${mode}-${stamp}`,
      scenes: ['A single red ceramic mug on a plain white background, studio product photo, no text.'],
      aspect_ratio: '1:1', submit_only: true,
    }, 'image.agent_batch.submit_only');

  } else if (mode === 'character') {
    await requireAsset(assetNames[0], 'image');
    const audit = await runCharacterCreateAudit({
      requestedName: characterName,
      readSnapshot: expectedProjectId => probe(expectedProjectId ? 'characters.snapshot.after_create' : 'characters.snapshot.before_create', async () => {
        const characters = await api('characters');
        const status = await api('status', { detailed: true });
        return buildCharacterSnapshot(characters, status, expectedProjectId);
      }),
      create: () => probe('character.create.from_asset', () => api('character', { name: characterName, image: `asset:${assetNames[0]}` }, 210000)),
    });
    report.character = audit.created;
    report.character_id = audit.delta.new_character_id;
    report.character_create_delta = audit.delta;
    report.character_list_confirmed = true;
  } else if (mode === 'character-edit') {
    const charactersBefore = await probe('characters.list.before_rename', () => api('characters'));
    const originalMatches = charactersBefore.filter(item => item.name === characterName);
    if (originalMatches.length !== 1) throw new Error(`Expected exactly one Flow character named "${characterName}"; found ${originalMatches.length}. No rename was started.`);
    if (charactersBefore.some(item => item.name === renameCharacter)) throw new Error(`A Flow character named "${renameCharacter}" already exists. No rename was started.`);
    const renamed = await probe('character.rename', () => api('character_edit', { name: characterName, rename: renameCharacter }, 330000));
    const charactersAfter = await probe('characters.list.after_rename', () => api('characters'));
    const renamedMatches = charactersAfter.filter(item => item.name === renameCharacter);
    const originalRemaining = charactersAfter.filter(item => item.name === characterName);
    if (renamedMatches.length !== 1 || originalRemaining.length !== 0) {
      throw new Error(`Character edit returned, but Flow's library did not confirm a unique rename from "${characterName}" to "${renameCharacter}".`);
    }
    report.character_edit = { ...renamed, renamed_from: characterName, renamed_to: renameCharacter };
    report.character_listed_after_rename = true;
  }
  report.finished = new Date().toISOString();
  save();
  console.log(`Report: ${output.pathname}`);
} catch (error) {
  report.finished ||= new Date().toISOString();
  report.fatal_error = error.message;
  if (error.diagnostics) report.fatal_diagnostics = error.diagnostics;
  save();
  process.exitCode = 1;
}
