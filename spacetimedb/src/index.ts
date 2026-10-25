// Second Thoughts: the whole backend lives in this SpacetimeDB module.
// Game state, rules, the game clock, the market, AND Claude's commentary all run here.
// Phones and the host screen subscribe to these tables directly; the frontend is static files.
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration, Timestamp } from 'spacetimedb';

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
  claude: t.bool(), // is Claude commentating this room?
  seenTrade: t.u64(), // last trade the market ticker has talked about
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

// PRIVATE: the Anthropic API key. Not public, so no client can ever subscribe to it.
const secret = table({ name: 'secret' }, {
  id: t.u32().primaryKey(),
  owner: t.identity(),
  apiKey: t.string(), // 'mock' = canned lines, for testing without a key
  model: t.string(),
});

// one row per Claude call; the runClaude procedure picks each up as soon as it's inserted
const claudeJob = table({ name: 'claude_job' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  room: t.string(),
  kind: t.string(), // fill | rules | take | opening | pitch | ticker | report | notes
  system: t.string(),
  user: t.string(),
  maxTokens: t.u32(),
});

const clock = table({ name: 'clock' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

const spacetimedb = schema({ room, player, pricePoint, pitch, trade, comment, secret, claudeJob, clock });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Db = Ctx['db'];
type Room = NonNullable<ReturnType<Db['room']['code']['find']>>;

// ---------- tuning ----------
const B = 40, BUY = 10, START = 100, MAX_OPTS = 6, MAX_PLAYERS = 12;
const VOTE1 = 30, VOTE2 = 20, FILL = 10, CLOSE = 12; // seconds
const NOISE = 0.06, STEPS = 14;
const DEFAULT_MODEL = 'claude-haiku-5-5'; // fast and cheap for live commentary
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
const prices = (q: number[]) => norm(q.map(x => Math.exp(x / B)));
const argmax = (a: number[]) => a.indexOf(Math.max(...a));
const argmin = (a: number[]) => a.indexOf(Math.min(...a));
const same = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const zeros = (n: number) => Array.from({ length: n }, () => 0);
const pct = (a: number[]) => a.map(x => Math.round(x * 100));

function playersOf(db: Db, code: string) { return [...db.player.by_room_identity.filter(code)].sort((a, b) => Number(a.id - b.id)); }
function pitchesOf(db: Db, code: string) { return [...db.pitch.room.filter(code)].sort((a, b) => a.ord - b.ord); }
function me(ctx: Ctx, code: string) { return [...ctx.db.player.by_room_identity.filter([code, ctx.sender])][0]; }
function getRoom(ctx: Ctx, code: string) {
  const r = ctx.db.room.code.find(code.toUpperCase().trim());
  if (!r) throw new SenderError('No room with that code.');
  return r;
}
function mustHost(ctx: Ctx, r: Room) { if (!r.host.equals(ctx.sender)) throw new SenderError('Only the host can do that.'); }
// average of each player's taps, as shares of their own taps; players who never tapped don't count
function confidence(rows: number[][], n: number) {
  const vs = rows.filter(v => sum(v) > 0).map(norm);
  return vs.length ? zeros(n).map((_, i) => sum(vs.map(v => v[i])) / vs.length) : zeros(n).map(() => 1 / n);
}
function shuffle<T>(ctx: Ctx, a: T[]) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = ctx.random.integerInRange(0, i); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function point(db: Db, code: string, idx: number, kind: string, p: number[]) { db.pricePoint.insert({ id: 0n, room: code, idx, kind, prices: p }); }
function save(db: Db, r: Room) { return db.room.code.update(r); }

// ================= Claude, the commentator =================
// Reducers can't make network calls, so they queue a job; the runClaude procedure
// (which can) calls the Anthropic API and writes the result back in a transaction.
const VOICE = `You are the live commentator for Second Thoughts, a playful group-decision game. The host asks a question and each friend submits one option. Everyone taps their phone to show confidence, then trades play-money on the options while teammates pitch out loud under silly handicaps. At the closing bell each option's score is its round-2 confidence averaged with its market price, plus a little random noise and a chaos card, and the highest score wins.
Rules: use ONLY the names and numbers in the data, and never invent events. Tease choices and bets, never people's traits or looks. The closing bell decides; you only comment and never tell people to override it. Plain text, no markdown, no emojis. Sound like a quick, warm sports or finance commentator.`;
const TASKS: Record<string, [string, number]> = {
  fill: ['Suggest 2 to 5 distinct, concrete, comparable options for a group decision. Reply with ONLY a JSON array of strings, each under 30 characters. If the request is not a harmless group decision, reply [].', 200],
  rules: ['Invent silly, harmless rules a player must follow while pitching an option out loud, like "Speak only in questions". Each under 8 words. Nothing about bodies, identity, or anything unsafe. Loosely theme a few on the topic. Reply with ONLY a JSON array of strings.', 250],
  take: [VOICE + '\nThe options are in and round 1 is starting. In 1 or 2 short sentences, react to the lineup of options and who submitted what. Do not predict a winner.', 160],
  opening: [VOICE + "\nThe market just opened at the group's round-1 confidence. In 2 short sentences: who is the early favorite and how split is the room.", 160],
  pitch: [VOICE + "\nA pitch slot just ended. In ONE short sentence, react to how much the pitched option's price moved during the pitch (priceChangePts) and the handicap they pitched under.", 90],
  ticker: [VOICE + '\nYou are on the live market ticker. In ONE short sentence, call the most interesting recent trades or price moves.', 90],
  report: [VOICE + '\nThe closing bell rang. Write a 3 to 4 sentence analyst report: how confidence and prices moved, who pitched most persuasively (priceChangePts), whether the chaos card or an upset mattered, and who made the best bet (chip board). End with one playful line.', 350],
  notes: [VOICE + '\nFor EACH player in chipBoard, write one short personal line (under 20 words) about how their bets and taps played out. Reply with ONLY a JSON object mapping player name to line.', 500],
};

function claudeOn(db: Db) { const s = db.secret.id.find(0); return !!(s && s.apiKey); }
function ask(db: Db, now: bigint, r: Room, kind: string, data: unknown) {
  if (!r.claude) return;
  const [system, maxTokens] = TASKS[kind];
  db.claudeJob.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(now), room: r.code, kind, system, user: JSON.stringify(data), maxTokens });
}

