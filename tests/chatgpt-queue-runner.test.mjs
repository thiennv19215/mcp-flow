import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GPT-10 — Queue runner integration for ChatGPT jobs (study §D.3.1, item
// (E)10). A ChatGPT job must drain end-to-end through the provider-
// dispatched runner against fake chrome.tabs + fake content responses:
// result URLs land on the job record, an outcome-unknown failure invokes
// content exactly once and is never auto-retried (duplicate-message
// safety), and ordinary retryable failures respect the retry budget the
// job itself declares — the queue's generic policy, no second budget.

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { resolveProviderForOperation } from '../extension/src/background/provider-router.js';
import { parseChatGptCapabilityRegistry } from '../extension/src/background/chatgpt-capabilities.js';
import {
  runChatGptQueueJob,
  createChatGptQueueRunner,
} from '../extension/src/background/chatgpt-queue-runner.js';

const serviceWorkerSource = readFileSync(
  new URL('../extension/src/background/service-worker.js', import.meta.url),
  'utf8',
);

const IMAGE_URLS = ['https://chatgpt.com/files/cat-a.png', 'https://chatgpt.com/files/cat-b.png'];

// --- Fakes -------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

function hostMatches(pattern, url) {
  // Only the shipped ChatGPT pattern shape "*://chatgpt.com/*" is needed.
  const host = pattern.replace(/^\*:\/\//, '').replace(/\/.*$/, '');
  try { return new URL(url).hostname === host; } catch { return false; }
}

function fakeTabs(initial = []) {
  const tabs = [...initial];
  let nextId = 100;
  const calls = { query: 0, get: 0, create: [] };
  return {
    tabs,
    calls,
    async query(patterns) {
      calls.query++;
      return tabs.filter(tab => patterns.some(pattern => hostMatches(pattern, tab.url)));
    },
    async get(id) {
      calls.get++;
      return tabs.find(tab => tab.id === id) || null;
    },
    async create(url) {
      calls.create.push(url);
      const tab = { id: nextId++, url, status: 'complete' };
      tabs.push(tab);
      return tab;
    },
  };
}

function happyContent(command) {
  if (command.name === 'chatgpt.generation.submit') {
    return { turnId: 'turn-1', conversationId: 'conv-1', baselineId: 'base-1' };
  }
  if (command.name === 'chatgpt.generation.observe') {
    return { imageUrls: [...IMAGE_URLS], altPrompt: 'a cat astronaut' };
  }
  throw new Error(`unexpected content op ${command.name}`);
}

function fakeContent(handler = happyContent) {
  const invocations = [];
  const sendCommand = async (tabId, command, _signal) => {
    invocations.push({ tabId, command });
    return handler(command, invocations.length);
  };
  return { invocations, sendCommand };
}

// Deps wired the way service-worker.js wires them in production, except
// updateMetadata goes to the real queue (late-bound) so pins land on the
// stored job record exactly as they do live.
function fakeDeps({ tabs, sendCommand }) {
  let queue = null;
  let idCounter = 0;
  const deps = {
    tabs,
    waitForTabComplete: async () => {},
    sendCommand,
    updateMetadata: (jobId, patch) => queue.updateMetadata(jobId, patch),
    randomId: () => `rid-${++idCounter}`,
  };
  return {
    deps,
    bindQueue(instance) { queue = instance; },
  };
}

// The dispatch shape service-worker.js uses: resolve the provider, run
// ChatGPT jobs through the provider runner branch, everything else
// through the Flow runner.
function dispatchRunner(deps, flowRunner) {
  return async (job, hooks) => {
    const descriptor = resolveProviderForOperation(job.operation || job.data?.operation);
    if (descriptor.key === 'chatgpt') return runChatGptQueueJob(job, hooks, deps);
    return flowRunner(job, hooks);
  };
}

function makeQueue(deps, flowRunner = async () => { throw new Error('flow runner must not run'); }, queueOptions = {}) {
  const harness = fakeDeps(deps);
  const queue = new FlowJobQueue(dispatchRunner(harness.deps, flowRunner), {
    storage: memoryStorage(),
    minDelayMs: 0,
    maxDelayMs: 0,
    ...queueOptions,
  });
  harness.bindQueue(queue);
  return queue;
}

async function runToSettled(queue, job) {
  const added = await queue.add(job);
  await queue.start();
  const { job: settled } = await queue.wait(added.id, 5_000);
  return settled;
}

function chatGptJob(overrides = {}) {
  return {
    operation: 'chatgpt.generation.submit',
    payload: { prompt: 'a cat astronaut', ratio: '1:1' },
    label: 'chatgpt cat',
    metadata: { source: 'test', provider: 'chatgpt' },
    ...overrides,
  };
}

// --- Success path --------------------------------------------------------------

test('GPT-10: a chatgpt job drains end-to-end and records { imageUrls, turnId } on the job', async () => {
  const tabs = fakeTabs();
  const content = fakeContent();
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob());

  assert.equal(job.status, 'completed');
  assert.equal(job.outcomeUnknown, false);
  // Result URLs + turn identity land on the job record (§D.2 result shape).
  assert.deepEqual(job.result.result.imageUrls, IMAGE_URLS);
  assert.equal(job.result.result.turnId, 'turn-1');
  assert.equal(job.result.result.conversationId, 'conv-1');
  assert.equal(job.result.result.conversationUrl, 'https://chatgpt.com/c/conv-1');
  assert.equal(job.result.result.altPrompt, 'a cat astronaut');
  assert.equal(job.result.completed, true);
  assert.equal(job.result.requestDispatched, true);

  // No tab existed: the runner created one at the descriptor create URL.
  assert.deepEqual(tabs.calls.create, ['https://chatgpt.com/']);
  const tabId = tabs.tabs[0].id;

  // Exactly two content invocations: submit, then observe.
  assert.equal(content.invocations.length, 2);
  const [submitCall, observeCall] = content.invocations;
  assert.equal(submitCall.tabId, tabId);
  assert.equal(submitCall.command.op, 'flowOperation');
  assert.equal(submitCall.command.name, 'chatgpt.generation.submit');
  assert.equal(submitCall.command.tabId, tabId);
  assert.equal(submitCall.command.jobId, job.id);
  assert.ok(submitCall.command.id.startsWith(`queue-${job.id}-`), 'command id follows the queue command convention');
  // The queue payload travels verbatim; GPT-02's builder normalizes it
  // content-side.
  assert.deepEqual(submitCall.command.payload, { prompt: 'a cat astronaut', ratio: '1:1' });
  // The target is the GPT-08 descriptor's: chatgpt driver, conversation
  // addressing, and never a projectId.
  assert.deepEqual(submitCall.command._flowTarget, {
    tabId, driverKey: 'chatgpt', origin: 'https://chatgpt.com', conversationId: null,
  });
  assert.equal(observeCall.command.name, 'chatgpt.generation.observe');
  assert.deepEqual(observeCall.command.payload, { turnId: 'turn-1', conversationId: 'conv-1', baselineId: 'base-1' });
  assert.deepEqual(observeCall.command._flowTarget, {
    tabId, driverKey: 'chatgpt', origin: 'https://chatgpt.com', conversationId: 'conv-1',
  });

  // Pins land on the stored job metadata under the descriptor's keys —
  // providerTabId + conversationId, never flowTabId/flowProjectId.
  assert.equal(job.metadata.providerTabId, tabId);
  assert.equal(job.metadata.conversationId, 'conv-1');
  assert.ok(!('flowProjectId' in job.metadata), 'a chatgpt job never gains a flowProjectId pin');
  assert.ok(!('flowTabId' in job.metadata), 'a chatgpt job never gains a flowTabId pin');
});

test('GPT-10: an existing chatgpt tab is reused and no tab is created', async () => {
  const existing = { id: 7, url: 'https://chatgpt.com/', status: 'complete' };
  const tabs = fakeTabs([existing]);
  const content = fakeContent();
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob());

  assert.equal(job.status, 'completed');
  assert.deepEqual(tabs.calls.create, []);
  assert.equal(content.invocations[0].tabId, 7);
  assert.equal(job.metadata.providerTabId, 7);
});

