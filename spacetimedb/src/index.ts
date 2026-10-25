// Second Thoughts: all game state and rules live in this SpacetimeDB module.
// Phones and the host screen subscribe to these tables directly; the Node
// server only serves the page and runs the Claude commentator (a bot client).
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

const room = table({ name: 'room', public: true }, {
  code: t.string().primaryKey(),
  host: t.identity(),
  question: t.string(),
  phase: t.string(), // lobby | filling | vote1 | market | vote2 | close | results
  options: t.array(t.string()),
  q: t.array(t.f64()), // LMSR share totals per option
  rules: t.array(t.string()), // pitch handicaps
  left: t.u32(), // seconds left in the current timed phase
  total: t.u32(), // length of the current timed phase
  slot: t.i32(), // which pitch is live during the market
  slotLen: t.u32(),
  ticks: t.u32(), // market seconds elapsed (chart x axis)
  s1: t.array(t.f64()), // round-1 confidence
  s2: t.array(t.f64()), // round-2 confidence
  blend: t.array(t.f64()), // (round-2 + market) / 2, before the bell
  final: t.array(t.f64()), // after noise + chaos card
  winner: t.i32(),
  upset: t.bool(),
  card: t.string(),
  cardText: t.string(),
  createdAt: t.timestamp(),
});

const player = table({
  name: 'player', public: true,
  indexes: [
    { accessor: 'by_room_identity', algorithm: 'btree', columns: ['room', 'identity'] },
    { accessor: 'by_identity', algorithm: 'btree', columns: ['identity'] },
  ],
}, {
  id: t.u64().primaryKey().autoInc(),
  room: t.string(),
  identity: t.identity(),
  name: t.string(),
  entry: t.string(),
  option: t.i32(), // index of the option this player's entry became
  chips: t.u32(),
  shares: t.array(t.f64()),
  v1: t.array(t.u32()), // round-1 taps per option (unlimited)
  v2: t.array(t.u32()),
  moved: t.bool(), // tapped during round 2
  online: t.bool(),
});

const pricePoint = table({ name: 'price_point', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  room: t.string().index('btree'),
  idx: t.u32(),
  kind: t.string(), // m = market second, r2 = after round 2, bell = closing ticks
  prices: t.array(t.f64()),
});

const pitch = table({ name: 'pitch', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  room: t.string().index('btree'),
  ord: t.u32(),
  playerId: t.u64(),
  name: t.string(),
  option: t.u32(),
  rule: t.string(),
  start: t.f64(), // price of the pitched option when the pitch began (-1 = not yet)
  end: t.f64(),
});

const trade = table({ name: 'trade', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  room: t.string().index('btree'),
  playerId: t.u64(),
  name: t.string(),
  option: t.u32(),
  chips: t.u32(),
  price: t.f64(), // price after the trade
  at: t.timestamp(),
});

const comment = table({ name: 'comment', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  room: t.string().index('btree'),
  kind: t.string(), // take | opening | pitch | ticker | report | note
  playerId: t.u64(), // 0 = whole room, otherwise a personal note
  text: t.string(),
  at: t.timestamp(),
});

// private: which client identity is the Claude commentator
const bot = table({ name: 'bot' }, {
  id: t.u32().primaryKey(),
  identity: t.identity(),
  key: t.string(),
});

