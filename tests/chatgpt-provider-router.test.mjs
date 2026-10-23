import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// GPT-08 — Background provider router (study §D.3.1, item (E)8).
// Operation prefix → provider descriptor (tab URL patterns, create URL,
// origin, target descriptor, metadata pin keys) in the service worker,
// generalizing the Flow-only routing. Flow resolution must stay
// byte-identical to today's behavior; unknown prefixes get the existing
// typed unsupported-operation error (FLOW_QUEUE_OPERATION_UNSUPPORTED,
// exactly as runExtensionFlowJob throws it today).

import {
  PROVIDER_DESCRIPTORS,
  providerForOperation,
  resolveProviderForOperation,
} from '../extension/src/background/provider-router.js';
import { flowHomeUrl } from '../extension/src/background/flow-locale.js';

const serviceWorkerSource = readFileSync(
  new URL('../extension/src/background/service-worker.js', import.meta.url),
  'utf8',
);

const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';

// --- ChatGPT resolution ----------------------------------------------------

test('GPT-08 router: chatgpt.generation.submit resolves to the ChatGPT descriptor', () => {
  const descriptor = resolveProviderForOperation('chatgpt.generation.submit');
  assert.equal(descriptor.key, 'chatgpt');
  assert.equal(descriptor.operationPrefix, 'chatgpt.');
  assert.equal(descriptor.origin, 'https://chatgpt.com');
  assert.deepEqual(descriptor.tabUrlPatterns, ['*://chatgpt.com/*']);
  assert.equal(descriptor.createUrl, 'https://chatgpt.com/');
  // GPT-13: ChatGPT is a no-project provider.
  assert.equal(descriptor.requiresProject, false);
  // §D.2 job metadata pins: providerTabId + conversationId.
  assert.equal(descriptor.tabIdMetadataKey, 'providerTabId');
  assert.equal(descriptor.targetMetadataKey, 'conversationId');
  assert.equal(typeof descriptor.targetDescriptor, 'function');
});

test('GPT-08 router: any chatgpt.* operation resolves by prefix', () => {
  assert.equal(resolveProviderForOperation('chatgpt.state').key, 'chatgpt');
  assert.equal(providerForOperation('chatgpt.generation.submit').key, 'chatgpt');
});

test('GPT-08 router: chatgpt target descriptor pins the conversation, never a project', () => {
  const descriptor = resolveProviderForOperation('chatgpt.generation.submit');
  const target = descriptor.targetDescriptor(
    { metadata: { providerTabId: 9, conversationId: 'conv-42' } },
    { id: 9, url: 'https://chatgpt.com/c/conv-42' },
  );
  assert.deepEqual(target, {
    tabId: 9,
    driverKey: 'chatgpt',
    origin: 'https://chatgpt.com',
    conversationId: 'conv-42',
  });
  assert.ok(!('projectId' in target), 'a no-project provider target carries no projectId');
});

test('GPT-08 router: chatgpt target descriptor without a pinned conversation carries null', () => {
  const descriptor = resolveProviderForOperation('chatgpt.generation.submit');
  const target = descriptor.targetDescriptor({ metadata: {} }, { id: 3, url: 'https://chatgpt.com/' });
  assert.deepEqual(target, {
    tabId: 3,
    driverKey: 'chatgpt',
    origin: 'https://chatgpt.com',
    conversationId: null,
  });
});

// --- Flow resolution stays byte-identical ----------------------------------

test('GPT-08 router: flow.* resolves to the Flow descriptor with today\'s exact values', () => {
  const descriptor = resolveProviderForOperation('flow.generation.submit');
  assert.equal(descriptor.key, 'flow');
  assert.equal(descriptor.operationPrefix, 'flow.');
  assert.equal(descriptor.origin, 'https://flow.google.com');
  // The exact pattern chooseTab() queries today.
  assert.deepEqual(descriptor.tabUrlPatterns, ['https://flow.google.com/*']);
  // flowHomeUrl() with no locale — the URL tabs.create uses today.
  assert.equal(descriptor.createUrl, 'https://flow.google.com/');
  assert.equal(descriptor.createUrl, flowHomeUrl());
  assert.equal(descriptor.requiresProject, true);
  // The pin keys runExtensionFlowJob reads/writes today.
  assert.equal(descriptor.tabIdMetadataKey, 'flowTabId');
  assert.equal(descriptor.targetMetadataKey, 'flowProjectId');
});

test('GPT-08 router: descriptor origins match the content provider registry', () => {
  const registrySource = readFileSync(
    new URL('../extension/src/content/providers/base/provider-registry.js', import.meta.url),
    'utf8',
  );
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(registrySource, sandbox);
  assert.equal(resolveProviderForOperation('flow.generation.submit').origin, sandbox.ProviderRegistry.ORIGINS.flow);
  assert.equal(resolveProviderForOperation('chatgpt.generation.submit').origin, sandbox.ProviderRegistry.ORIGINS.chatgpt);
});

test('GPT-08 router: flow target descriptor is byte-identical to the runner\'s _flowTarget literal', () => {
  const descriptor = resolveProviderForOperation('flow.generation.submit');
  const target = descriptor.targetDescriptor(
    { metadata: { flowTabId: 7, flowProjectId: PROJECT_ID } },
    { id: 7, url: `https://flow.google.com/project/${PROJECT_ID}` },
  );
  // Same shape AND same key order as the literal runExtensionFlowJob builds
  // today: { tabId, driverKey: "flow", origin, projectId }.
  assert.equal(
    JSON.stringify(target),
    JSON.stringify({ tabId: 7, driverKey: 'flow', origin: 'https://flow.google.com', projectId: PROJECT_ID }),
  );
});

