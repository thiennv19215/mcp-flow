import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');
const sidebarCss = readFileSync(new URL('../extension/src/ui/sidebar.css', import.meta.url), 'utf8');
const sidebarJs = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../extension/src/content/shared/i18n.js', import.meta.url), 'utf8');

test('sidebar shows a no-Flow-tab banner with an open-Flow action', () => {
  assert.match(sidebarHtml, /id="noFlowBanner"/, 'banner element exists');
  assert.match(sidebarHtml, /id="btnOpenFlowBanner"/, 'banner has its own open-Flow button');
  assert.match(sidebarHtml, /popup\.noFlowTabHint/, 'banner text is localized');
  assert.match(sidebarHtml, /popup\.btnOpenFlow/, 'banner button reuses the Open Google Flow label');
  // Starts hidden; renderStatus reveals it only when no Flow tab is open.
  assert.match(sidebarHtml, /class="no-flow-banner hidden"/);
  assert.match(sidebarJs, /noFlowBanner\.classList\.toggle\("hidden", count > 0\)/);
  // The banner button reuses the existing open/focus-Flow behavior.
  assert.match(sidebarJs, /btnOpenFlowBanner\.onclick = \(\) => document\.querySelector\("#btnOpenFlow"\)\?\.click\(\)/);
});

test('the banner hint exists in both locales', () => {
  const occurrences = i18n.match(/noFlowTabHint:/g) || [];
  assert.equal(occurrences.length, 2, 'vi and en both define popup.noFlowTabHint');
});

test('the no-Flow banner keeps its text readable beside the full-width primary button', () => {
  assert.match(sidebarCss, /\.no-flow-banner \.btn-primary\s*\{\s*width:\s*auto;\s*max-width:\s*100%\s*\}/);
  assert.match(sidebarCss, /@media\s*\(max-width:\s*420px\)[\s\S]*?\.no-flow-banner\s*\{[^}]*flex-direction:\s*column/);
  assert.match(sidebarCss, /@media\s*\(max-width:\s*420px\)[\s\S]*?\.no-flow-banner \.btn-primary\s*\{\s*width:\s*100%/);
});