const clock = table({ name: 'clock' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

const spacetimedb = schema({ room, player, pricePoint, pitch, trade, comment, bot, clock });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Room = NonNullable<ReturnType<Ctx['db']['room']['code']['find']>>;

// ---------- tuning ----------
const B = 40, BUY = 10, START = 100, MAX_OPTS = 6, MAX_PLAYERS = 12;
const VOTE1 = 30, VOTE2 = 20, FILL = 8, CLOSE = 12; // seconds
const NOISE = 0.06, STEPS = 14;
const RULES = ['Pitch in a pirate voice', 'Whisper the whole time', 'Never say the word "the"', 'Be a sports commentator', 'Speak only in questions', 'Narrate like a nature documentary', 'Sell it like an infomercial at 3am', 'Start every sentence with "Honestly"', 'Pitch while pretending to be very sleepy', 'Talk like a movie trailer'];
const CARDS = [
  { name: 'Calm Close', text: 'Half the noise at the bell. Leaders sleep easy.', noise: 0.5, nudge: 0 },
  { name: 'Volatile Close', text: 'Double the noise at the bell. Close races get spicy.', noise: 2, nudge: 0 },
  { name: 'Favorite Tax', text: 'The leader pays 8 points before the bell.', noise: 1, nudge: 1 },
  { name: 'Underdog Bonus', text: 'Last place gets 8 free points.', noise: 1, nudge: -1 },
  { name: 'No Card Today', text: 'Nothing changes. Boring, but fair.', noise: 1, nudge: 0 },
];

// ---------- helpers ----------
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const norm = (a: number[]) => { const s = sum(a) || 1; return a.map(v => v / s); };
const prices = (q: number[]) => { const e = q.map(x => Math.exp(x / B)); return norm(e); };
const argmax = (a: number[]) => a.indexOf(Math.max(...a));
const argmin = (a: number[]) => a.indexOf(Math.min(...a));
const same = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const zeros = (n: number) => Array.from({ length: n }, () => 0);

function playersOf(ctx: Ctx, code: string) { return [...ctx.db.player.by_room_identity.filter(code)].sort((a, b) => Number(a.id - b.id)); }
function me(ctx: Ctx, code: string) { return [...ctx.db.player.by_room_identity.filter([code, ctx.sender])][0]; }
function getRoom(ctx: Ctx, code: string) {
  const r = ctx.db.room.code.find(code.toUpperCase().trim());
  if (!r) throw new SenderError('No room with that code.');
  return r;
}
function mustHost(ctx: Ctx, r: Room) { if (!r.host.equals(ctx.sender)) throw new SenderError('Only the host can do that.'); }
function mustBot(ctx: Ctx) { const b = ctx.db.bot.id.find(0); if (!b || !b.identity.equals(ctx.sender)) throw new SenderError('Only the commentator can do that.'); }
// average of each player's taps, as shares of their own taps; players who never tapped don't count
function confidence(rows: number[][], n: number) {
  const vs = rows.filter(v => sum(v) > 0).map(norm);
  return vs.length ? zeros(n).map((_, i) => sum(vs.map(v => v[i])) / vs.length) : zeros(n).map(() => 1 / n);
}
function shuffle<T>(ctx: Ctx, a: T[]) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = ctx.random.integerInRange(0, i); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function point(ctx: Ctx, code: string, idx: number, kind: string, p: number[]) { ctx.db.pricePoint.insert({ id: 0n, room: code, idx, kind, prices: p }); }
function save(ctx: Ctx, r: Room) { return ctx.db.room.code.update(r); }

// ---------- phase machine ----------
function setOptions(ctx: Ctx, r: Room, opts: string[]) {
  const n = opts.length;
  for (const p of playersOf(ctx, r.code)) {
    const option = p.entry ? opts.findIndex(o => same(o) === same(p.entry)) : -1;
    ctx.db.player.id.update({ ...p, option, shares: zeros(n), v1: zeros(n), v2: zeros(n), moved: false });
  }
  return save(ctx, { ...r, options: opts, q: zeros(n), phase: 'vote1', left: VOTE1, total: VOTE1, rules: r.rules.length ? r.rules : RULES });
}

function openMarket(ctx: Ctx, r: Room) {
  const P = playersOf(ctx, r.code), n = r.options.length;
  const s1 = confidence(P.map(p => p.v1), n);
  const q = s1.map(p => B * Math.log(Math.max(p, 0.02))); // market opens at round-1 confidence
  const px = prices(q), pool = r.rules.length >= 3 ? r.rules : RULES;
  shuffle(ctx, P).forEach((p, i) => {
    const option = p.option >= 0 ? p.option : i % n;
    ctx.db.pitch.insert({ id: 0n, room: r.code, ord: i, playerId: p.id, name: p.name, option, rule: pool[ctx.random.integerInRange(0, pool.length - 1)], start: i === 0 ? px[option] : -1, end: -1 });
  });
  const slotLen = Math.max(10, Math.min(20, Math.floor(60 / Math.max(P.length, 1))));
  point(ctx, r.code, 0, 'm', px);
  return save(ctx, { ...r, s1, q, phase: 'market', slot: 0, slotLen, ticks: 0, left: slotLen * P.length, total: slotLen * P.length });
}

function setPitchPrice(ctx: Ctx, code: string, ord: number, field: 'start' | 'end', price: number) {
  const pt = [...ctx.db.pitch.room.filter(code)].find(x => x.ord === ord);
  if (pt && pt[field] < 0) ctx.db.pitch.id.update({ ...pt, [field]: price });
}

function closeMarket(ctx: Ctx, r: Room) {
  const px = prices(r.q);
  setPitchPrice(ctx, r.code, r.slot, 'end', px[[...ctx.db.pitch.room.filter(r.code)].find(x => x.ord === r.slot)?.option ?? 0]);
  for (const p of playersOf(ctx, r.code)) ctx.db.player.id.update({ ...p, v2: [...p.v1], moved: false }); // gut call carries over
  return save(ctx, { ...r, phase: 'vote2', left: VOTE2, total: VOTE2 });
}

// The closing bell: score = (round-2 confidence + market price) / 2, plus a little noise.
// A clear favorite almost always wins; only close races can flip.
function ringBell(ctx: Ctx, r: Room) {
  const P = playersOf(ctx, r.code), n = r.options.length;
  const s2 = confidence(P.map(p => p.v2), n), px = prices(r.q);
  const blend = s2.map((x, i) => (x + px[i]) / 2);
  const card = CARDS[ctx.random.integerInRange(0, CARDS.length - 1)], amp = NOISE * card.noise;
  const lead = argmax(blend), last = argmin(blend);
  const scores = blend.map((x, i) => Math.max(0.005, x
    - (card.nudge === 1 && i === lead ? 0.08 : 0) + (card.nudge === -1 && i === last ? 0.08 : 0)
    + (ctx.random() * 2 - 1) * amp));
  const final = norm(scores), winner = argmax(final);
  point(ctx, r.code, r.ticks + 1, 'r2', blend);
  for (let k = 1; k <= STEPS; k++) { // the closing ticks drift to the final score, wobbling hardest mid-way
    const f = k / STEPS, wob = Math.sin(Math.PI * f) * amp * 0.8;
    point(ctx, r.code, r.ticks + 1 + k, 'bell', k === STEPS ? final : norm(blend.map((b, i) => Math.max(0.005, b + (final[i] - b) * f + (ctx.random() * 2 - 1) * wob))));
  }
  return save(ctx, { ...r, s2, blend, final, winner, upset: winner !== lead, card: card.name, cardText: card.text, phase: 'close', left: CLOSE, total: CLOSE });
}

function advance(ctx: Ctx, r: Room) {
  switch (r.phase) {
    case 'filling': return setOptions(ctx, r, r.options.length >= 2 ? r.options : ['Do it', 'Skip it']);
    case 'vote1': return openMarket(ctx, r);
    case 'market': return closeMarket(ctx, r);
    case 'vote2': return ringBell(ctx, r);
    case 'close': return save(ctx, { ...r, phase: 'results', left: 0, total: 0 });
  }
  return r;
}

// once per second: count down timed phases, record market prices, rotate pitches
export const tick = spacetimedb.reducer({ onSchedule: clock }, { timer: clock.rowType }, (ctx) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const r0 of [...ctx.db.room.iter()]) {
    if (now - r0.createdAt.microsSinceUnixEpoch > 6n * 3600n * 1_000_000n) { cleanup(ctx, r0.code); continue; }
    if (r0.phase === 'lobby' || r0.phase === 'results') continue;
    let r = { ...r0, left: Math.max(0, r0.left - 1) };
    if (r.phase === 'market') {
      const px = prices(r.q), ticks = r.ticks + 1, slot = Math.min(Math.floor((r.total - r.left) / r.slotLen), Math.max(0, Math.ceil(r.total / r.slotLen) - 1));
      point(ctx, r.code, ticks, 'm', px);
      if (slot !== r.slot) {
        const pts = [...ctx.db.pitch.room.filter(r.code)];
        const old = pts.find(x => x.ord === r.slot), nw = pts.find(x => x.ord === slot);
        if (old) setPitchPrice(ctx, r.code, old.ord, 'end', px[old.option]);
        if (nw) setPitchPrice(ctx, r.code, nw.ord, 'start', px[nw.option]);
      }
      r = { ...r, ticks, slot };
    }
    r = save(ctx, r);
    if (r.left === 0) advance(ctx, r);
  }
});