// the owner (whoever calls this first) sets the key: spacetime call <db> set_claude '"sk-ant-..."' '""'
export const setClaude = spacetimedb.reducer({ apiKey: t.string(), model: t.string() }, (ctx, { apiKey, model }) => {
  const s = ctx.db.secret.id.find(0);
  if (s && !s.owner.equals(ctx.sender)) throw new SenderError('Only the owner can change the Claude key.');
  const row = { id: 0, owner: ctx.sender, apiKey: apiKey.trim(), model: model.trim() || DEFAULT_MODEL };
  if (s) ctx.db.secret.id.update(row); else ctx.db.secret.insert(row);
});

export const runClaude = spacetimedb.procedure({ onSchedule: claudeJob }, { job: claudeJob.rowType }, t.unit(), (ctx, { job }) => {
  const cfg = ctx.withTx(tx => tx.db.secret.id.find(0));
  if (!cfg || !cfg.apiKey) return {};
  let text = '';
  if (cfg.apiKey === 'mock') text = mockLine(job.kind, job.user);
  else {
    try {
      const res = ctx.http.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: job.maxTokens, system: job.system, messages: [{ role: 'user', content: job.user }] }),
        timeout: TimeDuration.fromMillis(25000),
      });
      const body = res.text();
      if (!res.ok) { console.error(`Claude ${job.kind} failed: ${res.status} ${body.slice(0, 300)}`); return {}; }
      const data = JSON.parse(body) as { content: { type: string; text?: string }[] };
      text = data.content.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
    } catch (e) { console.error(`Claude ${job.kind} failed: ${e}`); return {}; }
  }
  if (!text) return {};
  const now = ctx.timestamp.microsSinceUnixEpoch;
  ctx.withTx(tx => applyClaude(tx.db, now, job.room, job.kind, text));
  return {};
});

const parse = (s: string): unknown => { try { return JSON.parse(s.replace(/```json|```/g, '').trim()); } catch { return null; } };

