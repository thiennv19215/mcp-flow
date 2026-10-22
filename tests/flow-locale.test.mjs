import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  flowDocumentMatchesLocale,
  flowHomeUrl,
  flowLocaleFromUrl,
  flowProjectUrl,
  normalizeFlowLocale,
} from '../extension/src/background/flow-locale.js';

const worker = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const projectId = '01234567-89ab-4cde-8f01-23456789abcd';

test('Flow locale helpers preserve an optional user-selected locale', () => {
  assert.equal(normalizeFlowLocale('EN'), 'en');
  assert.equal(normalizeFlowLocale('vi-VN'), 'vi-vn');
  assert.equal(normalizeFlowLocale('zh_Hant'), 'zh-hant');
  assert.equal(normalizeFlowLocale('not a locale'), null);
  assert.equal(flowLocaleFromUrl(`https://flow.google.com/project/${projectId}?hl=vi`), 'vi');
  assert.equal(flowLocaleFromUrl(`https://flow.google.com/project/${projectId}?hl=fr`), 'fr');
  assert.equal(flowProjectUrl(projectId), `https://flow.google.com/project/${projectId}`);
  assert.equal(flowProjectUrl(projectId, 'vi'), `https://flow.google.com/project/${projectId}?hl=vi`);
  assert.equal(flowHomeUrl(), 'https://flow.google.com/');
  assert.equal(flowHomeUrl('vi'), 'https://flow.google.com/?hl=vi');
});

test('Flow document locale comparison handles regional tags without imposing English', () => {
  assert.equal(flowDocumentMatchesLocale('en-US', 'en'), true);
  assert.equal(flowDocumentMatchesLocale('vi-VN', 'vi'), true);
  assert.equal(flowDocumentMatchesLocale('vi-VN', 'en'), false);
  assert.equal(flowDocumentMatchesLocale('fr', undefined), true);
  assert.equal(flowDocumentMatchesLocale('', undefined), false);
});

test('tab preparation leaves Flow locale and URL untouched', () => {
  assert.doesNotMatch(worker, /forceEnglishFlowUrl|const locale = "en"/);
  assert.match(worker, /Flow can change locale through its own controls\/account preferences/);
  assert.match(worker, /flowProjectUrl\(projectId, language\)/);
  assert.doesNotMatch(worker, /requestedLanguage !== "en"/);
  assert.doesNotMatch(worker, /command\.payload\?\.language \?\? "en"/);
  assert.match(worker, /async function prepareFlowTab\(tabId\) \{\s*if \(tabOperationActive\(tabId\)\) return;/);
  assert.doesNotMatch(worker, /flowTabLocales|rememberFlowTabLocale|storedFlowTabLocale/);
});
