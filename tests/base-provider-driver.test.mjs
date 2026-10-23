import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// GPT-13 — Base-driver generalization (study §D.0, item (E)13).
// BaseProviderDriver gains a per-provider `requiresProject` flag (default
// true, Flow unchanged). A provider with requiresProject=false (ChatGPT) can
// invoke ops with a context carrying no projectId but a conversationId; a
// conversation change mid-context surfaces as a typed target-mismatch error.

const source = readFileSync(
  new URL('../extension/src/content/providers/base/base-provider-driver.js', import.meta.url),
  'utf8',
);

function loadBaseDriver() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.BaseProviderDriver;
}

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';

function chatgptDriver(BaseProviderDriver, context = { conversationId: 'conv-1' }) {
  const calls = [];
  const driver = new BaseProviderDriver({
    key: 'chatgpt',
    origin: CHATGPT_ORIGIN,
    requiresProject: false,
    context,
    operations: ['chatgpt.state', 'chatgpt.generation.submit'],
    operationHandler: async (operation, payload, command) => {
      calls.push({ operation, payload, command });
      return { success: true, operation };
    },
  });
  return { driver, calls };
}

function flowDriver(BaseProviderDriver, context = {}) {
  const calls = [];
  const driver = new BaseProviderDriver({
    key: 'flow',
    origin: FLOW_ORIGIN,
    context,
    operations: BaseProviderDriver.OPERATIONS,
    operationHandler: async (operation) => {
      calls.push(operation);
      return { success: true, operation };
    },
  });
  return { driver, calls };
}

// --- requiresProject=false: project-less ChatGPT contexts can invoke -------

test('chatgpt context (no projectId, conversationId present) invokes chatgpt.state', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  const result = await driver.invoke('chatgpt.state');
  assert.deepEqual(result, { success: true, operation: 'chatgpt.state' });
  assert.equal(calls.length, 1);
});

test('chatgpt context invokes non-state ops without a projectId', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  const result = await driver.invoke('chatgpt.generation.submit', { prompt: 'a cat' });
  assert.deepEqual(result, { success: true, operation: 'chatgpt.generation.submit' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.prompt, 'a cat');
});

test('requiresProject defaults to true when the flag is omitted', () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver } = flowDriver(BaseProviderDriver);
  assert.equal(driver.requiresProject, true);
});

test('requiresProject=false is recorded on the driver definition', () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver } = chatgptDriver(BaseProviderDriver);
  assert.equal(driver.requiresProject, false);
});

// --- Conversation target mismatch ------------------------------------------

test('mismatched conversationId in the target rejects with a typed mismatch error', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  await assert.rejects(
    driver.invoke('chatgpt.state', {}, { target: { conversationId: 'conv-2' } }),
    (error) => {
      assert.equal(error.code, 'FLOW_CONVERSATION_MISMATCH');
      assert.equal(error.retryable, false);
      assert.equal(error.outcome_unknown, false);
      assert.deepEqual({ ...error.details }, { expected: 'conv-2', actual: 'conv-1' });
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('matching conversationId in the target invokes normally', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  const result = await driver.invoke('chatgpt.state', {}, { target: { conversationId: 'conv-1' } });
  assert.deepEqual(result, { success: true, operation: 'chatgpt.state' });
  assert.equal(calls.length, 1);
});

test('a target without a conversationId expectation skips the conversation check', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  const result = await driver.invoke('chatgpt.state', {}, { target: { driverKey: 'chatgpt', origin: CHATGPT_ORIGIN } });
  assert.deepEqual(result, { success: true, operation: 'chatgpt.state' });
  assert.equal(calls.length, 1);
});

test('a conversation expectation against a context without one is a mismatch', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver, {});
  await assert.rejects(
    driver.invoke('chatgpt.state', {}, { target: { conversationId: 'conv-9' } }),
    (error) => {
      assert.equal(error.code, 'FLOW_CONVERSATION_MISMATCH');
      assert.deepEqual({ ...error.details }, { expected: 'conv-9', actual: null });
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('other target checks stay enforced for a requiresProject=false driver', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  await assert.rejects(
    driver.invoke('chatgpt.state', {}, { target: { driverKey: 'flow' } }),
    (error) => error.code === 'FLOW_DRIVER_MISMATCH',
  );
  await assert.rejects(
    driver.invoke('chatgpt.state', {}, { target: { origin: 'https://evil.example' } }),
    (error) => error.code === 'FLOW_ORIGIN_MISMATCH',
  );
  assert.equal(calls.length, 0);
});

test('unsupported operations still reject for a requiresProject=false driver', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = chatgptDriver(BaseProviderDriver);
  await assert.rejects(
    driver.invoke('chatgpt.unknown.op'),
    (error) => error.code === 'UNSUPPORTED_OPERATION',
  );
  assert.equal(calls.length, 0);
});

// --- Flow behavior unchanged (default flag) ---------------------------------

test('flow driver still rejects project-less contexts for project-scoped ops', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = flowDriver(BaseProviderDriver);
  await assert.rejects(
    driver.invoke('flow.media.upload'),
    (error) => {
      assert.equal(error.code, 'FLOW_PROJECT_REQUIRED');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('flow driver with a projectId invokes project-scoped ops as today', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = flowDriver(BaseProviderDriver, { projectId: PROJECT_ID });
  const result = await driver.invoke('flow.media.upload');
  assert.deepEqual(result, { success: true, operation: 'flow.media.upload' });
  assert.deepEqual(calls, ['flow.media.upload']);
});

test('flow project-exempt ops still invoke without a projectId', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver } = flowDriver(BaseProviderDriver);
  for (const operation of ['flow.state', 'flow.context', 'flow.projects.list', 'flow.project.create']) {
    const result = await driver.invoke(operation);
    assert.deepEqual(result, { success: true, operation });
  }
});

test('flow project target mismatch behaves exactly as today', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = flowDriver(BaseProviderDriver, { projectId: PROJECT_ID });
  await assert.rejects(
    driver.invoke('flow.media.upload', {}, { target: { projectId: 'other-project' } }),
    (error) => {
      assert.equal(error.code, 'FLOW_PROJECT_MISMATCH');
      assert.deepEqual({ ...error.details }, { expected: 'other-project', actual: PROJECT_ID });
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('the flag cannot be flipped per-invoke through the command', async () => {
  const BaseProviderDriver = loadBaseDriver();
  const { driver, calls } = flowDriver(BaseProviderDriver);
  await assert.rejects(
    driver.invoke('flow.media.upload', {}, { requiresProject: false }),
    (error) => error.code === 'FLOW_PROJECT_REQUIRED',
  );
  assert.equal(calls.length, 0);
});
