// Second Thoughts client: one page for the host screen and every phone.
// All game state comes straight from SpacetimeDB subscriptions; actions are reducer calls.
import { DbConnection, tables } from './module_bindings/index.ts';

const CFG = window.STDB || { uri: `ws://${location.hostname}:3000`, db: 'second-thoughts' };
const $ = id => document.getElementById(id), app = $('app');
const HL = ['var(--h1)', 'var(--h2)', 'var(--h3)', 'var(--h4)', 'var(--h5)', 'var(--h6)'];
const HLHEX = ['#ffd84d', '#8fd3ff', '#ff9e9e', '#9becc0', '#cdb3ff', '#ffc58f'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const sum = a => a.reduce((x, y) => x + y, 0);
const lmsr = q => { const e = q.map(x => Math.exp(x / 40)), s = sum(e) || 1; return e.map(x => x / s); };
// per-tab storage: each tab gets its own identity (handy for testing), and a refresh keeps it
const ss = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} } };
const TOKEN = `st:${CFG.uri}/${CFG.db}:token`;

const SPLASHES = ['i cant make decisions :(', 'now with second thoughts!', 'trust the market!', 'not financial advice!', 'pirate voice mandatory!', 'ding ding ding!', 'democracy, but with chips!', 'made at calhacks!', 'have you considered tacos?', 'the favorite usually wins!', 'also try: flipping a coin!', 'claude is watching!', 'tap tap tap tap!', 'buy high, sell never!'];
let splash = Math.random() < 0.35 ? SPLASHES[0] : SPLASHES[Math.floor(Math.random() * SPLASHES.length)];

// a join link (from the lobby QR) fills in the room code for you
const linkCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (linkCode) history.replaceState(null, '', location.pathname);

let me = null, online = false, ready = false, code = linkCode ? null : ss.get('code'), screen = linkCode ? 'join' : 'home', err = '', key = '', busy = false;
let scoped = null, lastPhase = null, rang = false;

// ---------- SpacetimeDB ----------
const conn = DbConnection.builder()
  .withUri(CFG.uri).withDatabaseName(CFG.db).withToken(ss.get(TOKEN) || undefined).withAutomaticReconnect()
  .onConnect((_c, identity, token) => { ss.set(TOKEN, token); me = identity; online = true; paint(); })
  .onDisconnect(() => { online = false; paint(); })
  .onConnectError(() => { online = false; err = "can't reach the game server"; key = ''; paint(); })
  .build();
conn.subscriptionBuilder().onApplied(() => { ready = true; if (code) watch(code); paint(); }).subscribe([tables.room]);
for (const t of ['room', 'player', 'pricePoint', 'pitch', 'comment']) {
  conn.db[t].onInsert(paint); conn.db[t].onUpdate(paint); conn.db[t].onDelete(paint);
}

// once we know the room, subscribe to just that room's rows
function watch(c) {
  if (scoped) { try { scoped.unsubscribe(); } catch {} scoped = null; }
  code = c; ss.set('code', c);
  if (!c) return;
  scoped = conn.subscriptionBuilder().onApplied(paint).subscribe([
    tables.player.where(r => r.room.eq(c)),
    tables.pricePoint.where(r => r.room.eq(c)),
    tables.pitch.where(r => r.room.eq(c)),
    tables.comment.where(r => r.room.eq(c)),
  ]);
}

let raf = 0;
function paint() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

