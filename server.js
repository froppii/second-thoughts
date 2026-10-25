const express = require('express'), http = require('http'), { WebSocketServer } = require('ws');
const claude = require('./claude');
const app = express();
app.use(express.static('public'));
const server = http.createServer(app), wss = new WebSocketServer({ server });

const rooms = {}, B = 40, BUY = 10, START = 100, MAX = 6; // LMSR liquidity, chips per tap, starting chips, max options
const uid = n => Math.random().toString(36).slice(2, 2 + n);
const roomCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); // no 0/O or 1/I mixups
const send = (ws, m) => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
const prices = r => { const e = r.q.map(x => Math.exp(x / B)), s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
const norm = a => { const t = a.reduce((x, y) => x + y, 0) || 1; return a.map(v => v / t); };
const avg = (votes, n) => { const vs = Object.values(votes); return vs.length ? Array.from({ length: n }, (_, i) => vs.reduce((t, v) => t + v[i], 0) / vs.length) : Array(n).fill(1 / n); };
const same = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// Silly stuff: a handicap for every pitcher, and a chaos card that bends the wheel before the spin
const RULES = ['Pitch in a pirate voice', 'Whisper the whole time', 'Never say the word "the"', 'Be a sports commentator', 'Speak only in questions', 'Narrate like a nature documentary', 'Sell it like an infomercial at 3am', 'Start every sentence with "Honestly"', 'Pitch while pretending to be very sleepy', 'Talk like a movie trailer'];
const big = w => w.indexOf(Math.max(...w));
const CARDS = [
  { name: 'Underdog Uprising', text: 'Small slices grow. The wheel is half flattened.', f: w => w.map(x => x * 0.5 + 0.5 / w.length) },
  { name: 'Favorite Tax', text: 'The biggest slice is cut in half.', f: w => w.map((x, i) => i === big(w) ? x / 2 : x) },
  { name: 'Double or Nothing', text: 'The biggest slice doubles.', f: w => w.map((x, i) => i === big(w) ? x * 2 : x) },
  { name: 'Pure Chaos', text: 'Every slice is equal. Good luck.', f: w => w.map(() => 1 / w.length) },
  { name: 'No Card Today', text: 'The wheel is untouched. Boring, but fair.', f: w => w },
];

// LMSR: spend BUY chips on option i, get s shares (each pays 1 chip if i wins the spin)
function buy(r, p, i) {
  if (!p || p.chips < BUY || !(i >= 0 && i < r.q.length)) return;
  const e = r.q.map(x => Math.exp(x / B)), S = e.reduce((a, b) => a + b, 0);
  const s = B * Math.log((S * (Math.exp(BUY / B) - 1) + e[i]) / e[i]);
  r.q[i] += s; p.chips -= BUY; p.shares[i] += s;
}

function view(r) {
  return {
    code: r.code, phase: r.phase, question: r.question, options: r.options, prices: prices(r), note: r.note || null,
    players: Object.values(r.players).map(p => ({ id: p.id, name: p.name, entry: p.entry || '', option: p.option ?? -1, chips: p.chips, shares: p.shares, voted: p.id in (r.phase === 'vote2' ? r.v2 : r.v1) })),
    pitches: r.pitches, slot: r.slot, left: r.left, slotLeft: r.slotLeft, result: r.result, comment1: r.comment1, comment2: r.comment2, pending: !!r.pending,
  };
}
function push(r) {
  const state = view(r);
  send(r.host, { type: 'state', state });
  Object.values(r.players).forEach(p => send(p.ws, { type: 'state', state }));
}

// Lobby -> round 1. Each player's entry becomes an option; Claude fills in if the room was shy.
async function start(r) {
  if (r.starting || !Object.keys(r.players).length) return;
  r.starting = true;
  const opts = [], add = o => { o = String(o).trim().slice(0, 30); if (o && opts.length < MAX && !opts.some(x => same(x) === same(o))) opts.push(o); };
  Object.values(r.players).forEach(p => p.entry && add(p.entry));
  if (opts.length < 2) {
    r.note = 'Not enough entries. Claude is adding a few...'; push(r);
    const out = await claude.buildOptions(r.question, opts);
    if (out) out.options.forEach(add);
  }
  if (opts.length < 2) ['Do it', 'Skip it'].forEach(add);
  r.options = opts; r.q = opts.map(() => 0); r.note = null;
  Object.values(r.players).forEach(p => { p.shares = opts.map(() => 0); p.option = p.entry ? opts.findIndex(o => same(o) === same(p.entry)) : -1; });
  r.phase = 'vote1'; r.starting = false;
  claude.handicaps(r.question, r.options, Object.keys(r.players).length).then(l => { if (l) r.rules = l; }); // ready long before the pitch round
  push(r);
}

function compute(r) {
  const n = r.options.length, s1 = avg(r.v1, n), s2 = avg(r.v2, n), px = prices(r);
  const blend = s2.map((x, i) => (x + px[i]) / 2); // sliders + market price
  const card = CARDS[Math.floor(Math.random() * CARDS.length)], w = norm(card.f(blend));
  let t = Math.random(), winner = n - 1;
  for (let i = 0; i < n; i++) { if (t < w[i]) { winner = i; break; } t -= w[i]; }
  return {
    w, s1, s2, px, winner, card: { name: card.name, text: card.text },
    upset: winner !== blend.indexOf(Math.max(...blend)),
    board: Object.values(r.players).map(p => ({ id: p.id, name: p.name, net: Math.round(p.chips + p.shares[winner] - START) })).sort((a, b) => b.net - a.net),
    persuasion: r.pitches.map(p => ({ name: p.name, option: p.option, delta: (p.end ?? px[p.option]) - (p.start ?? px[p.option]) })).sort((a, b) => b.delta - a.delta),
  };
}

// Market runs on a server clock; players pitch in rotating slots while prices move live
function tick(r) {
  const el = Math.floor((Date.now() - r.t0) / 1000), slot = Math.floor(el / r.slotLen), pr = prices(r);
  if (slot !== r.slot) {
    const old = r.pitches[r.slot]; if (old) old.end = pr[old.option];
    const nw = r.pitches[slot]; if (nw) nw.start = pr[nw.option];
    r.slot = slot;
  }
  r.left = Math.max(0, r.total - el); r.slotLeft = r.slotLen - (el % r.slotLen);
  if (el >= r.total) advance(r); else push(r);
}
function advance(r) {
  const P = Object.values(r.players), n = r.options.length;
  if (r.phase === 'lobby') return start(r);
  if (r.phase === 'vote1') {
    r.q = avg(r.v1, n).map(p => B * Math.log(Math.max(p, 0.02))); // market opens at round-1 confidence
    r.phase = 'market';
    const pool = (r.rules && r.rules.length >= 3) ? r.rules : RULES;
    r.pitches = P.sort(() => Math.random() - 0.5).map((p, i) => ({ id: p.id, name: p.name, option: p.option >= 0 ? p.option : i % n, rule: pool[Math.floor(Math.random() * pool.length)] }));
    r.slotLen = Math.max(8, Math.min(20, Math.floor(60 / P.length))); r.total = r.slotLen * P.length;
    r.t0 = Date.now(); r.slot = -1; r.iv = setInterval(() => tick(r), 1000); tick(r);
    claude.opening({ question: r.question, options: r.options, round1ConfidencePct: avg(r.v1, n).map(x => Math.round(x * 100)), players: P.length })
      .then(t => { if (t) { r.comment1 = t; push(r); } });
    return;
  } else if (r.phase === 'market') { clearInterval(r.iv); const old = r.pitches[r.slot]; if (old && old.end == null) old.end = prices(r)[old.option]; r.phase = 'vote2'; }
  else if (r.phase === 'vote2') {
    r.phase = 'spin'; r.result = compute(r); r.pending = true;
    const R = r.result, pc = a => a.map(x => Math.round(x * 100));
    claude.report({
      question: r.question, options: r.options, winner: r.options[R.winner], upset: R.upset, chaosCard: R.card.name,
      round1Pct: pc(R.s1), round2Pct: pc(R.s2), marketPricePct: pc(R.px), finalWheelPct: pc(R.w),
      persuasion: R.persuasion.map(p => ({ player: p.name, pitched: r.options[p.option], priceChangePts: Math.round(p.delta * 100) })),
      chipBoard: R.board.map(b => ({ player: b.name, net: b.net })),
    }).then(t => { r.pending = false; if (t) r.comment2 = t; push(r); });
  }
  else if (r.phase === 'spin') r.phase = 'results';
  push(r);
}

wss.on('connection', ws => {
  let room, me;
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    const code = String(m.code || '').toUpperCase().trim();
    if (m.type === 'create') {
      const question = String(m.question || '').trim().slice(0, 80);
      if (!question) return send(ws, { type: 'error', msg: 'Tell us what you are deciding first.' });
      let c; do c = roomCode(); while (rooms[c]);
      room = rooms[c] = { code: c, host: ws, hostKey: uid(10), created: Date.now(), phase: 'lobby', question, options: [], q: [], players: {}, v1: {}, v2: {}, pitches: [], slot: -1, result: null };
      send(ws, { type: 'hosting', code: c, key: room.hostKey }); push(room);
    } else if (m.type === 'rehost') {
      const r = rooms[code];
      if (!r || r.hostKey !== m.key) return send(ws, { type: 'error', msg: null });
      room = r; r.host = ws; send(ws, { type: 'hosting', code, key: r.hostKey }); push(r);
    } else if (m.type === 'join') {
      const r = rooms[code], name = String(m.name || '').trim().slice(0, 12);
      if (!r || r.phase !== 'lobby' || r.starting) return send(ws, { type: 'error', msg: 'No open room with that code.' });
      if (!name) return send(ws, { type: 'error', msg: 'Add your name.' });
      if (Object.keys(r.players).length >= 12) return send(ws, { type: 'error', msg: 'That room is full.' });
      room = r; me = uid(6);
      r.players[me] = { id: me, name, entry: '', option: -1, ws, chips: START, shares: [] };
      send(ws, { type: 'joined', id: me, code }); push(r);
    } else if (m.type === 'rejoin') {
      const r = rooms[code], p = r && r.players[m.id];
      if (!p) return send(ws, { type: 'error', msg: null });
      room = r; me = m.id; p.ws = ws; send(ws, { type: 'joined', id: me, code }); push(r);
    } else if (m.type === 'entry' && room && me && room.phase === 'lobby' && !room.starting) {
      room.players[me].entry = String(m.text || '').trim().slice(0, 30); push(room);
    } else if (m.type === 'vote' && room && me && (room.phase === 'vote1' || room.phase === 'vote2') && Array.isArray(m.conf)) {
      room[room.phase === 'vote1' ? 'v1' : 'v2'][me] = norm(room.options.map((_, i) => Math.max(0, Number(m.conf[i]) || 0))); push(room);
    } else if (m.type === 'buy' && room && me && room.phase === 'market') {
      buy(room, room.players[me], Number(m.option)); push(room);
    } else if (m.type === 'next' && room && ws === room.host) advance(room);
  });
  ws.on('close', () => { // someone who leaves the lobby disappears from it; mid-game they can rejoin
    const r = room, id = me;
    setTimeout(() => { // short grace period so a phone refresh doesn't kick you out
      const p = r && id && r.players[id];
      if (p && p.ws === ws && r.phase === 'lobby' && !r.starting) { delete r.players[id]; push(r); }
    }, 8000);
  });
});

setInterval(() => { for (const c in rooms) if (Date.now() - rooms[c].created > 3 * 3600e3) { clearInterval(rooms[c].iv); delete rooms[c]; } }, 600e3);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Second Thoughts on http://localhost:${PORT}`));