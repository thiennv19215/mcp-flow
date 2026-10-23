import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const sidebarHtml = read('../extension/src/ui/sidebar.html');
const sidebarJs = read('../extension/src/ui/sidebar.js');
const panelJs = read('../extension/src/ui/flow-queue-panel.js');
const popupHtml = read('../extension/src/ui/popup.html');
const popupJs = read('../extension/src/ui/popup.js');
const optionsJs = read('../extension/src/ui/options.js');
const trackerJs = read('../extension/src/content/floating-tracker-flow.js');
const i18nSource = read('../extension/src/content/shared/i18n.js');

test('sidebar exposes the chain-video toggle the JS reads', () => {
  // sidebar.js reads #chainVideoFromPrevious in the submit/chain UI paths;
  // without the element chain mode could never be enabled from the Gen form.
  assert.match(sidebarHtml, /id="videoChainOption"/, 'chain option container exists');
  assert.match(sidebarHtml, /id="chainVideoFromPrevious"/, 'chain checkbox exists');
  assert.match(sidebarHtml, /id="videoChainLabel"/, 'chain label element exists');
  assert.match(sidebarHtml, /id="videoChainHint"/, 'chain hint element exists');
  assert.match(sidebarHtml, /Nối video từ video trước/, 'chain toggle has a Vietnamese label');
  // Starts hidden; updateVideoChainUI reveals it only for multi-prompt video.
  assert.match(sidebarHtml, /<div id="videoChainOption" hidden>/);
});

