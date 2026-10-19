import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettings } from '../dist/flow.js';

test('already-selected latest model may close settings; x1 is selected only after reopening', async () => {
  let settingsOpen = false, modelOpen = false, settingsClicks = 0;
  const page = {
    waitForTimeout: async () => {},
    keyboard: { press: async () => { settingsOpen = false; modelOpen = false; } },
    locator: () => ({ count: async () => 0 }),
    getByRole(role, options = {}) {
      if (role === 'radio') {
        const locator = {
          first: () => locator,
          isVisible: async () => settingsOpen && !modelOpen,
          waitFor: async () => { if (!settingsOpen || modelOpen) throw new Error(`Hidden ${options.name}`); },
          isChecked: async () => true,
        };
        return locator;
      }
      if (role === 'button' && options.name === 'Settings trigger') return { click: async () => { settingsClicks++; settingsOpen = true; } };
      if (role === 'button' && options.name === 'Select model family') return {
        click: async () => { modelOpen = true; }, innerText: async () => 'Nano Banana 2.1',
      };
      if (role === 'menuitem') return {
        first: () => ({ waitFor: async () => assert.equal(modelOpen, true) }),
        allInnerTexts: async () => ['Nano Banana 2.1'],
      };
      if (role === 'link') return { innerText: async () => {
        const matches = ['Add AI credits', '0 credits'].filter(text => options.name.test(text));
        assert.deepEqual(matches, ['0 credits']);
        return matches[0];
      } };
      throw new Error(`Unexpected selector ${role} ${options.name}`);
    },
  };
  const cost = await applySettings(page, { params: { type: 'image', model: 'latest', variants: 1 } });
  assert.equal(cost, 0);
  assert.equal(settingsClicks, 2);
  assert.equal(settingsOpen, false);
});