// everything the screens need, read from the local cache
function snapshot() {
  const r = code && conn.db.room.code.find(code);
  if (!r || !me) return null;
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  const players = [...conn.db.player.iter()].filter(p => p.room === code).sort(byId).map(p => ({
    id: String(p.id), raw: p, name: p.name, entry: p.entry, option: p.option, chips: p.chips, shares: p.shares, v1: p.v1, v2: p.v2, online: p.online,
    voted: r.phase === 'vote2' ? p.moved : sum(p.v1) > 0, mine: p.identity.isEqual(me),
  }));
  const points = [...conn.db.pricePoint.iter()].filter(p => p.room === code).sort((a, b) => a.idx - b.idx);
  const comments = [...conn.db.comment.iter()].filter(c => c.room === code).sort(byId);
  const latest = kind => { const c = comments.filter(c => c.kind === kind && c.playerId === 0n).pop(); return c ? c.text : null; };
  const r2 = points.findIndex(p => p.kind === 'r2');
  return {
    r, code, phase: r.phase, question: r.question, options: r.options, prices: r.q.length ? lmsr(r.q) : [],
    host: r.host.isEqual(me), players, P: players.find(p => p.mine),
    left: r.left, total: r.total, slot: r.slot,
    pitches: [...conn.db.pitch.iter()].filter(p => p.room === code).sort((a, b) => a.ord - b.ord),
    hist: points.filter(p => p.kind === 'm').map(p => p.prices),
    path: points.map(p => p.prices), marks: r2 >= 0 ? { open: 0, round2: r2, bell: r2 + 1 } : null,
    latest, feed: comments.filter(c => (c.kind === 'pitch' || c.kind === 'ticker' || c.kind === 'opening') && c.playerId === 0n).slice(-3).reverse().map(c => c.text),
    comments,
  };
}

// ---------- little builders ----------
const title = (size = '') => `<h1 class="title ${size}"><span>second</span><span>thoughts</span></h1>`;
const btn = (label, fn, cls = '') => `<button class="link next ${cls}" onclick="${fn}">${label} <span>↩</span></button>`;
const tail = `<svg width="22" height="20" viewBox="0 0 22 20"><path d="M3 0 C5 9 3 15 1 19 C8 15 14 8 18 0" fill="#fff" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/></svg>`;
const blob = (p, say, cls = '', pos = '') => `<div class="pl ${cls}" style="${pos}">${say != null ? `<div class="bubble sketch"><span>${esc(say)}</span>${tail}</div>` : ''}<div class="sq"><i class="eye"><b></b></i><i class="eye"><b></b></i></div><div class="nm">${esc(p.name)}</div></div>`;
const sticky = (label, text) => `<div class="sticky"><b>${esc(label)}</b>${esc(text)}</div>`;
const fuse = () => `<div class="fuse" id="fuse"><i></i></div>`;
const roomTag = (S, qr = false) => `<div class="room">${qr ? '<div class="qr sketch" id="qr" title="scan to join"></div>' : ''}<b>${esc(S.code)}</b><span>room code</span><small>${qr ? 'scan, or go to ' : 'join at '}${esc(location.host)}</small></div>`;
const field = (id, label, max, val = '') => `<label class="field"><span>${label}</span><input id="${id}" maxlength="${max}" autocomplete="off" autocapitalize="${id === 'code' ? 'characters' : 'off'}" spellcheck="false" value="${esc(val)}"><i class="rough-line"></i></label>`;
const form = (inner, action) => `<form class="stack" onsubmit="event.preventDefault();${action}">${inner}${err ? `<p class="err">${esc(err)}</p>` : ''}<button class="link next" ${busy ? 'disabled' : ''}>next <span>↩</span></button></form>`;
const split = (active, right) => `<main class="split"><section class="left">${title()}<nav><button class="link ${active === 'join' ? 'on' : ''}" onclick="go('join')">join room</button><button class="link ${active === 'create' ? 'on' : ''}" onclick="go('create')">create room</button></nav></section><div class="divider"></div><section class="right">${right}</section></main>`;
const clock = () => `<span class="clock" id="clock"></span>`;

function crowd(players, say, cls = () => '') {
  const cols = Math.min(6, Math.max(3, players.length)), rows = Math.ceil(players.length / cols) || 1;
  return `<div class="crowd" style="height:${rows * 190 + 110}px">${players.map((p, i) => {
    const h = hash(p.id), c = i % cols, r = Math.floor(i / cols);
    const x = (c + 0.15 + (h % 50) / 100) / cols * 100, y = 70 + r * 190 + (h >> 6) % 70;
    return blob(p, say(p), '' + cls(p), `left:calc(${x}% - 48px);top:${y}px`);
  }).join('')}</div>`;
}

