'use strict';
/* Pokémon Degen server: static hosting + accounts + cloud saves + leaderboard + global chat.
   Zero dependencies (Node 18+). Data lives in DATA_DIR (default ./data). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';        // hosts like Render/Fly/Railway sit behind a proxy
const SAVES = path.join(DATA, 'saves');
fs.mkdirSync(SAVES, { recursive: true });

/* ---------- storage ---------- */
const META = path.join(DATA, 'accounts.json');
let db = { accounts: {}, sessions: {}, chat: [], chatId: 0 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(META, 'utf8'))); } catch (e) { /* first run */ }
let metaT = null;
function writeAtomic(file, text) { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
function flushMeta() { clearTimeout(metaT); metaT = null; try { writeAtomic(META, JSON.stringify(db)); } catch (e) { console.error('meta write failed', e.message); } }
function persist() { if (!metaT) metaT = setTimeout(flushMeta, 1500); }
const saveFile = u => path.join(SAVES, u + '.json');
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushMeta(); process.exit(0); });

/* ---------- helpers ---------- */
const U_OK = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'system', 'support', 'staff', 'root', 'null', 'undefined', 'degen', 'anthropic', 'claude']);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const num = (v, max = 1e18) => { v = +v; return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0; };
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n);
const today = () => new Date().toISOString().slice(0, 10);
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + ms }; hits.set(key, h); }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); for (const t in db.sessions) if (db.sessions[t].exp < now) delete db.sessions[t]; }, 60000).unref();

function ipOf(req) {
  if (TRUST_PROXY) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || 'x';
}
function readBody(req, limit) {
  return new Promise((res, rej) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > limit) { rej(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { rej(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
    req.on('error', rej);
  });
}
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra));
  res.end(body);
}
const fail = (status, error) => Object.assign(new Error(error), { status });
function authOf(req, body) {
  const h = req.headers.authorization || '', tok = h.startsWith('Bearer ') ? h.slice(7) : (body && body.tok);
  if (!tok || typeof tok !== 'string') throw fail(401, 'Please log in.');
  const s = db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) throw fail(401, 'Your session expired. Please log in again.');
  if (!db.accounts[s.u]) throw fail(401, 'Account not found.');
  return { u: s.u, a: db.accounts[s.u], tok };
}
function newSession(u) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(tok)] = { u, exp: Date.now() + 90 * 864e5 }; persist(); return tok;
}
function cleanPub(p, a) {
  p = p && typeof p === 'object' ? p : {};
  return { n: str(p.n, 18) || a.name, av: Math.floor(num(p.av, 200)), xp: num(p.xp), vip: Math.floor(num(p.vip, 11)), nw: num(p.nw), cv: num(p.cv),
    pull: num(p.pull), wk: num(p.wk), wkKey: str(p.wkKey, 12), mo: num(p.mo), moKey: str(p.moKey, 12), cards: Math.floor(num(p.cards, 1e7)), t: Date.now() };
}
function writeSave(u, a, body) {
  const json = body.json;
  if (typeof json !== 'string' || json.length > 3e6) throw fail(400, 'Bad save.');
  let o; try { o = JSON.parse(json); } catch (e) { throw fail(400, 'Bad save.'); }
  if (!o || typeof o !== 'object' || !Array.isArray(o.cards)) throw fail(400, 'Bad save.');
  const rev = Math.floor(num(o.rev, 1e12));
  // never let a stale device roll an account backwards
  if (a.rev && rev < a.rev) throw fail(409, 'This account was updated on another device. Reload to continue.');
  writeAtomic(saveFile(u), json);
  a.rev = rev; a.pub = cleanPub(body.pub, a); persist();
}

