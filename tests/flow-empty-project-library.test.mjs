import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');

function createScanner({ emptyText = '', projectEditor = true, overlay = false } = {}) {
  const projectId = '1e9bc504-1f03-47a5-9caa-a17428ed7752';
  const main = {
    innerText: emptyText,
    textContent: emptyText,
    querySelectorAll: () => [],
  };
  const dialog = { isVisible: true };
  const document = {
    querySelector(selector) {
      if (selector === '#main-content' || selector === "main,[role='main']") return main;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"],[role="listbox"],mat-dialog-container,flow-dialog') return overlay ? [dialog] : [];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === 'flow-grid-tile-container') return [];
      return [];
    },
  };
  const context = vm.createContext({
    document,
    location: { href: `https://flow.google.com/project/${projectId}` },
    ProviderRegistry: { describeUrl: () => ({ isProjectEditor: projectEditor, projectId }) },
    FlowTiles: { flowMediaGridScrollContainer: () => null },
    ensureFlowLibrarySection: async () => true,
    visible: element => element !== dialog || element.isVisible,
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    AbortController,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context);
  return context.FlowMediaMenu;
}

test('complete library scan reports a verified empty baseline for Flow’s empty project drop zone', async () => {
  const scanner = createScanner({ emptyText: 'Bắt đầu tạo hoặc thả nội dung nghe nhìn' });
  let diagnostics = null;
  const result = await scanner.scanNativeAssets({ requireComplete: true, onDiagnostics: value => { diagnostics = value; } });
  assert.equal(result.length, 0);
  assert.equal(diagnostics?.reachedEnd, true);
  assert.equal(diagnostics?.emptyProject, true);
  assert.equal(diagnostics?.emptyStateSource, 'project_editor_empty_dropzone');
});

test('a missing library grid without verified empty-state evidence still fails closed', async () => {
  const scanner = createScanner({ emptyText: 'Other project content' });
  await assert.rejects(scanner.scanNativeAssets({ requireComplete: true }), error =>
    error.code === 'FLOW_ASSET_GRID_NOT_VISIBLE' && /No media was uploaded/.test(error.message));
});

test('an empty search or asset picker is never treated as an empty project library', async () => {
  const scanner = createScanner({ emptyText: 'Bắt đầu tạo hoặc thả nội dung nghe nhìn', overlay: true });
  await assert.rejects(scanner.scanNativeAssets({ requireComplete: true }), error =>
    error.code === 'FLOW_ASSET_GRID_NOT_VISIBLE');
});
