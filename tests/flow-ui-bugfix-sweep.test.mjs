import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const sidebarHtml = read('../extension/src/ui/sidebar.html');
const sidebarCss = read('../extension/src/ui/sidebar.css');
const sharedUiCss = read('../extension/src/ui/flow-mcp-ui.css');
const sidebarJs = read('../extension/src/ui/sidebar.js');
const referencePickerJs = read('../extension/src/ui/reference-picker.js');
const panelJs = read('../extension/src/ui/flow-queue-panel.js');
const optionsJs = read('../extension/src/ui/options.js');
const trackerJs = read('../extension/src/content/floating-tracker-flow.js');
const serviceWorkerJs = read('../extension/src/background/service-worker.js');
const i18nSource = read('../extension/src/content/shared/i18n.js');
const flowLibraryOperationsJs = read('../extension/src/content/providers/flow/library/library-operations.js');
const flowMediaMenuJs = read('../extension/src/content/providers/flow/media/media-menu.js');

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

test('Gen-tab frame slots stay clickable when their thumbnails render', () => {
  assert.ok(sidebarHtml.includes('<button type="button" class="frame-dropzone" id="genTabFrame1PickBtn">'));
  assert.ok(sidebarHtml.includes('<button type="button" class="frame-dropzone" id="genTabFrame2PickBtn">'));
  assert.ok(sidebarJs.includes('function renderGenTabFrameSlot(buttonSelector, source, labelKey)'));
  assert.ok(sidebarJs.includes('button.replaceChildren();'));
  assert.ok(sidebarJs.includes('bindFrameThumbnail(button, source, "frame-thumb-fallback")'));
  assert.ok(!sidebarJs.includes('button.replaceWith'));
});