test('GPT-10: a pinned providerTabId wins, and a closed pinned tab falls back to find-or-create', async () => {
  const pinned = { id: 5, url: 'https://chatgpt.com/c/conv-9', status: 'complete' };
  const other = { id: 6, url: 'https://chatgpt.com/', status: 'complete' };
  const tabs = fakeTabs([pinned, other]);
  const content = fakeContent();
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({
    metadata: { source: 'test', provider: 'chatgpt', providerTabId: 5 },
  }));
  assert.equal(job.status, 'completed');
  assert.equal(content.invocations[0].tabId, 5, 'the pinned tab is used');
  assert.deepEqual(tabs.calls.create, []);

  // Same pin, but the tab is gone now.
  const tabs2 = fakeTabs([{ id: 6, url: 'https://chatgpt.com/', status: 'complete' }]);
  const content2 = fakeContent();
  const queue2 = makeQueue({ tabs: tabs2, sendCommand: content2.sendCommand });
  const job2 = await runToSettled(queue2, chatGptJob({
    metadata: { source: 'test', provider: 'chatgpt', providerTabId: 5 },
  }));
  assert.equal(job2.status, 'completed');
  assert.equal(content2.invocations[0].tabId, 6, 'fell back to the remaining chatgpt tab');
  assert.equal(job2.metadata.providerTabId, 6, 'the pin is repaired to the tab actually used');
});