function applyClaude(db: Db, now: bigint, code: string, kind: string, text: string) {
  const r = db.room.code.find(code);
  if (!r) return;
  const at = new Timestamp(now);
  const say = (k: string, msg: string, playerId = 0n) => db.comment.insert({ id: 0n, room: code, kind: k, playerId, text: msg.slice(0, 600), at });
  if (kind === 'fill') {
    if (r.phase !== 'filling') return; // the timer already gave up waiting
    const out = parse(text);
    const opts = [...r.options];
    if (Array.isArray(out)) for (const o of out) { const x = String(o).trim().slice(0, 30); if (x && opts.length < MAX_OPTS && !opts.some(y => same(y) === same(x))) opts.push(x); }
    setOptions(db, now, r, opts.length >= 2 ? opts : ['Do it', 'Skip it']);
  } else if (kind === 'rules') {
    const out = parse(text);
    const clean = Array.isArray(out) ? out.map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 16) : [];
    if (clean.length >= 3 && r.phase === 'vote1') save(db, { ...r, rules: clean });
  } else if (kind === 'notes') {
    const out = parse(text);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return;
    const lines = out as Record<string, unknown>;
    for (const p of playersOf(db, code)) if (lines[p.name]) say('note', String(lines[p.name]), p.id);
  } else say(kind, text);
}