/* ---------- API ---------- */
const routes = {
  'POST /api/register': async (req, res, ip) => {
    if (limited('reg:' + ip, 8, 3600e3)) throw fail(429, 'Too many accounts from this network. Try later.');
    const b = await readBody(req, 4096), u = str(b.u, 40).trim(), p = typeof b.p === 'string' ? b.p : '';
    if (!U_OK.test(u)) throw fail(400, 'Username: 3 to 16 letters, numbers or underscores.');
    if (RESERVED.has(u.toLowerCase())) throw fail(400, 'That username is reserved.');
    if (p.length < 6 || p.length > 128) throw fail(400, 'Password must be 6 to 128 characters.');
    const k = u.toLowerCase();
    if (db.accounts[k]) throw fail(409, 'That username is taken. Try another.');
    const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(p, salt, 64)).toString('hex');
    if (db.accounts[k]) throw fail(409, 'That username is taken. Try another.');
    db.accounts[k] = { name: u, salt, hash, created: Date.now(), daily: '', rev: 0, pub: null };
    const token = newSession(k); persist();
    send(res, 200, { token, u: k, name: u, isNew: true });
  },
  'POST /api/login': async (req, res, ip) => {
    if (limited('log:' + ip, 20, 600e3)) throw fail(429, 'Too many attempts. Wait a few minutes.');
    const b = await readBody(req, 4096), k = str(b.u, 40).trim().toLowerCase(), p = typeof b.p === 'string' ? b.p : '';
    if (limited('logu:' + k, 10, 600e3)) throw fail(429, 'Too many attempts on this account. Wait a few minutes.');
    const a = db.accounts[k];
    const salt = a ? a.salt : '00000000000000000000000000000000';
    const h = (await scrypt(p.slice(0, 128), salt, 64));
    if (!a || !crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'))) throw fail(401, 'Wrong username or password.');
    send(res, 200, { token: newSession(k), u: k, name: a.name });
  },
  'POST /api/logout': async (req, res) => {
    const { tok } = authOf(req); delete db.sessions[sha(tok)]; persist(); send(res, 200, { ok: 1 });
  },
  'GET /api/me': async (req, res) => {
    const { u, a } = authOf(req); send(res, 200, { u, name: a.name });
  },
  'GET /api/save': async (req, res) => {
    const { u, a } = authOf(req); let json = null;
    try { json = fs.readFileSync(saveFile(u), 'utf8'); } catch (e) { /* new account */ }
    send(res, 200, { json, rev: a.rev || 0, daily: a.daily || '' });
  },
  'PUT /api/save': async (req, res) => {
    const b = await readBody(req, 4e6), { u, a } = authOf(req, b);
    if (limited('sv:' + u, 60, 60e3)) throw fail(429, 'Saving too fast.');
    writeSave(u, a, b); send(res, 200, { ok: 1, rev: a.rev });
  },
  'POST /api/beacon': async (req, res) => {          // navigator.sendBeacon on page close (token in body)
    const b = await readBody(req, 4e6), { u, a } = authOf(req, b);
    try { writeSave(u, a, b); } catch (e) { /* ignore */ }
    res.writeHead(204); res.end();
  },
  // The daily bonus is decided here so logging out/in, clearing storage or resetting can never reopen it.
  'POST /api/daily': async (req, res) => {
    const b = await readBody(req, 512), { u, a } = authOf(req, b), day = str(b.day, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(day)) throw fail(400, 'Bad day.');
    const srv = Date.parse(today()), cli = Date.parse(day);
    if (!(Math.abs(srv - cli) <= 864e5)) throw fail(400, 'Your device clock is off. Fix it and try again.');
    if (a.daily && day <= a.daily) return send(res, 200, { ok: false, daily: a.daily });
    a.daily = day; persist(); send(res, 200, { ok: true, daily: day });
  },
  'GET /api/players': async (req, res) => {
    authOf(req);
    const rows = [];
    for (const k in db.accounts) { const p = db.accounts[k].pub; if (p) rows.push(Object.assign({ id: k }, p)); }
    rows.sort((x, y) => y.nw - x.nw);
    send(res, 200, { players: rows.slice(0, 300) });
  },
  'GET /api/chat': async (req, res) => {
    authOf(req);
    const since = +new URL(req.url, 'http://x').searchParams.get('since') || 0;
    send(res, 200, { msgs: db.chat.filter(m => m.id > since).slice(-60) });
  },
  'POST /api/chat': async (req, res) => {
    const b = await readBody(req, 2048), { u, a } = authOf(req, b);
    if (limited('chat:' + u, 8, 15e3)) throw fail(429, 'Slow down, goblin.');
    const x = str(b.x, 140).trim(); if (!x) throw fail(400, 'Empty message.');
    const p = a.pub || {};
    const m = { id: ++db.chatId, u, n: p.n || a.name, av: p.av || 0, x, t: Date.now() };
    db.chat.push(m); if (db.chat.length > 150) db.chat.splice(0, db.chat.length - 150); persist();
    send(res, 200, { ok: 1, id: m.id });
  },
  'GET /api/health': async (req, res) => send(res, 200, { ok: 1, players: Object.keys(db.accounts).length })
};