test('GPT-10: a conversation pinned in metadata or derived from the tab URL reaches the submit target', async () => {
  // Metadata pin wins outright.
  const tabs = fakeTabs([{ id: 7, url: 'https://chatgpt.com/', status: 'complete' }]);
  const content = fakeContent();
  const hooks = { signal: new AbortController().signal, progress: async () => {} };
  const result = await runChatGptQueueJob(
    { id: 'job-meta-pin', operation: 'chatgpt.generation.submit', payload: { prompt: 'x' }, metadata: { providerTabId: 7, conversationId: 'conv-meta' } },
    hooks,
    {
      tabs,
      waitForTabComplete: async () => {},
      sendCommand: content.sendCommand,
      updateMetadata: async () => {},
      randomId: () => 'rid-y',
    },
  );
  assert.equal(result.completed, true);
  assert.equal(content.invocations[0].command._flowTarget.conversationId, 'conv-meta');

  // No metadata pin: the conversation is derived from the tab URL, the
  // same URL-fallback the Flow runner applies to project ids.
  const tabs2 = fakeTabs([{ id: 8, url: 'https://chatgpt.com/c/conv-from-url', status: 'complete' }]);
  const content2 = fakeContent();
  const patches = [];
  const result2 = await runChatGptQueueJob(
    { id: 'job-url-pin', operation: 'chatgpt.generation.submit', payload: { prompt: 'x' }, metadata: {} },
    hooks,
    {
      tabs: tabs2,
      waitForTabComplete: async () => {},
      sendCommand: content2.sendCommand,
      updateMetadata: async (jobId, patch) => { patches.push({ jobId, patch }); },
      randomId: () => 'rid-x',
    },
  );
  assert.equal(result2.completed, true);
  assert.equal(content2.invocations[0].command._flowTarget.conversationId, 'conv-from-url');
  assert.ok(
    patches.some(entry => entry.patch.conversationId === 'conv-from-url'),
    'the derived conversation is persisted as the job pin',
  );
});

// --- Outcome-unknown: exactly one invocation, never auto-retried --------------

test('GPT-10: an outcome-unknown submit failure invokes content exactly once and is never retried', async () => {
  const tabs = fakeTabs();
  const content = fakeContent(command => {
    if (command.name === 'chatgpt.generation.submit') {
      throw Object.assign(new Error('ChatGPT did not confirm the message was sent.'), {
        code: 'CHATGPT_SUBMIT_UNCONFIRMED', outcome_unknown: true,
      });
    }
    throw new Error('observe must not run after an unconfirmed submit');
  });
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({
    payload: { prompt: 'a cat astronaut', ratio: '1:1', retries: 2 },
  }));

  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, true);
  assert.equal(job.retrySafe, false);
  assert.equal(job.attempts, 1, 'an outcome-unknown job is attempted exactly once');
  assert.equal(content.invocations.length, 1, 'content was invoked exactly once for the job');
  assert.equal(content.invocations[0].command.name, 'chatgpt.generation.submit');
});

test('GPT-10: an unclassified observe failure is stamped outcome-unknown and not retried', async () => {
  const tabs = fakeTabs();
  const content = fakeContent(command => {
    if (command.name === 'chatgpt.generation.submit') {
      return { turnId: 'turn-1', conversationId: 'conv-1', baselineId: 'base-1' };
    }
    throw new Error('the content bridge dropped mid-observe');
  });
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({
    payload: { prompt: 'a cat astronaut', ratio: '1:1', retries: 2 },
  }));

  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, true, 'a dispatched submit with an unreadable render is outcome-unknown');
  assert.equal(job.retrySafe, false);
  assert.equal(job.attempts, 1);
  assert.equal(content.invocations.length, 2, 'submit + a single observe, no replay');
});