// hand-drawn line chart: one marker line per option, value labels riding the line ends
function chart(S, series, { upto = series.length, len = series.length, w = 900, h = 320, marks = [], labels = true } = {}) {
  if (!series.length) return '';
  const L = Math.max(len - 1, 1), shown = series.slice(0, Math.max(1, upto)), last = shown[shown.length - 1];
  const top = Math.min(1, Math.ceil((Math.max(...series.flat()) + 0.06) * 10) / 10), step = top > 0.6 ? 0.25 : 0.1;
  const pl = 54, pr = labels ? Math.min(200, w * 0.3) : 14, pt = 16, pb = marks.length ? 40 : 14;
  const X = i => pl + i / L * (w - pl - pr), Y = v => pt + (1 - v / top) * (h - pt - pb);
  let g = '';
  for (let k = 0; k * step <= top + 1e-9; k++) { const v = k * step; g += `<line x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="${k ? '#e2e2e2' : '#111'}" stroke-width="${k ? 1.5 : 2.5}" ${k ? 'stroke-dasharray="5 7"' : ''}/><text x="${pl - 10}" y="${Y(v) + 6}" text-anchor="end" class="ax">${Math.round(v * 100)}¢</text>`; }
  marks.forEach(m => { const x = X(m.i); g += `<line x1="${x}" x2="${x}" y1="${pt}" y2="${h - pb}" stroke="#aaa" stroke-width="1.5" stroke-dasharray="3 6"/><text x="${x + (m.end ? -6 : 6)}" y="${h - 12}" text-anchor="${m.end ? 'end' : 'start'}" class="mk">${m.t}</text>`; });
  const order = S.options.map((_, i) => i).sort((a, b) => last[a] - last[b]); // leader drawn on top
  const lines = order.map(i => {
    const d = shown.map((p, k) => `${k ? 'L' : 'M'}${X(k).toFixed(1)} ${Y(p[i]).toFixed(1)}`).join('');
    return `<path d="${d}" stroke="#111" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" stroke="${HLHEX[i % 6]}" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const ex = X(shown.length - 1), dots = order.map(i => `<circle cx="${ex}" cy="${Y(last[i])}" r="7" fill="${HLHEX[i % 6]}" stroke="#111" stroke-width="2.5"/>`).join('');
  let lab = '';
  if (labels) { // nudge labels apart so they never overlap
    const ys = order.map(i => ({ i, y: Y(last[i]) })).sort((a, b) => a.y - b.y);
    ys.forEach((o, k) => { if (k && o.y - ys[k - 1].y < 26) o.y = ys[k - 1].y + 26; });
    const cap = w < 600 ? 9 : 13;
    lab = ys.map(o => { const t = S.options[o.i]; return `<text x="${ex + 16}" y="${o.y + 7}" class="lb">${esc(t.length > cap ? t.slice(0, cap - 1) + '…' : t)}${w < 600 ? '' : ` <tspan class="ax">${Math.round(last[o.i] * 100)}¢</tspan>`}</text>`; }).join('');
  }
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="price of each option over time">${g}<g filter="url(#rough)">${lines}</g>${dots}${lab}</svg>`;
}
const bellMarks = S => S.marks ? [{ i: S.marks.open, t: 'market opens' }, { i: S.marks.round2, t: 'round 2', end: true }, { i: S.marks.bell, t: 'closing bell' }] : [];

// googly eyes follow the pointer, and drift on their own when nobody's moving it
let mx = innerWidth / 2, my = innerHeight / 3, moved = 0;
function look() {
  document.querySelectorAll('.eye').forEach(e => {
    const r = e.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const a = Math.atan2(my - cy, mx - cx), d = Math.min(r.width * 0.2, Math.hypot(mx - cx, my - cy) / 18);
    e.firstChild.style.transform = `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px)`;
  });
}
addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; moved = Date.now(); look(); });
setInterval(() => { if (Date.now() - moved > 3000) { mx = Math.random() * innerWidth; my = Math.random() * innerHeight; look(); } }, 1800);