function mockLine(kind: string, user: string) {
  if (kind === 'fill') return '["Pizza", "Sushi", "Dumplings"]';
  if (kind === 'rules') return '["Pitch like a weather report", "Rhyme every sentence", "Use only food metaphors"]';
  if (kind === 'notes') { const names = [...user.matchAll(/"player":"([^"]+)"/g)].map(m => m[1]); return JSON.stringify(Object.fromEntries(names.map(n => [n, `${n}, the market saw you coming.`]))); }
  return ({ take: 'Mock first take: what a lineup.', opening: 'Mock opening bell: the room is split and the favorite is nervous.', pitch: 'Mock: that pitch moved the needle, handicap and all.', ticker: 'Mock ticker: chips are flying and the favorite is feeling the heat.', report: 'Mock report: confidence shifted, the market agreed, and the bell made it official. Nice trading, everyone.' } as Record<string, string>)[kind] || 'Mock line.';
}

// ---------- phase machine ----------
function setOptions(db: Db, now: bigint, r: Room, opts: string[]) {
  const n = opts.length, P = playersOf(db, r.code);
  for (const p of P) {
    const option = p.entry ? opts.findIndex(o => same(o) === same(p.entry)) : -1;
    db.player.id.update({ ...p, option, shares: zeros(n), v1: zeros(n), v2: zeros(n), moved: false });
  }
  const r2 = save(db, { ...r, options: opts, q: zeros(n), phase: 'vote1', left: VOTE1, total: VOTE1, rules: RULES });
  ask(db, now, r2, 'rules', { topic: r.question, options: opts, howMany: P.length + 2 });
  ask(db, now, r2, 'take', { question: r.question, options: opts, submittedBy: P.filter(p => p.entry).map(p => ({ player: p.name, entry: p.entry })) });
  return r2;
}

function openMarket(ctx: Ctx, r: Room) {
  const db = ctx.db, P = playersOf(db, r.code), n = r.options.length;
  const s1 = confidence(P.map(p => p.v1), n);
  const q = s1.map(p => B * Math.log(Math.max(p, 0.02))); // market opens at round-1 confidence
  const px = prices(q), pool = r.rules.length >= 3 ? r.rules : RULES;
  shuffle(ctx, P).forEach((p, i) => {
    const option = p.option >= 0 ? p.option : i % n;
    db.pitch.insert({ id: 0n, room: r.code, ord: i, playerId: p.id, name: p.name, option, rule: pool[ctx.random.integerInRange(0, pool.length - 1)], start: i === 0 ? px[option] : -1, end: -1 });
  });
  const slotLen = Math.max(10, Math.min(20, Math.floor(60 / Math.max(P.length, 1))));
  point(db, r.code, 0, 'm', px);
  const r2 = save(db, { ...r, s1, q, phase: 'market', slot: 0, slotLen, ticks: 0, left: slotLen * P.length, total: slotLen * P.length });
  ask(db, ctx.timestamp.microsSinceUnixEpoch, r2, 'opening', { question: r.question, options: r.options, round1ConfidencePct: pct(s1), players: P.length });
  return r2;
}

// a pitch starts or ends; when one ends, Claude reacts to how much it moved the price
function pitchPrice(ctx: Ctx, r: Room, ord: number, field: 'start' | 'end') {
  const pt = pitchesOf(ctx.db, r.code).find(x => x.ord === ord);
  if (!pt || pt[field] >= 0) return;
  const price = prices(r.q)[pt.option];
  ctx.db.pitch.id.update({ ...pt, [field]: price });
  if (field === 'end' && pt.start >= 0)
    ask(ctx.db, ctx.timestamp.microsSinceUnixEpoch, r, 'pitch', { question: r.question, pitcher: pt.name, pitched: r.options[pt.option], handicap: pt.rule, priceChangePts: Math.round((price - pt.start) * 100) });
}

function closeMarket(ctx: Ctx, r: Room) {
  pitchPrice(ctx, r, r.slot, 'end');
  for (const p of playersOf(ctx.db, r.code)) ctx.db.player.id.update({ ...p, v2: [...p.v1], moved: false }); // gut call carries over
  return save(ctx.db, { ...r, phase: 'vote2', left: VOTE2, total: VOTE2 });
}

// The closing bell: score = (round-2 confidence + market price) / 2, plus a little noise.
// A clear favorite almost always wins; only close races can flip.
function ringBell(ctx: Ctx, r: Room) {
  const db = ctx.db, P = playersOf(db, r.code), n = r.options.length;
  const s2 = confidence(P.map(p => p.v2), n), px = prices(r.q);
  const blend = s2.map((x, i) => (x + px[i]) / 2);
  const card = CARDS[ctx.random.integerInRange(0, CARDS.length - 1)], amp = NOISE * card.noise;
  const lead = argmax(blend), last = argmin(blend);
  const scores = blend.map((x, i) => Math.max(0.005, x
    - (card.nudge === 1 && i === lead ? 0.08 : 0) + (card.nudge === -1 && i === last ? 0.08 : 0)
    + (ctx.random() * 2 - 1) * amp));
  const final = norm(scores), winner = argmax(final);
  point(db, r.code, r.ticks + 1, 'r2', blend);
  for (let k = 1; k <= STEPS; k++) { // the closing ticks drift to the final score, wobbling hardest mid-way
    const f = k / STEPS, wob = Math.sin(Math.PI * f) * amp * 0.8;
    point(db, r.code, r.ticks + 1 + k, 'bell', k === STEPS ? final : norm(blend.map((b, i) => Math.max(0.005, b + (final[i] - b) * f + (ctx.random() * 2 - 1) * wob))));
  }
  const r2 = save(db, { ...r, s2, blend, final, winner, upset: winner !== lead, card: card.name, cardText: card.text, phase: 'close', left: CLOSE, total: CLOSE });
  const board = P.map(p => ({ player: p.name, net: Math.round(p.chips + (p.shares[winner] || 0) - START) })).sort((a, b) => b.net - a.net);
  const data = {
    question: r.question, options: r.options, winner: r.options[winner], upset: winner !== lead, chaosCard: card.name,
    round1Pct: pct(r.s1), round2Pct: pct(s2), marketPricePct: pct(px), beforeBellPct: pct(blend), closingScorePct: pct(final),
    persuasion: pitchesOf(db, r.code).filter(p => p.start >= 0).map(p => ({ player: p.name, pitched: r.options[p.option], handicap: p.rule, priceChangePts: Math.round(((p.end < 0 ? p.start : p.end) - p.start) * 100) })),
    chipBoard: board,
    taps: P.map(p => ({ player: p.name, round1: p.v1, round2: p.v2, changedMind: p.moved })),
  };
  const now = ctx.timestamp.microsSinceUnixEpoch;
  ask(db, now, r2, 'report', data);
  ask(db, now, r2, 'notes', data);
  return r2;
}

function advance(ctx: Ctx, r: Room) {
  switch (r.phase) {
    case 'filling': return setOptions(ctx.db, ctx.timestamp.microsSinceUnixEpoch, r, r.options.length >= 2 ? r.options : ['Do it', 'Skip it']);
    case 'vote1': return openMarket(ctx, r);
    case 'market': return closeMarket(ctx, r);
    case 'vote2': return ringBell(ctx, r);
    case 'close': return save(ctx.db, { ...r, phase: 'results', left: 0, total: 0 });
  }
  return r;
}

// every ~10s of trading, Claude calls the action on the market ticker
function ticker(ctx: Ctx, r: Room) {
  if (!r.claude || r.ticks % 10 !== 0 || r.left < 5) return r;
  const fresh = [...ctx.db.trade.room.filter(r.code)].filter(t => t.id > r.seenTrade).sort((a, b) => Number(a.id - b.id));
  if (fresh.length < 2) return r;
  const by: Record<string, number> = {};
  for (const t of fresh) { const k = `${t.name}|${t.option}`; by[k] = (by[k] || 0) + t.chips; }
  ask(ctx.db, ctx.timestamp.microsSinceUnixEpoch, r, 'ticker', {
    question: r.question, options: r.options, pricesPct: pct(prices(r.q)), secondsLeft: r.left,
    recentTrades: Object.entries(by).map(([k, chips]) => { const [who, o] = k.split('|'); return { player: who, bought: r.options[Number(o)], chips }; }),
  });
  return save(ctx.db, { ...r, seenTrade: fresh[fresh.length - 1].id });
}

// once per second: count down timed phases, record market prices, rotate pitches
export const tick = spacetimedb.reducer({ onSchedule: clock }, { timer: clock.rowType }, (ctx) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const r0 of [...ctx.db.room.iter()]) {
    if (now - r0.createdAt.microsSinceUnixEpoch > 6n * 3600n * 1_000_000n) { cleanup(ctx, r0.code); continue; }
    if (r0.phase === 'lobby' || r0.phase === 'results') continue;
    let r = { ...r0, left: Math.max(0, r0.left - 1) };
    if (r.phase === 'market') {
      const ticks = r.ticks + 1, slot = Math.min(Math.floor((r.total - r.left) / r.slotLen), Math.max(0, Math.ceil(r.total / r.slotLen) - 1));
      point(ctx.db, r.code, ticks, 'm', prices(r.q));
      if (slot !== r.slot) { pitchPrice(ctx, r, r.slot, 'end'); pitchPrice(ctx, r, slot, 'start'); }
      r = ticker(ctx, save(ctx.db, { ...r, ticks, slot }));
    }
    r = save(ctx.db, r);
    if (r.left === 0) advance(ctx, r);
  }
});