test('GPT-10: a typed provider outcome (CHATGPT_TEXT_ONLY) keeps its own outcome semantics', async () => {
  const tabs = fakeTabs();
  const content = fakeContent(command => {
    if (command.name === 'chatgpt.generation.submit') {
      return { turnId: 'turn-1', conversationId: 'conv-1', baselineId: 'base-1' };
    }
    throw Object.assign(new Error('ChatGPT answered with text only.'), {
      code: 'CHATGPT_TEXT_ONLY', outcome_unknown: false, retryable: false, noRetry: true,
    });
  });
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob());

  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'CHATGPT_TEXT_ONLY');
  assert.equal(job.outcomeUnknown, false, 'a typed terminal outcome is known, not unknown');
  assert.equal(job.attempts, 1);
  assert.equal(content.invocations.length, 2);
});

test('GPT-10: a submit receipt without a turn id is outcome-unknown, never observed or retried', async () => {
  const tabs = fakeTabs();
  const content = fakeContent(command => {
    if (command.name === 'chatgpt.generation.submit') return { conversationId: 'conv-1' };
    throw new Error('observe must not run without a turn id');
  });
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({
    payload: { prompt: 'a cat astronaut', ratio: '1:1', retries: 2 },
  }));

  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'CHATGPT_SUBMIT_RECEIPT_INCOMPLETE');
  assert.equal(job.outcomeUnknown, true);
  assert.equal(content.invocations.length, 1);
});

// --- Retry budget ---------------------------------------------------------------

test('GPT-10: a retryable failure respects the retry budget the job declares', async () => {
  const tabs = fakeTabs();
  const content = fakeContent(() => {
    throw Object.assign(new Error('The ChatGPT composer is not ready yet.'), {
      code: 'CHATGPT_COMPOSER_UNAVAILABLE', retryable: true, outcome_unknown: false,
    });
  });
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({
    payload: { prompt: 'a cat astronaut', ratio: '1:1', retries: 1 },
  }));

  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'CHATGPT_COMPOSER_UNAVAILABLE');
  assert.equal(job.outcomeUnknown, false);
  assert.equal(job.attempts, 2, 'retries: 1 means the initial attempt plus one retry');
  assert.equal(content.invocations.length, 2, 'each attempt invokes submit once');
  assert.ok(content.invocations.every(entry => entry.command.name === 'chatgpt.generation.submit'));
});

test('GPT-10: retries: 0 disables auto-retry for chatgpt jobs too', async () => {
  const tabs = fakeTabs();
  const content = fakeContent(() => {
    throw Object.assign(new Error('The ChatGPT composer is not ready yet.'), {
      code: 'CHATGPT_COMPOSER_UNAVAILABLE', retryable: true, outcome_unknown: false,
    });
  });
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({
    payload: { prompt: 'a cat astronaut', ratio: '1:1', retries: 0 },
  }));

  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 1);
  assert.equal(content.invocations.length, 1);
});

// --- Admission + dispatch edges ---------------------------------------------------

test('GPT-10: a non-queued chatgpt operation is rejected with the existing unsupported error', async () => {
  const tabs = fakeTabs();
  const content = fakeContent();
  const queue = makeQueue({ tabs, sendCommand: content.sendCommand });

  const job = await runToSettled(queue, chatGptJob({ operation: 'chatgpt.state' }));

  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'FLOW_QUEUE_OPERATION_UNSUPPORTED');
  assert.equal(content.invocations.length, 0, 'no content invocation for a non-queued operation');
  assert.equal(tabs.calls.query, 0, 'no tab work for a non-queued operation');
});

test('GPT-10: the queue GPT-09 preflight runs for chatgpt jobs once its registry loader is wired', async () => {
  const registry = parseChatGptCapabilityRegistry(
    JSON.parse(readFileSync(new URL('../chatgpt-model-capabilities.json', import.meta.url), 'utf8')),
  );
  const tabs = fakeTabs();
  const content = fakeContent();
  const queue = makeQueue(
    { tabs, sendCommand: content.sendCommand },
    async () => { throw new Error('flow runner must not run'); },
    { loadChatGptCapabilityRegistry: async () => registry },
  );

  await assert.rejects(
    queue.add(chatGptJob({ payload: { ratio: '1:1' } })),
    error => {
      const codes = [error.code, ...(error.problems || []).map(problem => problem.code)];
      assert.ok(codes.includes('CHATGPT_QUEUE_PREFLIGHT_PROMPT'), `missing prompt is rejected at admission, got ${codes}`);
      return true;
    },
  );
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 0, 'a rejected job queues nothing');

  const added = await queue.add(chatGptJob());
  assert.equal(added.status, 'pending', 'a valid chatgpt job is admitted');
});

