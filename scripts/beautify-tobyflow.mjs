import fs from 'node:fs';
import path from 'node:path';
import beautify from 'js-beautify';

const targetDir = 'C:\\Users\\nguye\\Downloads\\1.3.103_0';

const jsOptions = {
  indent_size: 2,
  indent_char: ' ',
  max_preserve_newlines: 2,
  preserve_newlines: true,
  keep_array_indentation: false,
  break_chained_methods: false,
  indent_scripts: 'normal',
  brace_style: 'collapse',
  space_before_conditional: true,
  unescape_strings: true,
  jslint_happy: false,
  end_with_newline: true,
  wrap_line_length: 120,
  comma_first: false,
  e4x: true
};

const htmlOptions = {
  indent_size: 2,
  indent_char: ' ',
  max_preserve_newlines: 2,
  preserve_newlines: true,
  end_with_newline: true,
  wrap_line_length: 120,
  unescape_strings: true
};

const cssOptions = {
  indent_size: 2,
  indent_char: ' ',
  max_preserve_newlines: 2,
  preserve_newlines: true,
  end_with_newline: true
};

function unescapeUnicode(str) {
  return str
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
      const code = parseInt(hex, 16);
      // Only unescape non-ASCII printable characters (like Vietnamese diacritics, CJK, etc.)
      // and skip control characters or special characters that could break string delimiters
      if (code >= 128 && code !== 0x2028 && code !== 0x2029) {
        return String.fromCharCode(code);
      }
      return match;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => {
      const code = parseInt(hex, 16);
      if (code >= 128) {
        return String.fromCharCode(code);
      }
      return match;
    });
}

function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== '_metadata' && file !== 'node_modules') {
        getAllFiles(fullPath, fileList);
      }
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

console.log('Scanning files in:', targetDir);
const allFiles = getAllFiles(targetDir);
console.log(`Found ${allFiles.length} files to process.`);

let processedCount = 0;
let errorCount = 0;

for (const filePath of allFiles) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    let formatted = null;

    if (ext === '.js' || ext === '.mjs') {
      const beautified = beautify.js(content, jsOptions);
      formatted = unescapeUnicode(beautified);
    } else if (ext === '.html' || ext === '.htm') {
      const beautified = beautify.html(content, htmlOptions);
      formatted = unescapeUnicode(beautified);
    } else if (ext === '.css') {
      formatted = beautify.css(content, cssOptions);
    } else if (ext === '.json') {
      try {
        const parsed = JSON.parse(content);
        formatted = JSON.stringify(parsed, null, 2) + '\n';
      } catch {
        // Keep original
      }
    }

    if (formatted && formatted !== content) {
      fs.writeFileSync(filePath, formatted, 'utf-8');
      processedCount++;
    }
  } catch (err) {
    console.error(`Error formatting ${filePath}:`, err.message);
    errorCount++;
  }
}

console.log(`Done! Successfully formatted ${processedCount} files (Errors: ${errorCount}).`);
