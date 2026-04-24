'use strict';
// Usage:
//   node test.js openai
//   node test.js azure
//   node test.js openai spm/bm.wav
//   node test.js openai spm/bm.wav en-MY

const fs   = require('fs');
const path = require('path');
const http = require('http');

const MODEL    = process.argv[2] || 'openai';
const FILE     = process.argv[3] || path.join(__dirname, 'spm', 'bm.wav');
const LANGUAGE = process.argv[4] || 'ms-MY';

if (!fs.existsSync(FILE)) {
  console.error(`File not found: ${FILE}`);
  process.exit(1);
}

const ext       = path.extname(FILE).toLowerCase();
const mime      = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
const filename  = path.basename(FILE);
const fileBytes = fs.readFileSync(FILE);
const boundary  = '----Boundary' + Date.now();

const header = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${MODEL}\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${LANGUAGE}\r\n` +
  `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
);
const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
const body   = Buffer.concat([header, fileBytes, footer]);

const opts = {
  hostname: 'localhost', port: 3000, path: '/transcribe', method: 'POST',
  headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
};

console.log(`Model: ${MODEL} | File: ${filename} | Language: ${LANGUAGE}`);
const req = http.request(opts, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => console.log(JSON.parse(data)));
});
req.on('error', err => console.error('Error:', err.message));
req.write(body);
req.end();