function cleanup(ctx: Ctx, code: string) {
  for (const p of playersOf(ctx, code)) ctx.db.player.id.delete(p.id);
  for (const tb of [ctx.db.pricePoint, ctx.db.pitch, ctx.db.trade, ctx.db.comment] as const)
    for (const row of [...(tb as any).room.filter(code)]) (tb as any).id.delete(row.id);
  ctx.db.room.code.delete(code);
}

export const init = spacetimedb.init((ctx) => {
  ctx.db.clock.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(1_000_000n) });
});
export const onConnect = spacetimedb.clientConnected((ctx) => {
  for (const p of [...ctx.db.player.by_identity.filter(ctx.sender)]) ctx.db.player.id.update({ ...p, online: true });
});
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  for (const p of [...ctx.db.player.by_identity.filter(ctx.sender)]) ctx.db.player.id.update({ ...p, online: false });
});

// ---------- host ----------
export const createRoom = spacetimedb.reducer({ question: t.string() }, (ctx, { question }) => {
  question = question.trim().slice(0, 80);
  if (!question) throw new SenderError('Tell us what you are deciding first.');
  let code = '';
  do code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[ctx.random.integerInRange(0, 23)]).join(''); // no 0/O or 1/I mixups
  while (ctx.db.room.code.find(code));
  ctx.db.room.insert({
    code, host: ctx.sender, question, phase: 'lobby', options: [], q: [], rules: [], left: 0, total: 0, slot: -1, slotLen: 0, ticks: 0,
    s1: [], s2: [], blend: [], final: [], winner: -1, upset: false, card: '', cardText: '', createdAt: ctx.timestamp,
  });
});

