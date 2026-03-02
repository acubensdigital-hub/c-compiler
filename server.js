const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const WebSocket  = require('ws');
const { exec, spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const os         = require('os');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// Railway injects PORT automatically — fallback to 5000 for local dev
const PORT = process.env.PORT || 5000;
const isWin = os.platform() === 'win32';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// Health check (Railway uses this to confirm app is running)
app.get('/', (req, res) => res.send('C Compiler backend running ✓'));
app.get('/health', (req, res) => {
  exec('gcc --version', (err, out) =>
    res.json({ status: 'ok', gcc: err ? 'NOT FOUND' : out.split('\n')[0] }));
});

const send = (ws, obj) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

wss.on('connection', (ws) => {
  let child = null, src = null, out = null, timer = null;

  const cleanup = () => {
    if (timer)  { clearTimeout(timer); timer = null; }
    if (child)  { try { child.kill(); } catch {} child = null; }
    try { if (src) fs.unlinkSync(src); } catch {} src = null;
    try { if (out) fs.unlinkSync(out); } catch {} out = null;
  };

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── RUN ──────────────────────────────────────────────────────────────
    if (msg.type === 'run') {
      cleanup();
      const id  = crypto.randomBytes(6).toString('hex');
      src = path.join(os.tmpdir(), `c_${id}.c`);
      out = isWin
        ? path.join(os.tmpdir(), `c_${id}.exe`)
        : path.join(os.tmpdir(), `c_${id}`);

      // Inject unbuffered stdout so printf shows before scanf blocks
      let code = (msg.code || '').replace(
        /(int\s+main\s*\([^)]*\)\s*\{)/,
        '$1\nsetvbuf(stdout,NULL,_IONBF,0);setvbuf(stderr,NULL,_IONBF,0);\n'
      );
      fs.writeFileSync(src, code, 'utf8');

      exec(`gcc "${src}" -o "${out}" -lm -w`, { timeout: 15000 }, (err, _o, stderr) => {
        if (err) {
          const e = (stderr || err.message)
            .replace(new RegExp(src.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'g'), 'main.c')
            .replace(new RegExp(out.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'g'), 'a.out');
          send(ws, { type: 'compile_error', data: e.trim() });
          cleanup(); return;
        }

        child = spawn(out, [], { windowsHide: true });
        send(ws, { type: 'started' });

        child.stdout.on('data', d => send(ws, { type: 'stdout', data: d.toString() }));
        child.stderr.on('data', d => send(ws, { type: 'stderr', data: d.toString() }));

        timer = setTimeout(() => {
          send(ws, { type: 'timeout' });
          cleanup();
        }, 30000);

        child.on('close', code => {
          clearTimeout(timer); timer = null;
          send(ws, { type: 'done', code });
          child = null;
          try { if (src) fs.unlinkSync(src); } catch {} src = null;
          try { if (out) fs.unlinkSync(out); } catch {} out = null;
        });

        child.on('error', e => {
          clearTimeout(timer); timer = null;
          send(ws, { type: 'error', data: e.message });
          cleanup();
        });
      });
    }

    if (msg.type === 'stdin' && child && child.stdin.writable) {
      child.stdin.write(msg.data);
    }

    if (msg.type === 'kill') {
      cleanup();
      send(ws, { type: 'done', code: -1 });
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`\n  C Compiler backend running on port ${PORT}\n`);
  exec('gcc --version', (err, out) => {
    console.log(err ? '  !! GCC not found' : '  GCC: ' + out.split('\n')[0]);
    console.log('  Node: ' + process.version + '\n');
  });
});
