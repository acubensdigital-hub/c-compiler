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

// ── Allowed origins (only acubens.in can use this backend) ──
const ALLOWED_ORIGINS = [
  'https://acubens.in',
  'https://www.acubens.in',
  'http://localhost:5000',
  'http://127.0.0.1:5000'
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (health checks, Railway pings)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      return callback(null, true);
    }
    return callback(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST'],
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/',       (req, res) => res.send('Acubens Compiler Backend ✓'));
app.get('/health', (req, res) => res.json({ status: 'ok', node: process.version }));

const wsSend = (ws, obj) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

const escRe = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');


// ── Simple IP rate limiter (max 30 runs/min per IP) ─────
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const max = 30;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length > max;
}
// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateLimitMap.entries()) {
    const fresh = times.filter(t => now - t < 60000);
    if (fresh.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}, 5 * 60 * 1000);

wss.on('connection', (ws, req) => {
  // ── Block requests not from acubens.in ──────────────────
  const origin = req.headers.origin || '';
  const isAllowed = !origin ||
    ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  if (!isAllowed) {
    ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized origin' }));
    ws.close(1008, 'Unauthorized');
    console.log(`Blocked WS connection from: ${origin}`);
    return;
  }
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
    // ── Rate limit check ──────────────────────────────────
    if (msg.type === 'run') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (isRateLimited(ip)) {
        wsSend(ws, { type: 'error', data: '⚠ Rate limit exceeded. Please wait 1 minute.' });
        return;
      }
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
