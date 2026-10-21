import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  flowDocumentMatchesLocale,
  flowLocaleFromUrl,
  flowProjectUrl,
  forceEnglishFlowUrl,
  normalizeFlowLocale,
} from '../extension/background/flow-locale.js';

const worker = readFileSync(new URL('../extension/background/service-worker.js', import.meta.url), 'utf8');
const projectId = '01234567-89ab-4cde-8f01-23456789abcd';

test('Flow automation URL policy is English-only and defaults project URLs to English', () => {
  assert.equal(normalizeFlowLocale('EN'), 'en');
  assert.equal(normalizeFlowLocale('vi'), null);
  assert.equal(normalizeFlowLocale('fr'), null);
  assert.equal(flowLocaleFromUrl(`https://flow.google.com/project/${projectId}?hl=vi`), null);
  assert.equal(flowLocaleFromUrl(`https://flow.google.com/project/${projectId}?hl=en`), 'en');
  assert.equal(flowLocaleFromUrl(`https://flow.google.com/project/${projectId}?hl=fr`), null);
  assert.equal(flowProjectUrl(projectId), `https://flow.google.com/project/${projectId}?hl=en`);
  assert.throws(() => flowProjectUrl(projectId, 'vi'), /must be en/);
  assert.throws(() => flowProjectUrl(projectId, 'fr'), /must be en/);
  assert.equal(
    forceEnglishFlowUrl(`https://flow.google.com/project/${projectId}?hl=vi&foo=keep&x=1#section`),
    `https://flow.google.com/project/${projectId}?hl=en&foo=keep&x=1#section`,
  );
  assert.throws(() => forceEnglishFlowUrl('https://example.com/project/x?hl=vi'), /Expected a Flow URL/);
});

test('Flow document locale verification accepts English regional tags only', () => {
  assert.equal(flowDocumentMatchesLocale('en-US', 'en'), true);
  assert.equal(flowDocumentMatchesLocale('vi-VN', 'en'), false);
  assert.equal(flowDocumentMatchesLocale('en', 'vi'), false);
  assert.equal(flowDocumentMatchesLocale('', 'en'), false);
});

test('tab preparation forces hl=en while preserving unrelated URL parameters', () => {
  assert.match(worker, /const locale = "en"/);
  assert.match(worker, /const englishUrl = forceEnglishFlowUrl\(currentUrl\)/);
  assert.match(worker, /if \(englishUrl !== currentUrl \|\| !flowDocumentMatchesLocale\(documentLanguage, locale\)\)/);
  assert.match(worker, /await verifyFlowDocumentLocale\(tabId, locale\)/);
  assert.match(worker, /error\.code = "FLOW_LOCALE_MISMATCH"/);
  assert.match(worker, /flowProjectUrl\(projectId, language\)/);
  assert.match(worker, /requestedLanguage !== "en"/);
  assert.doesNotMatch(worker, /flowTabLocales|rememberFlowTabLocale|storedFlowTabLocale/);
  assert.match(worker, /command\.payload\?\.language \?\? "en"/);
  assert.doesNotMatch(worker, /ensureEnglishFlowTab/);
});

test('Flow URL changes trigger locale preparation, with active-operation guards intact', () => {
  assert.match(worker, /if \(flowUrl\(tab\.url\) && \(tab\.active \|\| selectedTabId === undefined\)\) \{[\s\S]*adoptFlowTab\(tab, Boolean\(changeInfo\.url\)\)/);
  assert.match(worker, /async function prepareFlowTab\(tabId\) \{\s*if \(tabOperationActive\(tabId\)\) return;/);
  assert.match(worker, /async function ensureFlowTabLocale\(tabId\) \{\s*if \(tabOperationActive\(tabId\)\) return;/);
});
