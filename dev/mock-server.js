// Local test server: serves docs/ and runs apps-script/Code.gs against an in-memory spreadsheet.
// Usage: node dev/mock-server.js [port]   → app at http://localhost:PORT, API at http://localhost:PORT/exec
// The Users-tab keys are printed on start.
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 8787;

function Sheet() { this.data = []; }
Sheet.prototype = {
  getLastRow() { return this.data.length; },
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    if (typeof r === 'string') return { setNumberFormat() {} };
    return {
      setValues(v) {
        v.forEach((row, i) => {
          sh.data[r - 1 + i] = sh.data[r - 1 + i] || [];
          row.forEach((x, j) => { sh.data[r - 1 + i][c - 1 + j] = x; });
        });
        return this;
      },
      setFontWeight() { return this; },
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          out.push([]);
          for (let j = 0; j < nc; j++) out[i].push((sh.data[r - 1 + i] || [])[c - 1 + j] ?? '');
        }
        return out;
      },
    };
  },
  getDataRange() {
    const sh = this;
    const w = Math.max(...sh.data.map(r => r.length));
    return { getValues: () => sh.data.map(r => { const x = [...r]; while (x.length < w) x.push(''); return x; }) };
  },
  setFrozenRows() {},
};

const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = new Sheet()),
  getSheets: () => Object.values(sheets),
  deleteSheet() {},
};
const ctx = {
  SpreadsheetApp: { getActive: () => ss },
  Utilities: {
    getUuid: () => require('crypto').randomUUID(),
    formatDate: d => d.toISOString().slice(0, 10),
  },
  Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: t => ({ t, setMimeType() { return t; } }),
  },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8'), ctx);
ctx.setup();
console.log('Keys:', sheets.Users.data.slice(1).map(r => `${r[0]}=${r[1]}`).join('  '));
fs.writeFileSync(path.join(__dirname, '.keys.json'), JSON.stringify(Object.fromEntries(sheets.Users.data.slice(1))));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer((req, res) => {
  if (req.url.startsWith('/exec')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
    return;
  }
  if (req.url === '/__dump') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sheets.Transactions.data));
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, 'docs', path.normalize(p));
  if (!file.startsWith(path.join(root, 'docs'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log(`House Ledger test server on http://localhost:${port}`));