function cleanup(ctx: Ctx, code: string) {
  const db = ctx.db;
  for (const p of playersOf(db, code)) db.player.id.delete(p.id);
  for (const x of [...db.pricePoint.room.filter(code)]) db.pricePoint.id.delete(x.id);
  for (const x of [...db.pitch.room.filter(code)]) db.pitch.id.delete(x.id);
  for (const x of [...db.trade.room.filter(code)]) db.trade.id.delete(x.id);
  for (const x of [...db.comment.room.filter(code)]) db.comment.id.delete(x.id);
  db.room.code.delete(code);
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
    s1: [], s2: [], blend: [], final: [], winner: -1, upset: false, card: '', cardText: '', claude: claudeOn(ctx.db), seenTrade: 0n, createdAt: ctx.timestamp,
  });
});

export const startGame = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const r = getRoom(ctx, code); mustHost(ctx, r);
  if (r.phase !== 'lobby') return;
  for (const p of playersOf(ctx.db, r.code)) if (!p.online) ctx.db.player.id.delete(p.id); // drop people who left the lobby
  const P = playersOf(ctx.db, r.code);
  if (!P.length) throw new SenderError('Wait for at least one player.');
  const opts: string[] = [];
  for (const p of P) if (p.entry && opts.length < MAX_OPTS && !opts.some(o => same(o) === same(p.entry))) opts.push(p.entry);
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (opts.length >= 2 || !r.claude) { setOptions(ctx.db, now, r, opts.length >= 2 ? opts : ['Do it', 'Skip it']); return; }
  // not enough entries: Claude gets a few seconds to add some (the timer falls back if it's slow)
  const r2 = save(ctx.db, { ...r, options: opts, phase: 'filling', left: FILL, total: FILL });
  ask(ctx.db, now, r2, 'fill', existingOptions(r.question, opts));
});
const existingOptions = (question: string, opts: string[]) => opts.length ? `Decision: ${question}\nAlready on the list (do not repeat): ${opts.join('; ')}` : `Decision: ${question}`;

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
  if (playersOf(ctx.db, r.code).length >= MAX_PLAYERS) throw new SenderError('That room is full.');
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
  const P = playersOf(ctx.db, r.code), done = r.phase === 'vote1' ? P.every(x => sum(x.v1) > 0) : P.every(x => x.moved);
  if (done && r.left > 6) save(ctx.db, { ...r, left: 6 });
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
  save(ctx.db, { ...r, q });
  ctx.db.trade.insert({ id: 0n, room: r.code, playerId: p.id, name: p.name, option, chips: BUY, price: prices(q)[option], at: ctx.timestamp });
});