test('GPT-10: flow jobs still reach the flow runner untouched by the chatgpt branch', async () => {
  const tabs = fakeTabs();
  const content = fakeContent();
  const flowRuns = [];
  const queue = makeQueue(
    { tabs, sendCommand: content.sendCommand },
    async job => { flowRuns.push(job); return { completed: true, result: { media: [] } }; },
  );

  const job = await runToSettled(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'a flow scene' },
    label: 'flow scene',
    metadata: { source: 'test' },
  });

  assert.equal(job.status, 'completed');
  assert.equal(flowRuns.length, 1);
  assert.equal(content.invocations.length, 0, 'the chatgpt branch never invokes content for a flow job');
  assert.equal(tabs.calls.query, 0, 'the chatgpt branch never touches tabs for a flow job');
});

test('GPT-10: createChatGptQueueRunner binds deps into a queue-ready runner', async () => {
  const tabs = fakeTabs();
  const content = fakeContent();
  const harness = fakeDeps({ tabs, sendCommand: content.sendCommand });
  const queue = new FlowJobQueue(createChatGptQueueRunner(harness.deps), {
    storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0,
  });
  harness.bindQueue(queue);

  const job = await runToSettled(queue, chatGptJob());
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result.result.imageUrls, IMAGE_URLS);
});

// --- Service-worker wiring (source contracts) --------------------------------------

test('GPT-10 wiring: service-worker.js imports the chatgpt runner and the registry loader', () => {
  assert.match(
    serviceWorkerSource,
    /import \{ runChatGptQueueJob \} from "\.\/chatgpt-queue-runner\.js";/,
    'the worker imports runChatGptQueueJob from ./chatgpt-queue-runner.js',
  );
  assert.match(
    serviceWorkerSource,
    /import \{ loadChatGptCapabilityRegistry \} from "\.\/chatgpt-capabilities\.js";/,
    'the worker imports loadChatGptCapabilityRegistry from ./chatgpt-capabilities.js',
  );
});

test('GPT-10 wiring: the runner branches chatgpt jobs before the Flow allowlist', () => {
  const runnerStart = serviceWorkerSource.indexOf('async function runExtensionFlowJob(');
  assert.ok(runnerStart >= 0, 'service-worker.js defines runExtensionFlowJob');
  const runner = serviceWorkerSource.slice(runnerStart, runnerStart + 1600);
  const dispatchAt = runner.indexOf('resolveProviderForOperation(operation)');
  const branchAt = runner.indexOf('descriptor.key === "chatgpt"');
  const branchCallAt = runner.indexOf('runChatGptQueueJob(job, hooks');
  const allowlistAt = runner.indexOf('queuedOperations.has(operation)');
  assert.ok(dispatchAt >= 0, 'the runner resolves the provider descriptor');
  assert.ok(branchAt > dispatchAt, 'the chatgpt branch hangs off the resolved descriptor');
  assert.ok(branchCallAt > branchAt, 'the branch calls the chatgpt runner');
  assert.ok(allowlistAt > branchCallAt, 'the branch precedes the Flow allowlist check');
});

test('GPT-10 wiring: the production queue construction wires the chatgpt registry loader', () => {
  const constructionStart = serviceWorkerSource.indexOf('new FlowJobQueue(runExtensionFlowJob, {');
  assert.ok(constructionStart >= 0, 'the worker constructs the production queue');
  const construction = serviceWorkerSource.slice(constructionStart, serviceWorkerSource.indexOf('});', constructionStart));
  assert.match(
    construction,
    /loadChatGptCapabilityRegistry: \(\) => loadChatGptCapabilityRegistry\(\)/,
    'the queue receives the GPT-09 registry loader (GPT-09 preflight becomes live)',
  );
  assert.match(construction, /loadCapabilityRegistry:/, 'the Flow registry loader stays wired');
});

test('GPT-10 wiring: the worker provides the provider command transport + runner deps', () => {
  assert.match(
    serviceWorkerSource,
    /async function sendProviderCommand\(tabId, command, signal\)/,
    'the worker defines the provider content-command transport',
  );
  assert.match(
    serviceWorkerSource,
    /function chatGptQueueRunnerDeps\(\)/,
    'the worker defines the chatgpt runner dependency factory',
  );
  assert.match(
    serviceWorkerSource,
    /type: "flow-mcp:execute"/,
    'provider commands ride the existing flow-mcp:execute envelope',
  );
});