test('Start and End choose one frame directly from the library, with two slots total', () => {
  assert.equal([...sidebarHtml.matchAll(/id="genTabFrame[12]PickBtn"/g)].length, 2);
  assert.ok(referencePickerJs.includes('const selectionLimit = () => pickerPurpose === "frame-slot" ? 1 : 3;'));
  assert.ok(referencePickerJs.includes('open("video", "frame-slot");'));
  assert.ok(referencePickerJs.includes('setPickerTab(pickerPurpose === "frame-slot" ? "flow" : "upload");'));
  assert.ok(referencePickerJs.includes('function commitFrameSlot(source)'));
  assert.ok(referencePickerJs.includes('commitFrameSlot(flowReferenceFor(asset, thumbnailUrl))'));
  assert.ok(referencePickerJs.includes('commitFrameSlot(flowReferenceFor(image, image.thumbnailUrl || null))'));
  assert.ok(referencePickerJs.includes('confirmButton.hidden = pickerPurpose === "frame-slot";'));
  assert.match(sidebarCss, /#refPickerConfirm\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.ok(referencePickerJs.includes('fileInput.multiple = pickerPurpose !== "frame-slot";'));
  assert.match(referencePickerJs, /commitFrameSlot\(\{\s*source: "local",[\s\S]*?previewUrl: URL\.createObjectURL\(file\)/);
  assert.ok(sidebarJs.includes('referencePicker.openFrameSlot(source => setVideoFrameSelection("first", source))'));
  assert.ok(sidebarJs.includes('referencePicker.openFrameSlot(source => setVideoFrameSelection("last", source))'));
  for (const staleName of ['openFrames', 'getFrameSources', 'videoFrameSources', 'videoFrameAssignments']) {
    assert.ok(!sidebarJs.includes(staleName), 'sidebar.js no longer uses ' + staleName);
  }
});

test('Frames has an independent Flow library upload action that refreshes the picker', () => {
  assert.match(sidebarHtml, /id="videoFramesUploadBtn"[^>]*type="button"/);
  assert.match(sidebarHtml, /id="videoFramesUploadInput"[^>]*type="file" accept="image\/\*"/);
  assert.match(sidebarHtml, /id="videoFramesUploadStatus"[^>]*role="status" aria-live="polite"/);
  const uploadBlock = sidebarJs.slice(sidebarJs.indexOf('async function uploadFrameImageToLibrary'), sidebarJs.indexOf('// One builder for every attachment'));
  assert.match(uploadBlock, /assertQueueIdleForReferenceUpload\(\)/);
  assert.match(uploadBlock, /uploadReferenceImage\(file, onProgress, 1\)/);
  assert.match(uploadBlock, /referencePicker\.refreshFlowAssets\(\)/);
  const handler = sidebarJs.slice(sidebarJs.indexOf('const frameUploadButton ='), sidebarJs.indexOf('// Reference images buttons'));
  assert.match(handler, /frameUploadButton\?\.addEventListener\("click", \(\) => frameUploadInput\?\.click\(\)\)/);
  assert.match(handler, /uploadFrameImageToLibrary\(file, progress =>/);
  assert.match(handler, /frameLibraryUploadComplete/);
  assert.match(handler, /catch \(error\)[\s\S]*?setFrameUploadStatus\(message, true\)/);
  assert.doesNotMatch(handler, /btnSubmitVideo|submitVideo|genSubmitBtn/);
  assert.match(referencePickerJs, /refreshFlowAssets: async \(\) => \{[\s\S]*?flowAssetCacheByProject\.delete\(pickerProjectId\)[\s\S]*?loadFlowPickerAssets\(\{ background: true, force: true \}\)/);
});

test('Frames mode removes the shared reference picker and explains the two frame limit', () => {
  const frameInputs = sidebarJs.slice(sidebarJs.indexOf('function updateVideoFrameInputs'), sidebarJs.indexOf('function updateVideoChainUI'));
  assert.match(frameInputs, /const framesMode = isVideo && .*?=== "frames"/);
  assert.match(frameInputs, /querySelector\("#refImagesSection"\)/);
  assert.match(frameInputs, /classList\.toggle\("hidden", framesMode\)/);
  assert.match(sidebarHtml, /data-i18n="sidebar\.videoFramesHint"[^>]*>[^<]*Tối đa 2 ảnh/);
});

test('Flow home requires an explicit project before generation', () => {
  assert.match(sidebarHtml, /id="flowProjectGate"/);
  assert.match(sidebarHtml, /id="flowProjectGateSelect"/);
  assert.match(sidebarHtml, /id="flowProjectGateOpen"/);
  assert.match(sidebarJs, /dispatchFlowOperation\("flow\.context"\)/);
  assert.match(sidebarJs, /dispatchFlowOperation\("flow\.projects\.list"\)/);
  assert.match(sidebarJs, /dispatchFlowOperation\("flow\.project\.open", \{ projectId \}\)/);
  assert.match(sidebarJs, /if \(\!\(await ensureFlowProjectSelected\(\)\)\) return false;/);
  assert.match(sidebarJs, /start\.disabled = isFlow \? \(visible \|\| busy\) : false/);
  assert.match(sidebarJs, /if \(force \|\| !flowProjectsLoaded\)/);
  assert.match(sidebarJs, /context\?\.isProjectEditor !== true \|\| !context\?\.projectId/);
});

test('compact navigation hides the three optional library/task/tool entries', () => {
  for (const id of ['navTasks', 'navPhotos', 'navTools']) {
    assert.match(sidebarHtml, new RegExp(`<button[^>]*hidden[^>]*id="${id}"`));
  }
  assert.match(sidebarHtml, /<div hidden class="flowmcp-tab-divider"/);
  assert.match(sidebarJs, /querySelectorAll\("\.flowmcp-tab:not\(\[hidden\]\)"\)/);
  assert.match(sidebarCss, /\.flowmcp-tab\[hidden\][\s\S]*display:\s*none\s*!important/);
});

test('provider selector hides Grok and Muse', () => {
  assert.match(sidebarHtml, /<button hidden[^>]*data-provider="grok"/);
  assert.match(sidebarHtml, /<button hidden[^>]*data-provider="muse"/);
  assert.match(sidebarJs, /#genProviderTabs \.provider-tab:not\(\[hidden\]\)/);
  assert.match(sidebarCss, /\.provider-tab\[hidden\][\s\S]*display:\s*none\s*!important/);
});

test('watermark kind toggles stay out of the compact generation controls', () => {
  assert.match(sidebarHtml, /<span hidden class="wm-kind-flags" id="genTabWatermarkKinds">/);
  assert.match(sidebarHtml, /id="genTabWatermarkImage"/);
  assert.match(sidebarHtml, /id="genTabWatermarkVideo"/);
  assert.match(sidebarCss, /\.wm-kind-flags\[hidden\][\s\S]*display:\s*none\s*!important/);
});

test('My Prompts editor keeps fields readable and confirms local storage', () => {
  assert.match(sidebarHtml, /class="input-group myprompts-search-group"/);
  assert.match(sidebarHtml, /class="section-card myprompt-editor-card"/);
  assert.match(sidebarHtml, /class="form-group myprompt-field"/);
  assert.match(sidebarHtml, /data-i18n="sidebar\.promptLocalNote"/);
  assert.match(sharedUiCss, /#subtab-myprompts \.myprompt-field,\s*\n#subtab-myprompts \.myprompt-addon-field[\s\S]*flex-direction: column/);
  assert.match(sharedUiCss, /#subtab-myprompts #promptDraft[\s\S]*height: 132px/);
  assert.match(sidebarJs, /FlowSnippetStore/);
  assert.match(sidebarJs, /chrome\.storage\.local/);
});

test('Video Frames section uses compact but clickable Start/End slots', () => {
  assert.match(sidebarCss, /#videoFramesSection \.frame-slot-body,[\s\S]*height: 58px/);
  assert.match(sidebarCss, /#videoFramesSection \.frame-dropzone[\s\S]*height: 58px/);
  assert.match(sidebarCss, /#videoFramesSection \.video-frames-upload-btn[\s\S]*min-height: 26px/);
  assert.match(sidebarCss, /#videoFramesSection \.frame-dropzone-content[\s\S]*display: inline-flex/);
  assert.match(sidebarCss, /#videoFramesSection \.frame-dropzone:focus-visible,[\s\S]*outline: 2px solid var\(--primary\)/);
  assert.ok(sidebarHtml.includes('id="genTabFrame1PickBtn"'));
  assert.ok(sidebarHtml.includes('id="genTabFrame2PickBtn"'));
  assert.match(sidebarHtml, /data-i18n="sidebar\.framePickerSlotHint"/);
  assert.match(sidebarJs, /setAttribute\("aria-controls", "referencePickerModal"\)/);
});

test('local media checks the complete Flow library before uploading', () => {
  const uploadBlock = sidebarJs.slice(sidebarJs.indexOf('async function uploadReferenceImage'), sidebarJs.indexOf('// One builder for every attachment'));
  assert.ok(uploadBlock.indexOf('findExistingFlowAsset(file, kind)') < uploadBlock.indexOf('uploadWithCancel(file'),
    'an existing Flow tile is resolved before the uploader is called');
  assert.match(uploadBlock, /if \(existingAsset\)[\s\S]*?return existingAsset/);
  assert.match(uploadBlock, /callerKey:\s*"flow-sidebar-reference-v1"/);
  assert.match(uploadBlock, /finally\s*\{[\s\S]*?flowLibrarySnapshot\s*=\s*\{[\s\S]*?fetchedAt:\s*0[\s\S]*?assets:\s*null/,
    'after any upload attempt, the next deduplication check gets a fresh complete scan');
  assert.match(sidebarJs, /requireComplete:\s*true/);
  assert.match(sidebarJs, /assetName:\s*`asset:\$\{asset\.name\}`/);
  assert.match(sidebarJs, /reusedFromLibrary === true/);

  const listBlock = flowLibraryOperationsJs.slice(flowLibraryOperationsJs.indexOf('if (name === "flow.assets.list")'), flowLibraryOperationsJs.indexOf('if (name === "flow.characters.list")'));
  assert.match(listBlock, /requireComplete:\s*payload\.requireComplete === true/);
  assert.match(listBlock, /maxDurationMs:\s*payload\.maxDurationMs/);
  assert.match(flowMediaMenuJs, /if \(options\.requireComplete && !reachedEnd && !options\.exactName\)[\s\S]*FLOW_ASSET_SCAN_INCOMPLETE/,
    'an incomplete scan fails before the caller can decide to upload');
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
    'sidebar.frameLibraryUploadButton',
    'sidebar.frameLibraryUploadPending',
    'sidebar.frameLibraryUploadProgress',
    'sidebar.frameLibraryUploadComplete',
    'sidebar.frameLibraryUploadReused',
    'sidebar.projectGateTitle',
    'sidebar.projectGateHint',
    'sidebar.projectGatePlaceholder',
    'sidebar.projectGateOpen',
    'sidebar.projectGateLoading',
    'sidebar.projectGateOpening',
    'sidebar.projectGateReady',
    'sidebar.projectGateEmpty',
    'sidebar.promptLocalNote',
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

test('floating tracker is compact and keeps its visible controls actionable', () => {
  assert.match(trackerJs, /width: min\(410px, calc\(100vw - 24px\)\)/);
  assert.match(trackerJs, /max-height: min\(360px, calc\(100vh - 32px\)\)/);
  assert.match(trackerJs, /width: min\(500px, calc\(100vw - 24px\)\)/);
  assert.match(trackerJs, /#flow-mcp-tracker-root\.collapsed \.flow-ft-content \{ display: none !important; \}/);
  assert.match(trackerJs, /minBtn\?\.addEventListener\("click", \(\) => \{[\s\S]*?classList\.toggle\("collapsed"\)/);
  assert.match(trackerJs, /closeBtn\?\.addEventListener\("click", \(\) => this\.setMinimized\(true\)\)/);

  assert.doesNotMatch(trackerJs, /data-ft-action="pause-group"|data-ft-action="stop-group"/,
    'group buttons no longer show global pause/stop actions that do nothing for completed groups');
  assert.match(trackerJs, /groupJobs\.length > 1 && groupJobs\.some\(job => this\.canDownloadGeneratedMedia\(job\)/,
    'group download appears only when a multi-task group has downloadable results');
  assert.match(trackerJs, /const ids = \[\.\.\.new Set\(/,
    'group removal deduplicates the task id shared by download and delete buttons');
  assert.match(trackerJs, /if \(stopButton\) stopButton\.style\.display = isRunning \|\| pendingCount > 0 \|\| waitingForUser/,
    'stop is hidden when there is no queue work to stop');
  assert.match(trackerJs, /const response = await chrome\.runtime\.sendMessage\([\s\S]*?if \(!response\?\.ok\)[\s\S]*?showActionFeedback/,
    'queue actions display the reason when the service worker rejects an action');
  assert.match(trackerJs, /else if \(download\?\.filename\) actionHtml = `<span class="flow-ft-download-done"/,
    'a completed download is shown as a status marker, not a fake clickable arrow');
  assert.match(trackerJs, /!\["queued", "downloading"\]\.includes\(downloadState\)/,
    'completed results can be downloaded again from a working button');
  assert.match(serviceWorkerJs, /case "flow-queue:remove": \{[\s\S]*?if \(!removed\) throw Object\.assign[\s\S]*FLOW_QUEUE_REMOVE_FAILED/,
    'a rejected queue removal is reported back to the tracker');
});