export const startGame = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const r = getRoom(ctx, code); mustHost(ctx, r);
  if (r.phase !== 'lobby') return;
  for (const p of playersOf(ctx, r.code)) if (!p.online) ctx.db.player.id.delete(p.id); // drop people who left the lobby
  const P = playersOf(ctx, r.code);
  if (!P.length) throw new SenderError('Wait for at least one player.');
  const opts: string[] = [];
  for (const p of P) if (p.entry && opts.length < MAX_OPTS && !opts.some(o => same(o) === same(p.entry))) opts.push(p.entry);
  if (opts.length >= 2) setOptions(ctx, r, opts);
  else save(ctx, { ...r, options: opts, phase: 'filling', left: FILL, total: FILL }); // Claude gets a few seconds to add options
});

export const skip = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const r = getRoom(ctx, code); mustHost(ctx, r);
  advance(ctx, r);
});

// ---------- players ----------
export const joinRoom = spacetimedb.reducer({ code: t.string(), name: t.string() }, (ctx, { code, name }) => {
  const r = getRoom(ctx, code); name = name.trim().slice(0, 12);
  if (!name) throw new SenderError('Add your name.');
  const mine = me(ctx, r.code);
  if (mine) { ctx.db.player.id.update({ ...mine, name, online: true }); return; }
  if (r.phase !== 'lobby') throw new SenderError('That game already started.');
  if (playersOf(ctx, r.code).length >= MAX_PLAYERS) throw new SenderError('That room is full.');
  ctx.db.player.insert({ id: 0n, room: r.code, identity: ctx.sender, name, entry: '', option: -1, chips: START, shares: [], v1: [], v2: [], moved: false, online: true });
});

export const setEntry = spacetimedb.reducer({ code: t.string(), text: t.string() }, (ctx, { code, text }) => {
  const r = getRoom(ctx, code), p = me(ctx, r.code);
  if (!p || r.phase !== 'lobby') return;
  ctx.db.player.id.update({ ...p, entry: text.trim().slice(0, 30) });
});

