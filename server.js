const express        = require('express');
const cors           = require('cors');
const http           = require('http');
const WebSocket      = require('ws');
const { exec, spawn } = require('child_process');
const fs             = require('fs');
const path           = require('path');
const crypto         = require('crypto');
const os             = require('os');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 5000;
const isWin  = os.platform() === 'win32';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/',       (req, res) => res.send('Acubens Compiler Backend ✓'));
app.get('/health', (req, res) => res.json({ status: 'ok', node: process.version }));

const wsSend = (ws, obj) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

const escRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

wss.on('connection', (ws) => {
  let child = null, tmpFiles = [], tmpDirs = [], timer = null;

  const cleanup = () => {
    if (timer)  { clearTimeout(timer); timer = null; }
    if (child)  { try { child.kill(); } catch {} child = null; }
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    tmpDirs.forEach(d  => { try { fs.rmSync(d, { recursive: true }); } catch {} });
    tmpFiles = []; tmpDirs = [];
  };

  // Start a compiled/interpreted process and wire up I/O
  const startProcess = (cmd, args, onDone) => {
    child = spawn(cmd, args, { windowsHide: true });
    wsSend(ws, { type: 'started' });

    child.stdout.on('data', d => wsSend(ws, { type: 'stdout', data: d.toString() }));
    child.stderr.on('data', d => wsSend(ws, { type: 'stderr', data: d.toString() }));

    timer = setTimeout(() => {
      wsSend(ws, { type: 'timeout' });
      cleanup();
    }, 30000);

    child.on('close', code => {
      clearTimeout(timer); timer = null;
      wsSend(ws, { type: 'done', code });
      child = null;
      if (onDone) onDone();
      cleanup();
    });

    child.on('error', e => {
      clearTimeout(timer); timer = null;
      wsSend(ws, { type: 'error', data: e.message });
      cleanup();
    });
  };

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── RUN ──────────────────────────────────────────────────────────
    if (msg.type === 'run') {
      cleanup();
      const lang = msg.lang || 'c';
      const id   = crypto.randomBytes(6).toString('hex');
      const tmp  = os.tmpdir();
      const code = msg.code || '';

      // ── C ────────────────────────────────────────────────────────
      if (lang === 'c') {
        const src = path.join(tmp, `c_${id}.c`);
        const out = isWin ? path.join(tmp, `c_${id}.exe`) : path.join(tmp, `c_${id}`);
        tmpFiles = [src, out];

        const patched = code.replace(
          /(int\s+main\s*\([^)]*\)\s*\{)/,
          '$1\nsetvbuf(stdout,NULL,_IONBF,0);setvbuf(stderr,NULL,_IONBF,0);\n'
        );
        fs.writeFileSync(src, patched, 'utf8');

        exec(`gcc "${src}" -o "${out}" -lm -w`, { timeout: 15000 }, (err, _o, se) => {
          if (err) {
            wsSend(ws, { type: 'compile_error', data: (se||err.message).replace(new RegExp(escRe(src),'g'),'main.c').trim() });
            cleanup(); return;
          }
          startProcess(out, []);
        });
      }

      // ── C++ ──────────────────────────────────────────────────────
      else if (lang === 'cpp') {
        const src = path.join(tmp, `cpp_${id}.cpp`);
        const out = isWin ? path.join(tmp, `cpp_${id}.exe`) : path.join(tmp, `cpp_${id}`);
        tmpFiles = [src, out];

        const patched = code.replace(
          /(int\s+main\s*\([^)]*\)\s*\{)/,
          '$1\nstd::cout.setf(std::ios::unitbuf);\nstd::cerr.setf(std::ios::unitbuf);\n'
        );
        fs.writeFileSync(src, patched, 'utf8');

        exec(`g++ "${src}" -o "${out}" -std=c++17 -lm -w`, { timeout: 15000 }, (err, _o, se) => {
          if (err) {
            wsSend(ws, { type: 'compile_error', data: (se||err.message).replace(new RegExp(escRe(src),'g'),'main.cpp').trim() });
            cleanup(); return;
          }
          startProcess(out, []);
        });
      }

      // ── Java ─────────────────────────────────────────────────────
      else if (lang === 'java') {
        // Java filename MUST match class name — we always use Main
        const dir = path.join(tmp, `java_${id}`);
        fs.mkdirSync(dir, { recursive: true });
        const src = path.join(dir, 'Main.java');
        tmpDirs = [dir];

        // Rename any public class to Main so it compiles
        const patched = code.replace(/public\s+class\s+\w+/, 'public class Main');
        fs.writeFileSync(src, patched, 'utf8');

        exec(`javac "${src}"`, { timeout: 15000 }, (err, _o, se) => {
          if (err) {
            const clean = (se||err.message)
              .replace(new RegExp(escRe(src),'g'), 'Main.java')
              .replace(new RegExp(escRe(dir) + '[/\\\\]?','g'), '');
            wsSend(ws, { type: 'compile_error', data: clean.trim() });
            cleanup(); return;
          }
          // Run: java -cp <dir> Main
          startProcess('java', ['-cp', dir, 'Main']);
        });
      }

      // ── Python ───────────────────────────────────────────────────
      else if (lang === 'python') {
        const src = path.join(tmp, `py_${id}.py`);
        tmpFiles = [src];
        fs.writeFileSync(src, code, 'utf8');
        // -u = unbuffered so print() appears immediately
        startProcess('python3', ['-u', src]);
      }
    }

    // ── STDIN ────────────────────────────────────────────────────────
    if (msg.type === 'stdin' && child && child.stdin.writable) {
      child.stdin.write(msg.data);
    }

    // ── KILL ─────────────────────────────────────────────────────────
    if (msg.type === 'kill') {
      cleanup();
      wsSend(ws, { type: 'done', code: -1 });
    }
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Acubens Compiler Backend               │`);
  console.log(`  │  http://localhost:${PORT}                  │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
  exec('gcc --version',     (e,o)   => console.log('  GCC:   ', e ? '✗ NOT FOUND' : '✓ ' + o.split('\n')[0]));
  exec('g++ --version',     (e,o)   => console.log('  G++:   ', e ? '✗ NOT FOUND' : '✓ ' + o.split('\n')[0]));
  exec('java -version',     (e,_,s) => console.log('  Java:  ', e ? '✗ NOT FOUND' : '✓ ' + s.split('\n')[0]));
  exec('python3 --version', (e,o)   => console.log('  Python:', e ? '✗ NOT FOUND' : '✓ ' + o.trim()));
  console.log('  Node:  ✓', process.version, '\n');
});
