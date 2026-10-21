import { readFileSync } from 'node:fs';

const modules = [
  '../../extension/src/content/providers/flow/composer/reference-actions.js',
  '../../extension/src/content/providers/flow/composer/voice-actions.js',
  '../../extension/src/content/providers/flow/media/uploader.js',
  '../../extension/src/content/providers/flow/generation/native-frame-picker.js',
  '../../extension/src/content/providers/flow/compatibility/flow-components.js',
];

export const flowComponentsSource = modules
  .map(path => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