test('GPT-08 router: flow target descriptor without a pinned project carries null', () => {
  const descriptor = resolveProviderForOperation('flow.generation.submit');
  const target = descriptor.targetDescriptor({ metadata: {} }, { id: 5, url: 'https://flow.google.com/' });
  assert.deepEqual(target, { tabId: 5, driverKey: 'flow', origin: 'https://flow.google.com', projectId: null });
});

// --- Unknown prefixes: the existing typed unsupported error -----------------

test('GPT-08 router: bogus.* gets the existing typed unsupported-operation error', () => {
  assert.throws(
    () => resolveProviderForOperation('bogus.poke'),
    error => {
      assert.equal(error.code, 'FLOW_QUEUE_OPERATION_UNSUPPORTED');
      assert.equal(error.outcome_unknown, false);
      assert.equal(error.message, 'Unsupported extension queue operation: bogus.poke');
      return true;
    },
  );
});

test('GPT-08 router: a missing operation gets the same typed error with the (missing) label', () => {
  for (const operation of [undefined, null, '']) {
    assert.throws(
      () => resolveProviderForOperation(operation),
      error => {
        assert.equal(error.code, 'FLOW_QUEUE_OPERATION_UNSUPPORTED');
        assert.equal(error.outcome_unknown, false);
        assert.equal(error.message, 'Unsupported extension queue operation: (missing)');
        return true;
      },
    );
    assert.equal(providerForOperation(operation), null);
  }
  // A truthy non-string operation follows today's message formula verbatim
  // (String(operation || "(missing)")), it is not relabeled "(missing)".
  assert.throws(
    () => resolveProviderForOperation(42),
    error => {
      assert.equal(error.code, 'FLOW_QUEUE_OPERATION_UNSUPPORTED');
      assert.equal(error.message, 'Unsupported extension queue operation: 42');
      return true;
    },
  );
  assert.equal(providerForOperation(42), null);
});

test('GPT-08 router: prefix matching is exact — lookalikes do not resolve', () => {
  for (const operation of ['flowx.generation.submit', 'chatgpt', 'flow', 'Flow.generation.submit', 'chatgptx.state']) {
    assert.equal(providerForOperation(operation), null, `${operation} must not resolve`);
    assert.throws(() => resolveProviderForOperation(operation), /Unsupported extension queue operation/);
  }
  assert.equal(providerForOperation('bogus.poke'), null);
});

// --- Table shape -------------------------------------------------------------

test('GPT-08 router: the descriptor table is frozen and keyed by prefix', () => {
  assert.ok(Object.isFrozen(PROVIDER_DESCRIPTORS));
  assert.deepEqual(PROVIDER_DESCRIPTORS.map(descriptor => descriptor.key), ['flow', 'chatgpt']);
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    assert.ok(Object.isFrozen(descriptor), `${descriptor.key} descriptor is frozen`);
    assert.ok(Object.isFrozen(descriptor.tabUrlPatterns), `${descriptor.key} tab patterns are frozen`);
  }
});

// --- Service-worker integration (source contracts) ---------------------------

test('GPT-08 wiring: service-worker.js imports the router from the sibling module', () => {
  assert.match(
    serviceWorkerSource,
    /import \{ resolveProviderForOperation \} from "\.\/provider-router\.js";/,
    'the worker imports resolveProviderForOperation from ./provider-router.js',
  );
});

test('GPT-08 wiring: the queue runner dispatches through the router before its allowlist check', () => {
  const runnerStart = serviceWorkerSource.indexOf('async function runExtensionFlowJob(');
  assert.ok(runnerStart >= 0, 'service-worker.js defines runExtensionFlowJob');
  const runner = serviceWorkerSource.slice(runnerStart, runnerStart + 1600);
  const dispatchAt = runner.indexOf('resolveProviderForOperation(operation)');
  const allowlistAt = runner.indexOf('queuedOperations.has(operation)');
  assert.ok(dispatchAt >= 0, 'the runner resolves the provider for the job operation');
  assert.ok(allowlistAt >= 0, 'the runner keeps its queued-operations allowlist check');
  assert.ok(dispatchAt < allowlistAt, 'provider dispatch precedes the allowlist check');
});

test('GPT-08 wiring: the runner\'s existing unsupported-error block is unchanged', () => {
  const runnerStart = serviceWorkerSource.indexOf('async function runExtensionFlowJob(');
  const runner = serviceWorkerSource.slice(runnerStart, runnerStart + 1600);
  assert.match(
    runner,
    /throw Object\.assign\(new Error\(`Unsupported extension queue operation: \$\{String\(operation \|\| "\(missing\)"\)\}`\), \{\s+code: "FLOW_QUEUE_OPERATION_UNSUPPORTED",\s+outcome_unknown: false,\s+\}\);/,
    'the pre-existing typed unsupported error stays verbatim for non-queued operations',
  );
});

test('GPT-08 wiring: the runner\'s Flow target literal is unchanged', () => {
  assert.match(
    serviceWorkerSource,
    /_flowTarget: \{ tabId: pinnedTabId, driverKey: "flow", origin: "https:\/\/flow\.google\.com", projectId: pinnedProjectId \}/,
    'the Flow _flowTarget literal the runner builds today is not rewritten',
  );
});
