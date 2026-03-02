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

const PORT  = process.env.PORT || 5000;
const isWin = os.platform() === 'win32';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/',        (req, res) => res.send('Acubens Compiler Backend ✓'));
app.get('/health',  (req, res) => {
  exec('gcc --version && g++ --version', (err, out) =>
    res.json({ status: 'ok', info: out?.split('\n')[0] || 'GCC not found' }));
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

      const lang   = msg.lang === 'cpp' ? 'cpp' : 'c';  // 'c' or 'cpp'
      const isCpp  = lang === 'cpp';
      const ext    = isCpp ? '.cpp' : '.c';
      const id     = crypto.randomBytes(6).toString('hex');

      src = path.join(os.tmpdir(), `prog_${id}${ext}`);
      out = isWin
        ? path.join(os.tmpdir(), `prog_${id}.exe`)
        : path.join(os.tmpdir(), `prog_${id}`);

      let code = msg.code || '';

      // For C: inject unbuffered stdout so printf shows before scanf
      // For C++: inject unbuffered cout so output appears immediately
      if (isCpp) {
        code = code.replace(
          /(int\s+main\s*\([^)]*\)\s*\{)/,
          '$1\nstd::cout.setf(std::ios::unitbuf);\nstd::cerr.setf(std::ios::unitbuf);\n'
        );
      } else {
        code = code.replace(
          /(int\s+main\s*\([^)]*\)\s*\{)/,
          '$1\nsetvbuf(stdout,NULL,_IONBF,0);setvbuf(stderr,NULL,_IONBF,0);\n'
        );
      }

      fs.writeFileSync(src, code, 'utf8');

      // Choose compiler: gcc for C, g++ for C++
      const compiler = isCpp
        ? `g++ "${src}" -o "${out}" -std=c++17 -lm -w`
        : `gcc "${src}" -o "${out}" -lm -w`;

      exec(compiler, { timeout: 15000 }, (err, _o, stderr) => {
        if (err) {
          const e = (stderr || err.message)
            .replace(new RegExp(src.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'g'), isCpp ? 'main.cpp' : 'main.c')
            .replace(new RegExp(out.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'g'), 'a.out');
          send(ws, { type: 'compile_error', data: e.trim() });
          cleanup(); return;
        }

        child = spawn(out, [], { windowsHide: true });
        send(ws, { type: 'started' });

        child.stdout.on('data', d => send(ws, { type: 'stdout', data: d.toString() }));
        child.stderr.on('data', d => send(ws, { type: 'stderr', data: d.toString() }));

        // 30 seconds for interactive programs
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

    // ── STDIN ────────────────────────────────────────────────────────────
    if (msg.type === 'stdin' && child && child.stdin.writable) {
      child.stdin.write(msg.data);
    }

    // ── KILL ─────────────────────────────────────────────────────────────
    if (msg.type === 'kill') {
      cleanup();
      send(ws, { type: 'done', code: -1 });
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`\n  Acubens Compiler Backend → http://localhost:${PORT}\n`);
  exec('gcc --version', (err, out) =>
    console.log(err ? '  !! GCC not found' : '  GCC:  ' + out.split('\n')[0]));
  exec('g++ --version', (err, out) =>
    console.log(err ? '  !! G++ not found' : '  G++:  ' + out.split('\n')[0]));
  console.log('  Node: ' + process.version + '\n');
});