// ---------- actions (exposed for the inline handlers) ----------
const fail = e => { err = String(e?.message || e || 'something went wrong').replace(/^.*SenderError:?\s*/i, ''); busy = false; key = ''; paint(); };
const call = (name, args) => conn.reducers[name](args).catch(fail);
Object.assign(window, {
  go(s) { screen = s; err = ''; paint(); },
  newSplash() { let s; do s = SPLASHES[Math.floor(Math.random() * SPLASHES.length)]; while (s === splash); splash = s; $('splash').innerHTML = `<span>${esc(s)}</span>`; },
  async createRoom() {
    const question = $('q').value.trim();
    if (!question) { err = 'type the decision, even a vague one'; key = ''; return paint(); }
    if (!online) { err = "can't reach the game server"; key = ''; return paint(); }
    err = ''; busy = true; key = ''; paint();
    const before = Date.now() * 1000;
    try { await conn.reducers.createRoom({ question }); } catch (e) { return fail(e); }
    // the new room is the newest one this identity hosts
    const mine = [...conn.db.room.iter()].filter(r => r.host.isEqual(me) && Number(r.createdAt.microsSinceUnixEpoch) >= before - 5e6).sort((a, b) => (a.createdAt.microsSinceUnixEpoch > b.createdAt.microsSinceUnixEpoch ? -1 : 1));
    busy = false;
    if (!mine.length) return fail('room created, but it did not show up. try again?');
    watch(mine[0].code); paint();
  },
  async joinRoom() {
    const c = $('code').value.trim().toUpperCase(), name = $('name').value.trim();
    if (c.length !== 4) { err = 'room codes are 4 letters'; key = ''; return paint(); }
    if (!name) { err = 'what should we call you?'; key = ''; return paint(); }
    err = ''; busy = true; key = ''; paint();
    try { await conn.reducers.joinRoom({ code: c, name }); } catch (e) { return fail(e); }
    busy = false; screen = 'entry'; watch(c); paint();
  },
  submitEntry() {
    const text = $('entry').value.trim();
    if (!text) { err = 'type something. anything.'; key = ''; return paint(); }
    err = ''; call('setEntry', { code, text }); screen = 'waiting'; paint();
  },
  tap(i) {
    call('tap', { code, option: i });
    const b = $('t' + i); if (b) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
    if (navigator.vibrate) navigator.vibrate(10);
  },
  clearTaps() { call('clearTaps', { code }); },
  buy(i) { call('buy', { code, option: i }); if (navigator.vibrate) navigator.vibrate(10); },
  start() { call('startGame', { code }); },
  skip() { call('skip', { code }); },
  restart() { watch(null); screen = 'home'; err = ''; rang = false; lastPhase = null; paint(); },
});

// ---------- screens ----------
// each view returns a key; the page is rebuilt only when the key changes, otherwise update() patches it in place
function local() {
  if (screen === 'home') return { k: 'home', build: () => `<main class="home"><div class="brand">${title()}<p class="splash" id="splash" onclick="newSplash()" title="another one"><span>${esc(splash)}</span></p></div><nav><button class="link" onclick="go('join')">join room</button><button class="link" onclick="go('create')">create room</button></nav></main>` };
  if (screen === 'join' || screen === 'entry' || screen === 'waiting') return { k: 'join' + err + busy, build: () => split('join', form(field('code', 'room code', 4, linkCode) + field('name', 'name', 12), 'joinRoom()')) };
  return { k: 'create' + err + busy, build: () => split('create', form(field('q', 'what are you trying to do?', 80), 'createRoom()')) };
}

