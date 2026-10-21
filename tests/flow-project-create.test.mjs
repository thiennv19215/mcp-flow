import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/content/providers/flow/FlowLibraryOperations.js', import.meta.url), 'utf8');
const projectId = '01234567-89ab-4cde-8f01-23456789abcd';

function harness({ controls = ['New project'], createRoute = true } = {}) {
  const home = 'https://flow.google.com/?hl=en';
  const editor = `https://flow.google.com/project/${projectId}?hl=en`;
  const location = { href: home, get pathname() { return new URL(this.href).pathname; } };
  const buttons = controls.map(label => ({
    innerText: label,
    textContent: label,
    querySelectorAll: () => [],
    click() { if (createRoute) location.href = editor; },
  }));
  const document = { querySelectorAll: selector => selector === 'button' ? buttons : [] };
  const context = vm.createContext({
    Date, Promise, Set, Object, String, Number, Array, Error, URL,
    location,
    document,
    FlowSelectors: { navigation: { newProjectButton: { selectors: ['button'], textRegex: /new project|tạo dự án|dự án mới|create project/i } } },
    visible: () => true,
    accessibleName: el => el.innerText,
    matchesFlowUiRegex: (value, regex) => regex.test(value),
    wait: async () => {},
    ProviderRegistry: {
      describeUrl: url => {
        const match = new URL(url).pathname.match(/\/project\/([0-9a-f-]{36})(?:\/|$)/i);
        return match ? { projectId: match[1], isProjectEditor: true } : { projectId: null, isProjectEditor: false };
      },
    },
  });
  vm.runInContext(source, context);
  const errors = [];
  const ops = new context.FlowLibraryOperations({ error: (code, message, retryable, outcome_unknown) => {
    const error = Object.assign(new Error(message), { code, retryable, outcome_unknown });
    errors.push(error);
    return error;
  } });
  return { ops, location, errors };
}

test('creates a project only after the New project control yields a confirmed project ID', async () => {
  const { ops } = harness();
  const result = await ops.execute('flow.project.create');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    project: { id: projectId, url: `https://flow.google.com/project/${projectId}?hl=en`, name: 'Untitled project' },
    created: true,
  });
});

test('refuses ambiguous create controls before clicking', async () => {
  const { ops, errors } = harness({ controls: ['New project', 'Create project'] });
  await assert.rejects(ops.execute('flow.project.create'), error => error.code === 'FLOW_CREATE_PROJECT_AMBIGUOUS' && !error.outcome_unknown);
  assert.equal(errors.length, 1);
});

test('reports an unknown outcome when Flow does not expose the new project ID after the click', async () => {
  const { ops } = harness({ createRoute: false });
  await assert.rejects(ops.execute('flow.project.create', {}, { timeoutMs: 1 }), error => error.code === 'FLOW_CREATE_PROJECT_RESULT_UNKNOWN' && error.outcome_unknown === true);
});