/* ---------- blackjack online tables (server is the dealer) ---------- */
const BJ_DEFS = [
  { id: 'pit', name: 'Pikachu Pit', min: 10, max: 10000 },
  { id: 'lounge', name: 'Charizard Lounge', min: 1000, max: 1000000 },
  { id: 'vault', name: 'Mewtwo High Roller', min: 50000, max: 50000000 }
];
const bjV = h => { let t = 0, a = 0; for (const k of h) { const r = k % 13; if (r === 0) { a++; t += 11; } else t += r >= 9 ? 10 : r + 1; } while (t > 21 && a > 0) { t -= 10; a--; } return t; };
const bjC = () => crypto.randomInt(52);
const bjT = {};
for (const d of BJ_DEFS) bjT[d.id] = Object.assign({ seats: Array(5).fill(null), phase: 'idle', dl: 0, ver: 1, round: 0, dealer: [], open: false, turn: -1 }, d);
const bjPlaying = t => t.seats.filter(s => s && s.bet > 0 && s.cards.length);
function bjPhase(t, p, ms) { t.phase = p; t.dl = Date.now() + ms; t.ver++; }
function bjDeal(t) {
  t.round++; t.dealer = [bjC(), bjC()]; t.open = false; t.turn = -1;
  let n = 0;
  for (const s of t.seats) if (s) { s.res = null; s.dbl = false; s.nat = false; if (s.bet > 0) { s.cards = [bjC(), bjC()]; s.st = 'play'; n++; } else { s.cards = []; s.st = 'wait'; } }
  bjPhase(t, 'deal', (n + 1) * 2 * 430 + 700);
}
function bjStartPlay(t) {
  const up = t.dealer[0] % 13, peek = up === 0 || up >= 9;
  for (const s of bjPlaying(t)) if (bjV(s.cards) === 21) { s.nat = true; s.st = 'bj'; }
  if (peek && bjV(t.dealer) === 21) { t.open = true; return bjSettle(t); }
  bjNext(t, -1);
}
function bjNext(t, from) {
  for (let i = from + 1; i < t.seats.length; i++) { const s = t.seats[i]; if (s && s.bet > 0 && s.st === 'play') { t.turn = i; return bjPhase(t, 'play', 15000); } }
  t.turn = -1; t.open = true;
  if (!bjPlaying(t).some(s => s.st === 'stand')) return bjSettle(t);
  bjPhase(t, 'dealer', 900);
}
function bjDealerStep(t) { if (bjV(t.dealer) < 17) { t.dealer.push(bjC()); return bjPhase(t, 'dealer', 900); } bjSettle(t); }
function bjSettle(t) {
  const dv = bjV(t.dealer), dbj = t.dealer.length === 2 && dv === 21;
  for (const s of bjPlaying(t)) {
    const pv = bjV(s.cards), stake = s.bet * (s.dbl ? 2 : 1); let r, pm;
    if (s.st === 'bust') { r = 'bust'; pm = 0; }
    else if (s.nat) { if (dbj) { r = 'push'; pm = 1; } else { r = 'bj'; pm = 2.5; } }
    else if (dbj) { r = 'lose'; pm = 0; }
    else if (dv > 21 || pv > dv) { r = 'win'; pm = 2; }
    else if (pv < dv) { r = 'lose'; pm = 0; }
    else { r = 'push'; pm = 1; }
    s.res = { r, pm, stake, pv, dv, dbl: s.dbl, round: t.round };
  }
  t.turn = -1; t.open = true; bjPhase(t, 'pay', 7000);
}
function bjNewRound(t) {
  const now = Date.now();
  t.seats.forEach((s, i) => {
    if (!s) return;
    if (s.res) s.lr = s.res;
    if (s.left || now - s.last > 25000) { t.seats[i] = null; return; }
    s.bet = 0; s.cards = []; s.res = null; s.dbl = false; s.nat = false; s.st = 'wait';
  });
  t.dealer = []; t.open = false; t.turn = -1;
  if (t.seats.some(Boolean)) bjPhase(t, 'bet', 14000); else bjPhase(t, 'idle', 0);
}
function bjTick() {
  const now = Date.now();
  for (const id in bjT) {
    const t = bjT[id], active = ['deal', 'play', 'dealer'].includes(t.phase);
    t.seats.forEach((s, i) => { if (s && now - s.last > 25000 && !(active && s.bet > 0)) { t.seats[i] = null; t.ver++; } });
    if (!t.seats.some(Boolean)) { if (t.phase !== 'idle') { t.dealer = []; t.round = t.round; bjPhase(t, 'idle', 0); } continue; }
    if (t.phase === 'bet') {
      const seated = t.seats.filter(Boolean), bettors = seated.filter(s => s.bet > 0);
      if (bettors.length === seated.length && t.dl - now > 2000) { t.dl = now + 2000; t.ver++; }
      if (now >= t.dl) { if (!bettors.length) bjNewRound(t); else bjDeal(t); }
    } else if (t.phase === 'deal') { if (now >= t.dl) bjStartPlay(t); }
    else if (t.phase === 'play') { const s = t.seats[t.turn]; if (!s) bjNext(t, t.turn); else if (now >= t.dl || s.left) { s.st = 'stand'; bjNext(t, t.turn); } }
    else if (t.phase === 'dealer') { if (now >= t.dl) bjDealerStep(t); }
    else if (t.phase === 'pay') { if (now >= t.dl) bjNewRound(t); }
  }
}
setInterval(bjTick, 400).unref();
function bjView(t, u, a) {
  const hide = !t.open && (t.phase === 'deal' || t.phase === 'play');
  const dealer = hide ? [t.dealer[0], -1] : t.dealer.slice();
  let me = -1;
  const seats = t.seats.map((s, i) => { if (!s) return null; if (s.u === u) { me = i; s.last = Date.now(); }
    return { n: s.name, bet: s.bet, cards: s.cards, dbl: s.dbl, st: s.st, res: s.res, lr: s.lr || null }; });
  return { ver: t.ver, now: Date.now(), phase: t.phase, dl: t.dl, round: t.round, min: t.min, max: t.max, name: t.name, turn: t.turn, me, dealer: t.dealer.length ? dealer : [], seats };
}
routes['GET /api/bj/tables'] = async (req, res) => {
  authOf(req);
  send(res, 200, { tables: BJ_DEFS.map(d => { const t = bjT[d.id]; return { id: d.id, name: d.name, min: d.min, max: d.max, players: t.seats.filter(Boolean).length, phase: t.phase }; }) });
};
routes['GET /api/bj/state'] = async (req, res) => {
  const { u } = authOf(req), q = new URL(req.url, 'http://x').searchParams, t = bjT[q.get('t')];
  if (!t) throw fail(404, 'No such table.');
  const v = bjView(t, u);
  if (v.me >= 0 && +q.get('v') === t.ver) return send(res, 200, { same: 1, now: v.now, me: v.me });
  send(res, 200, v);
};
routes['POST /api/bj/act'] = async (req, res) => {
  const b = await readBody(req, 1024), { u, a } = authOf(req, b);
  if (limited('bj:' + u, 240, 60e3)) throw fail(429, 'Slow down.');
  const t = bjT[b.t]; if (!t) throw fail(404, 'No such table.');
  const i = t.seats.findIndex(x => x && x.u === u), s = i >= 0 ? t.seats[i] : null, now = Date.now();
  switch (b.a) {
    case 'sit': {
      if (s) { s.last = now; break; }
      for (const o of Object.values(bjT)) o.seats.forEach((x, k) => { if (x && x.u === u && !(x.bet > 0 && ['deal', 'play', 'dealer'].includes(o.phase))) { o.seats[k] = null; o.ver++; } });
      const k = t.seats.indexOf(null); if (k < 0) throw fail(409, 'That table is full.');
      const p = a.pub || {};
      t.seats[k] = { u, name: p.n || a.name, bet: 0, cards: [], dbl: false, nat: false, st: 'wait', res: null, lr: null, last: now }; t.ver++; break;
    }
    case 'leave': {
      if (!s) break;
      if (s.bet > 0 && ['deal', 'play', 'dealer'].includes(t.phase)) { s.left = true; s.last = 0; }
      else t.seats[i] = null;
      t.ver++; break;
    }
    case 'bet': {
      if (!s) throw fail(409, 'Take a seat first.');
      if (!['idle', 'bet'].includes(t.phase)) throw fail(409, 'Betting is closed. Wait for the next round.');
      const amt = Math.floor(num(b.amt, 1e12));
      if (s.bet > 0) throw fail(409, 'You already bet this round.');
      if (amt < t.min || amt > t.max) throw fail(400, 'This table takes bets from ' + t.min + ' to ' + t.max + '.');
      s.bet = amt; s.last = now;
      if (t.phase === 'idle') bjPhase(t, 'bet', 10000); else t.ver++;
      break;
    }
    case 'hit': case 'stand': case 'double': {
      if (!s || t.phase !== 'play' || t.turn !== i || s.st !== 'play') throw fail(409, 'Not your turn.');
      s.last = now;
      if (b.a === 'stand') s.st = 'stand';
      else {
        if (b.a === 'double') { if (s.cards.length !== 2) throw fail(409, 'You can only double on two cards.'); s.dbl = true; }
        s.cards.push(bjC()); const v = bjV(s.cards);
        if (v > 21) s.st = 'bust'; else if (v === 21 || b.a === 'double') s.st = 'stand';
      }
      if (s.st === 'play') bjPhase(t, 'play', 15000); else bjNext(t, i);
      break;
    }
    default: throw fail(400, 'Bad action.');
  }
  send(res, 200, { ok: 1 });
};

/* ---------- static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const cache = {};
function staticFile(name) {
  const f = path.join(PUBLIC, name);
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return null;
  const st = fs.statSync(f);
  if (!cache[name] || cache[name].m !== st.mtimeMs) { const raw = fs.readFileSync(f); cache[name] = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 9 }), type: MIME[path.extname(f)] || 'application/octet-stream' }; }
  return cache[name];
}
const SEC = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), key = req.method + ' ' + url.pathname;
  try {
    if (url.pathname.startsWith('/api/')) {
      const h = routes[key]; if (!h) throw fail(404, 'Not found.');
      return await h(req, res, ipOf(req));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const f = staticFile(name) || (name.indexOf('.') < 0 ? staticFile('index.html') : null);
    if (!f) throw fail(404, 'Not found.');
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const headers = Object.assign({ 'content-type': f.type, 'cache-control': f.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=86400', vary: 'accept-encoding' }, SEC);
    if (gz) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : (gz ? f.gz : f.raw));
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
  }
});
server.listen(PORT, () => console.log('Pokémon Degen running on port ' + PORT + ' · data in ' + DATA));