const TITLES = { filling: 'claude is thinking...', vote1: 'round 1: gut call', market: 'the market is open', vote2: 'round 2: second thoughts', close: 'ding ding ding', results: 'the results are in' };

function player(S) {
  const P = S.P, ph = S.phase;
  if (ph === 'lobby') {
    const waiting = screen === 'waiting' || (P.entry && screen !== 'entry');
    if (!waiting) return { k: 'p-entry' + err, build: () => split('join', form(`<p class="prompt ask">“${esc(S.question)}”</p>` + field('entry', 'insert your entry', 30, P.entry), 'submitEntry()')) };
    return { k: 'p-wait' + P.entry + S.players.length, build: () => `<main class="phone" style="align-items:center;text-align:center">${title('sm')}<p class="prompt">“${esc(S.question)}”</p><div class="solo">${blob(P, P.entry || '...')}</div><p class="mute">you're in with ${S.players.length - 1} other${S.players.length === 2 ? '' : 's'}. eyes on the big screen.</p><button class="link" onclick="go('entry')">change my entry</button></main>` };
  }
  if (ph === 'filling') return { k: 'p-fill', build: () => `<main class="phone" style="align-items:center;text-align:center">${title('sm')}<div class="solo">${blob(P, 'hmm...')}</div><p class="prompt">not enough entries, so claude is adding a few</p></main>` };
  if (ph === 'vote1' || ph === 'vote2') {
    const v = ph === 'vote1' ? P.v1 : P.v2, n = sum(v);
    return {
      k: 'p-' + ph,
      build: () => `<main class="phone">${fuse()}${title('xs')}<h2>${TITLES[ph]}</h2>
        <p style="margin:0">tap as much as you like. <span class="mute">more taps = more sure.</span></p>
        ${S.options.map((o, i) => `<button class="tap sketch" id="t${i}" onclick="tap(${i})"><span><i class="sw" style="background:${HL[i % 6]}"></i>${esc(o)}</span><span class="tp" id="tp${i}"></span><span class="dots" id="dots${i}"></span></button>`).join('')}
        <div style="display:flex;justify-content:space-between;align-items:center"><span id="saved" class="mute" style="font-size:20px"></span><button class="link" style="font-size:24px" onclick="clearTaps()">start over</button></div></main>`,
      update: () => {
        S.options.forEach((o, i) => {
          $('tp' + i).innerHTML = n ? `${Math.round(v[i] / n * 100)}%<small>${v[i]}</small>` : '';
          $('dots' + i).innerHTML = `<i style="background:${HL[i % 6]}"></i>`.repeat(Math.min(v[i], 24)) + (v[i] > 24 ? `<span class="mute" style="font-size:18px">+${v[i] - 24}</span>` : '');
        });
        $('saved').textContent = ph === 'vote1' ? (n ? `${n} taps saved ✓` : '') : P.voted ? 'changed ✓' : n ? 'your round-1 taps carried over' : '';
      },
    };
  }
  if (ph === 'market') {
    const cur = S.pitches[S.slot], mine = cur && String(cur.playerId) === P.id;
    return {
      k: 'p-market' + S.slot,
      build: () => `<main class="phone">${fuse()}${title('xs')}<h2>the market is open</h2><p style="margin:0">you have <b id="chips"></b> chips</p>
        ${mine ? `<div class="sticky"><b>your turn! pitch it out loud</b>sell <u>${esc(S.options[cur.option])}</u> to the room.<br>handicap: ${esc(cur.rule)}<div class="timer" id="st"></div></div>` : cur ? `<p class="mute" style="margin:0">${esc(cur.name)} is pitching ${esc(S.options[cur.option])}</p>` : ''}
        ${S.options.map((o, i) => `<button class="buy sketch" id="b${i}" onclick="buy(${i})"><span><i class="sw" style="background:${HL[i % 6]}"></i>${esc(o)}</span><span class="bp" id="bp${i}"></span><span class="bs" id="bs${i}"></span></button>`).join('')}
        <p class="mic" id="mic"></p>
        <p class="mute" style="font-size:20px">each tap spends 10 chips. every share pays 1 chip if its option wins at the closing bell.</p></main>`,
      update: () => {
        $('chips').textContent = P.chips;
        S.options.forEach((o, i) => {
          $('bp' + i).textContent = Math.round(S.prices[i] * 100) + '¢';
          $('bs' + i).textContent = P.shares[i] > 0 ? `you hold ${P.shares[i].toFixed(1)} shares · tap to buy more` : 'tap to buy';
          $('b' + i).disabled = P.chips < 10;
        });
        if (mine) $('st').textContent = slotLeft(S) + 's';
        const m = S.feed[0]; $('mic').textContent = m ? 'claude: ' + m : ''; $('mic').style.display = m ? '' : 'none';
      },
    };
  }
  if (ph === 'close') return { k: 'p-close', build: () => `<main class="phone" style="align-items:center;text-align:center">${title('xs')}<h2>the closing bell</h2><div id="bellchart" style="width:100%"></div><div id="done"></div></main>`, after: () => ringBell(S, 440, 260) };
  const R = S.r, i = S.players.slice().sort((a, b) => net(R, b) - net(R, a)).findIndex(p => p.mine), mynet = net(R, P);
  const note = S.comments.filter(c => c.kind === 'note' && String(c.playerId) === P.id).pop();
  return {
    k: 'p-res' + !!S.latest('report') + !!note, build: () => `<main class="phone" style="align-items:center;text-align:center"><p class="mute" style="margin:0">at the closing bell</p><h1 class="title win" style="font-size:56px">${esc(S.options[R.winner])}</h1>
    <p class="big ${mynet >= 0 ? 'up' : 'dn'}" style="margin:0">${mynet >= 0 ? '+' : ''}${mynet} chips</p><p style="margin:0">#${i + 1} of ${S.players.length} traders</p>
    ${note ? sticky('claude, just for you', note.text) : ''}
    <div style="width:100%">${chart(S, S.path, { w: 440, h: 260 })}</div>
    ${S.latest('report') ? sticky('analyst report · claude', S.latest('report')) : ''}${btn('done', 'restart()')}</main>`,
  };
}
const slotLeft = S => Math.max(0, S.left - (Math.ceil(S.total / S.r.slotLen) - 1 - S.slot) * S.r.slotLen);
const net = (R, p) => Math.round(p.chips + (p.shares[R.winner] || 0) - 100);