// unlimited taps: each tap adds one to that option; your confidence is your taps as shares
export const tap = spacetimedb.reducer({ code: t.string(), option: t.u32() }, (ctx, { code, option }) => {
  const r = getRoom(ctx, code), p = me(ctx, r.code);
  if (!p || option >= r.options.length) return;
  if (r.phase === 'vote1') { const v1 = [...p.v1]; v1[option]++; ctx.db.player.id.update({ ...p, v1 }); }
  else if (r.phase === 'vote2') { const v2 = [...p.v2]; v2[option]++; ctx.db.player.id.update({ ...p, v2, moved: true }); }
  else return;
  // everyone's in? don't make the room wait out the whole timer
  const P = playersOf(ctx, r.code), done = r.phase === 'vote1' ? P.every(x => sum(x.v1) > 0) : P.every(x => x.moved);
  if (done && r.left > 6) save(ctx, { ...r, left: 6 });
});

export const clearTaps = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const r = getRoom(ctx, code), p = me(ctx, r.code);
  if (!p) return;
  if (r.phase === 'vote1') ctx.db.player.id.update({ ...p, v1: zeros(r.options.length) });
  if (r.phase === 'vote2') ctx.db.player.id.update({ ...p, v2: zeros(r.options.length), moved: true });
});

// LMSR: spend BUY chips on option i, get s shares (each pays 1 chip if i wins at the bell)
export const buy = spacetimedb.reducer({ code: t.string(), option: t.u32() }, (ctx, { code, option }) => {
  const r = getRoom(ctx, code), p = me(ctx, r.code);
  if (!p || r.phase !== 'market' || p.chips < BUY || option >= r.options.length) return;
  const e = r.q.map(x => Math.exp(x / B)), S = sum(e);
  const s = B * Math.log((S * (Math.exp(BUY / B) - 1) + e[option]) / e[option]);
  const q = [...r.q]; q[option] += s;
  const shares = [...p.shares]; shares[option] += s;
  ctx.db.player.id.update({ ...p, chips: p.chips - BUY, shares });
  save(ctx, { ...r, q });
  ctx.db.trade.insert({ id: 0n, room: r.code, playerId: p.id, name: p.name, option, chips: BUY, price: prices(q)[option], at: ctx.timestamp });
});

// ---------- Claude commentator (a separate client process) ----------
export const botRegister = spacetimedb.reducer({ key: t.string() }, (ctx, { key }) => {
  const b = ctx.db.bot.id.find(0);
  if (!b) { ctx.db.bot.insert({ id: 0, identity: ctx.sender, key }); return; }
  if (b.key !== key) throw new SenderError('Wrong bot key.');
  ctx.db.bot.id.update({ ...b, identity: ctx.sender });
});

export const botFillOptions = spacetimedb.reducer({ code: t.string(), options: t.array(t.string()) }, (ctx, { code, options }) => {
  mustBot(ctx); const r = getRoom(ctx, code);
  if (r.phase !== 'filling') return;
  const opts = [...r.options];
  for (const o of options) { const x = o.trim().slice(0, 30); if (x && opts.length < MAX_OPTS && !opts.some(y => same(y) === same(x))) opts.push(x); }
  setOptions(ctx, r, opts.length >= 2 ? opts : ['Do it', 'Skip it']);
});

export const botSetRules = spacetimedb.reducer({ code: t.string(), rules: t.array(t.string()) }, (ctx, { code, rules }) => {
  mustBot(ctx); const r = getRoom(ctx, code);
  const clean = rules.map(x => x.trim().slice(0, 60)).filter(Boolean).slice(0, 16);
  if (clean.length >= 3 && (r.phase === 'vote1' || r.phase === 'filling')) save(ctx, { ...r, rules: clean });
});

export const botComment = spacetimedb.reducer({ code: t.string(), kind: t.string(), playerId: t.u64(), text: t.string() }, (ctx, { code, kind, playerId, text }) => {
  mustBot(ctx); const r = getRoom(ctx, code);
  ctx.db.comment.insert({ id: 0n, room: r.code, kind: kind.slice(0, 16), playerId, text: text.slice(0, 600), at: ctx.timestamp });
});