test('queue panel applies a single shared frame line to every prompt', () => {
  // The old guard indexed firstFrames[itemIndex] directly, so the shared
  // (length === 1) frame was dropped for prompts 2..n.
  assert.doesNotMatch(panelJs, /firstFrames\[itemIndex\] \? \{ firstFrame/);
  assert.doesNotMatch(panelJs, /lastFrames\[itemIndex\] \? \{ lastFrame/);
  assert.match(panelJs, /frames\[itemIndex\] \?\? \(frames\.length === 1 \? frames\[0\] : undefined\)/);
  assert.match(panelJs, /frameForPrompt\(firstFrames, itemIndex\)/);
  assert.match(panelJs, /frameForPrompt\(lastFrames, itemIndex\)/);
});

test('queue panel does not guess the source badge from the label text', () => {
  assert.doesNotMatch(panelJs, /includes\("ai"\) \|\| String\(label\)\.toLowerCase\(\)\.includes\("mcp"\)/);
  assert.match(panelJs, /task\?\.metadata\?\.source \|\| "manual"/);
});

test('Gen-tab frame slots render into the slot body and keep slot markup', () => {
  // The whole-slot replaceChildren() destroyed the header, label and hidden
  // file input; rendering targets #genTabFrame{1,2}Body instead.
  assert.doesNotMatch(sidebarJs, /slot\.replaceChildren\(\)/);
  assert.match(sidebarJs, /renderGenTabFrameSlot\("#genTabFrame1Body", sources\[0\]\)/);
  assert.match(sidebarJs, /renderGenTabFrameSlot\("#genTabFrame2Body", picked\)/);
  // Slot markup (header, label, hidden input) lives outside the body.
  assert.match(sidebarHtml, /id="genTabFrame1Body"/);
  assert.match(sidebarHtml, /id="genTabFrame2Body"/);
  assert.match(sidebarHtml, /id="genTabFrame1FileId"/);
  assert.match(sidebarHtml, /id="genTabFrame2FileId"/);
});

test('End frame slot accepts a single pick from an empty pool', () => {
  // The picker returns the cumulative pool; the old `if (sources[1])` check
  // silently dropped a first-ever pick made through the End slot.
  assert.doesNotMatch(sidebarJs, /if \(sources\[1]\)/);
  assert.match(sidebarJs, /!previousSources\.includes\(source\)\) \|\| sources\[1\] \|\| sources\[0\]/);
  assert.match(sidebarJs, /videoFrameAssignments\[0\]\.last = picked/);
});

test('generation progress is routed by the gen-type select, not a missing form', () => {
  assert.doesNotMatch(sidebarJs, /#formImage/);
  assert.match(sidebarJs, /const isImage = \(document\.querySelector\("#genType"\)\?\.value \|\| "image"\) === "image";\s*\n\s*const btnTextEl = isImage/);
});

test('addLog escapes interpolated name and detail', () => {
  const addLogBlock = sidebarJs.slice(sidebarJs.indexOf('function addLog'), sidebarJs.indexOf('async function fetchStatus'));
  assert.match(addLogBlock, /\$\{escapeHtml\(name\)\}/);
  assert.match(addLogBlock, /\$\{escapeHtml\(detail\)\}/);
  assert.doesNotMatch(addLogBlock, /<div class="log-detail">\$\{detail\}<\/div>/);
});

test('character trigger thumbnail assigns the avatar URL via DOM properties', () => {
  assert.doesNotMatch(sidebarJs, /<img src="\$\{avatar\}"/);
  assert.match(sidebarJs, /img\.src = avatar/);
});

test('previously raw i18n keys resolve in both locales', () => {
  runInThisContext(i18nSource);
  const { I18n } = globalThis;
  const keys = [
    'character.none',
    'voice.random',
    'header.lightMode',
    'header.darkMode',
    'sidebar.videoReferencePickerTitle',
    'sidebar.videoReferencePickerUploadHint',
    'sidebar.videoReferencePickerFlowTab',
    'sidebar.framePickerLocalDescription',
    'sidebar.referencePickerLocalDescription',
    'sidebar.referencePickerVideoUploadUnsupported',
  ];
  for (const locale of ['vi', 'en']) {
    I18n._currentLocale = locale;
    for (const key of keys) {
      const value = I18n.t(key);
      assert.notEqual(value, key, `${locale} resolves ${key}`);
      assert.ok(value.length > 0, `${locale} has text for ${key}`);
    }
  }
});

test('popup no longer advertises the removed Studio', () => {
  assert.doesNotMatch(popupHtml, /Mở Studio/);
  assert.match(popupHtml, /id="txtOpenStudio">Mở thanh bên \(Tạo Ảnh \/ Video \/ Nhân Vật\)</);
  runInThisContext(i18nSource);
  const { I18n } = globalThis;
  I18n._currentLocale = 'vi';
  assert.equal(I18n.t('popup.btnStudio'), 'Mở thanh bên (Tạo Ảnh / Video / Nhân Vật)');
  I18n._currentLocale = 'en';
  assert.equal(I18n.t('popup.btnStudio'), 'Open Side Panel (Image / Video / Character)');
});

test('popup localizes the real options button instead of a missing label span', () => {
  assert.doesNotMatch(popupJs, /#txtOptions/);
  assert.match(popupJs, /document\.querySelector\("#options"\)/);
  assert.match(popupJs, /optionsBtn\.title = t\("btnOptions"\)/);
});

test('options guide step 1 renders its <code> markup like steps 2 and 3', () => {
  assert.match(optionsJs, /document\.querySelector\("#step1"\)\.innerHTML = t\("step1"\)/);
  assert.doesNotMatch(optionsJs, /document\.querySelector\("#step1"\)\.textContent/);
});

test('floating tracker gives cancelled jobs their own status and label', () => {
  assert.doesNotMatch(trackerJs, /status === "failed" \|\| status === "cancelled"\) return "failed"/);
  assert.match(trackerJs, /if \(status === "cancelled"\) return "cancelled";/);
  assert.match(trackerJs, /isCancelled \? "Đã hủy"/);
  // Cancelled is a finished state, so "clear finished" removes it too.
  assert.match(trackerJs, /\["completed", "failed", "cancelled"\]\.includes\(job\.status\)/);
});