function host(S) {
  const ph = S.phase, P = S.players;
  if (ph === 'lobby' || ph === 'filling') return {
    k: 'h-lobby' + JSON.stringify(P.map(p => [p.id, p.entry, p.online])) + ph,
    build: () => `<main class="screen">${title('mid')}<p class="prompt" style="margin-top:34px">${esc(S.question)}</p>
      ${P.length ? crowd(P, p => p.entry || '...', p => (p.entry ? '' : 'wait ') + (p.online ? '' : 'off')) : `<p class="mute" style="margin:70px 0">waiting for people to join...</p>`}
      ${ph === 'filling' ? '<p class="mute">not enough entries. claude is adding a few...</p>' : P.length ? btn('start', 'start()') : ''}${roomTag(S, true)}</main>`,
    after: () => { if (window.QRCode && $('qr')) new QRCode($('qr'), { text: `${location.origin}/?code=${S.code}`, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M }); },
  };
  if (ph === 'vote1' || ph === 'vote2') {
    const take = ph === 'vote1' ? S.latest('take') : S.feed[0];
    return {
      k: 'h-' + ph + P.map(p => +p.voted).join('') + !!take,
      build: () => `<main class="screen">${fuse()}<div class="topbar">${title('xs')}<p class="prompt">${esc(S.question)}</p>${clock()}</div>
        <p class="big">${TITLES[ph]}</p><p class="mute" style="margin:0">${ph === 'vote1' ? 'tap your phone. tap more for the ones you believe in.' : 'heard the pitches? your taps carry over. tap to change your mind.'}</p>
        ${crowd(P, p => p.voted ? (ph === 'vote1' ? 'tapped in ✓' : 'changed my mind') : '...', p => p.voted ? '' : 'wait')}
        ${take ? sticky(ph === 'vote1' ? "claude's first take" : 'claude on the mic', take) : ''}
        <p style="margin:18px 0 0">${P.filter(p => p.voted).length}/${P.length} ${ph === 'vote1' ? 'tapped in' : 'changed their mind'}</p>${btn('close voting now', 'skip()', 'skip')}</main>`,
    };
  }
  if (ph === 'market') {
    const cur = S.pitches[S.slot], who = cur && (P.find(p => p.id === String(cur.playerId)) || cur);
    return {
      k: 'h-market' + S.slot + S.feed.join('|'),
      build: () => `<main class="screen">${fuse()}<div class="topbar">${title('xs')}<div><p class="prompt">${esc(S.question)}</p><p class="mute" style="margin:0">buy on your phone</p></div>${clock()}</div>
        <div class="mk"><div><div class="chartbox sketch" id="live"></div>${S.options.map((o, i) => `<div class="row"><div class="nm">${esc(o)}</div><div class="track sketch"><div><i id="f${i}" style="background:${HL[i % 6]}"></i></div></div><div class="px"><span id="p${i}"></span> <span id="d${i}"></span></div></div>`).join('')}</div>
        <aside>${cur ? `<div class="pitch"><span class="mute">now pitching</span><div class="solo">${blob(who, cur.rule)}</div><p style="margin:0">selling <span style="background:${HL[cur.option % 6]};padding:0 6px">${esc(S.options[cur.option])}</span></p><div class="timer" id="slot"></div></div>` : ''}
        <div class="feed">${S.feed.map((t, i) => sticky(i ? '' : 'claude on the mic', t)).join('')}</div></aside></div>${btn('close the market now', 'skip()', 'skip')}</main>`,
      update: () => {
        const n = S.options.length;
        $('live').innerHTML = chart(S, S.hist, { len: S.hist.length + S.left, w: 760, h: 280 });
        S.options.forEach((o, i) => {
          const p = S.prices[i], d = p - 1 / n, e = $('d' + i);
          $('f' + i).style.width = p * 100 + '%'; $('p' + i).textContent = Math.round(p * 100) + '¢';
          e.textContent = d >= 0 ? '▲' : '▼'; e.className = d >= 0 ? 'up' : 'dn';
        });
        if ($('slot')) $('slot').textContent = slotLeft(S) + 's';
      },
    };
  }
  if (ph === 'close') return {
    k: 'h-close',
    build: () => `<main class="screen"><div class="topbar">${title('xs')}<p class="prompt">${esc(S.question)}</p></div>
      <p class="big">the closing bell</p><p class="mute" style="margin:0">score = round-2 taps averaged with market price, plus a little noise at the bell</p>
      <div class="bell"><div id="bellchart"></div><aside>${sticky('chaos card: ' + S.r.card, S.r.cardText)}<div id="done" style="text-align:center"></div></aside></div></main>`,
    after: () => ringBell(S, 900, 420),
  };
  const R = S.r, pc = x => Math.round(x * 100) + '%';
  const board = P.map(p => ({ name: p.name, net: net(R, p) })).sort((a, b) => b.net - a.net);
  const pers = S.pitches.filter(p => p.start >= 0).map(p => ({ name: p.name, option: p.option, delta: (p.end < 0 ? p.start : p.end) - p.start })).sort((a, b) => b.delta - a.delta);
  const rep = S.latest('report');
  return {
    k: 'h-res' + !!rep,
    build: () => `<main class="screen"><p class="mute" style="margin:0">at the closing bell</p><h1 class="title win">${esc(S.options[R.winner])}</h1>
      <p style="margin:0 0 22px">${R.upset ? '<span class="dn">upset!</span> the underdog took it at the bell.' : '<span class="up">the favorite</span> held on at the bell.'} <span class="mute">chaos card: ${esc(R.card)}</span></p>
      ${rep ? sticky('analyst report · claude', rep) : '<p class="mute">claude is writing the report...</p>'}
      <div class="chartbox sketch">${chart(S, S.path, { marks: bellMarks(S), w: 1100, h: 340 })}</div>
      <div class="cols">
        <section class="box sketch"><h3>confidence</h3><p class="mute" style="margin:0 0 6px;font-size:18px">round 1 → round 2 (at the bell)</p>${S.options.map((o, i) => `<div><span>${esc(o)}</span><span>${pc(R.s1[i])} → ${pc(R.s2[i])} <span class="mute">(${pc(R.final[i])})</span></span></div>`).join('')}</section>
        <section class="box sketch"><h3>persuasion</h3>${pers.map(p => `<div><span>${esc(p.name)} <span class="mute">for ${esc(S.options[p.option])}</span></span><span class="${p.delta >= 0 ? 'up' : 'dn'}">${p.delta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(p.delta * 100))}</span></div>`).join('')}</section>
        <section class="box sketch"><h3>leaderboard</h3>${board.map(b => `<div><span>${esc(b.name)}</span><span class="${b.net >= 0 ? 'up' : 'dn'}">${b.net >= 0 ? '+' : ''}${b.net}</span></div>`).join('')}</section>
      </div>${btn('new decision', 'restart()')}</main>`,
  };
}

// the closing bell: the market chart plays out its final ticks, highest score at the end wins
function ringBell(S, w, h) {
  if (rang || !S.marks) return; rang = true;
  const marks = w > 600 ? bellMarks(S) : [];
  let k = S.marks.round2 + 1;
  const draw = () => { if ($('bellchart')) $('bellchart').innerHTML = chart(S, S.path, { upto: k, marks, w, h }); };
  draw();
  setTimeout(function step() {
    k++; draw();
    if (k < S.path.length) return setTimeout(step, k > S.path.length - 4 ? 650 : 320); // slow down for the last few ticks
    if ($('done')) $('done').innerHTML = `<p class="mute" style="margin:0">at the bell</p><h1 class="title win" style="font-size:${w > 600 ? 72 : 52}px">${esc(S.options[S.r.winner])}</h1>`;
  }, 1600);
}

function render() {
  const S = ready && online ? snapshot() : null;
  if (code && ready && !conn.db.room.code.find(code)) watch(null); // room is gone
  // a title card slides across whenever the phase changes
  if (S && S.phase !== lastPhase) {
    if (lastPhase && TITLES[S.phase]) { $('intro').innerHTML = `<b>${TITLES[S.phase]}</b>`; setTimeout(() => { $('intro').innerHTML = ''; }, 1750); }
    if (S.phase !== 'close') rang = false;
    lastPhase = S.phase;
  }
  const loading = { k: 'loading', build: () => `<main class="home">${title('sm')}<p class="mute">${online ? 'one sec...' : 'connecting...'}</p></main>` };
  const v = !S ? (code && (!ready || !online || conn.db.room.code.find(code)) ? loading : local()) : S.host ? host(S) : S.P ? player(S) : local();
  if (v.k !== key) {
    key = v.k; app.innerHTML = v.build(); v.after && v.after();
    const first = [...app.querySelectorAll('input')].find(i => !i.value);
    if (first && matchMedia('(pointer:fine)').matches) first.focus();
  }
  v.update && v.update();
  if (S && $('fuse')) { const f = $('fuse'); f.firstChild.style.width = (S.total ? S.left / S.total * 100 : 0) + '%'; f.classList.toggle('hot', S.left <= 5); }
  if (S && $('clock')) $('clock').textContent = S.left + 's';
  $('conn').innerHTML = !online && ready ? '<div class="conn">reconnecting...</div>' : '';
  look();
}
render();