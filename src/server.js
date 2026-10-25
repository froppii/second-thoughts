// Serves the page, and runs Claude as a live commentator: a SpacetimeDB client that
// watches the game tables and writes commentary back through bot-only reducers.
import express from 'express';
import fs from 'node:fs';
import { DbConnection, tables } from './module_bindings/index.ts';
import * as claude from './claude.js';

const PORT = Number(process.env.PORT || 8080);
const STDB_URI = process.env.STDB_URI || 'ws://localhost:3000'; // where this server reaches SpacetimeDB
const STDB_DB = process.env.STDB_DB || 'second-thoughts';
const BOT_KEY = process.env.BOT_KEY || 'second-thoughts-local';
const TOKEN_FILE = '.bot-token';

// ---------- web ----------
const app = express();
// Browsers connect to SpacetimeDB directly. By default that's the same machine as this page
// (so phones on the LAN work); set STDB_PUBLIC_URI for maincloud, e.g. wss://maincloud.spacetimedb.com
app.get('/config.js', (req, res) => {
  const uri = process.env.STDB_PUBLIC_URI || STDB_URI.replace(/\/\/(localhost|127\.0\.0\.1)/, `//${req.hostname}`);
  res.type('application/javascript').send(`window.STDB = ${JSON.stringify({ uri, db: STDB_DB })};`);
});
app.use(express.static('public'));
app.listen(PORT, () => console.log(`Second Thoughts on http://localhost:${PORT}  (SpacetimeDB: ${STDB_URI}/${STDB_DB})`));

// ---------- Claude, the commentator ----------
const B = 40, START = 100;
const prices = q => { const e = q.map(x => Math.exp(x / B)), s = e.reduce((a, b) => a + b, 0) || 1; return e.map(x => x / s); };
const pct = a => a.map(x => Math.round(x * 100));
let token; try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || undefined; } catch {}

const conn = DbConnection.builder()
  .withUri(STDB_URI).withDatabaseName(STDB_DB).withToken(token).withAutomaticReconnect()
  .onConnect((c, _id, tok) => {
    try { fs.writeFileSync(TOKEN_FILE, tok); } catch {}
    c.reducers.botRegister({ key: BOT_KEY })
      .then(() => console.log(`Claude commentator connected${process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_MOCK ? '' : ' (no ANTHROPIC_API_KEY, so it will stay quiet)'}`))
      .catch(e => console.error('Commentator could not register:', e.message));
  })
  .onConnectError((_c, e) => console.error(`Commentator could not reach SpacetimeDB at ${STDB_URI}: ${e?.message || e}`))
  .build();
conn.subscriptionBuilder().subscribe([tables.room, tables.player, tables.pitch, tables.trade]);

const playersOf = code => [...conn.db.player.iter()].filter(p => p.room === code);
const pitchesOf = code => [...conn.db.pitch.iter()].filter(p => p.room === code).sort((a, b) => a.ord - b.ord);
const say = (code, kind, text, playerId = 0n) => text && conn.reducers.botComment({ code, kind, playerId, text }).catch(e => console.error('comment failed:', e.message));

conn.db.room.onUpdate((_ctx, old, r) => { if (old.phase !== r.phase) onPhase(r).catch(e => console.error(e)); });
conn.db.pitch.onUpdate((_ctx, old, p) => {
  if (old.end >= 0 || p.end < 0) return;
  const r = conn.db.room.code.find(p.room); if (!r) return;
  claude.pitchReaction({ question: r.question, pitcher: p.name, pitched: r.options[p.option], handicap: p.rule, priceChangePts: Math.round((p.end - p.start) * 100) })
    .then(t => say(r.code, 'pitch', t));
});

async function onPhase(r) {
  const P = playersOf(r.code);
  if (r.phase === 'filling') {
    const opts = await claude.buildOptions(r.question, r.options);
    if (opts && opts.length) conn.reducers.botFillOptions({ code: r.code, options: opts }).catch(() => {});
  } else if (r.phase === 'vote1') {
    claude.handicaps(r.question, r.options, P.length).then(l => l && conn.reducers.botSetRules({ code: r.code, rules: l }).catch(() => {}));
    say(r.code, 'take', await claude.firstTake({ question: r.question, options: r.options, submittedBy: P.filter(p => p.entry).map(p => ({ player: p.name, entry: p.entry })) }));
  } else if (r.phase === 'market') {
    say(r.code, 'opening', await claude.opening({ question: r.question, options: r.options, round1ConfidencePct: pct(r.s1), players: P.length }));
  } else if (r.phase === 'close') {
    const w = r.winner, board = P.map(p => ({ player: p.name, net: Math.round(p.chips + (p.shares[w] || 0) - START) })).sort((a, b) => b.net - a.net);
    const ctx = {
      question: r.question, options: r.options, winner: r.options[w], upset: r.upset, chaosCard: r.card,
      round1Pct: pct(r.s1), round2Pct: pct(r.s2), marketPricePct: pct(prices(r.q)), beforeBellPct: pct(r.blend), closingScorePct: pct(r.final),
      persuasion: pitchesOf(r.code).filter(p => p.start >= 0).map(p => ({ player: p.name, pitched: r.options[p.option], handicap: p.rule, priceChangePts: Math.round(((p.end < 0 ? p.start : p.end) - p.start) * 100) })), // skipped pitches never happened
      chipBoard: board,
      taps: P.map(p => ({ player: p.name, round1: p.v1, round2: p.v2, changedMind: p.moved })),
    };
    const [rep, mine] = await Promise.all([claude.report(ctx), claude.notes(ctx)]);
    say(r.code, 'report', rep);
    if (mine) for (const p of P) if (mine[p.name]) say(r.code, 'note', String(mine[p.name]), p.id);
  }
}

// live market ticker: every ~10s, if there's been trading, Claude calls it
const seen = {};
setInterval(() => {
  for (const r of conn.db.room.iter()) {
    if (r.phase !== 'market' || r.left < 5) continue;
    const fresh = [...conn.db.trade.iter()].filter(t => t.room === r.code && t.id > (seen[r.code] ?? 0n)).sort((a, b) => Number(a.id - b.id));
    if (fresh.length < 2) continue;
    seen[r.code] = fresh[fresh.length - 1].id;
    const byPlayer = {};
    for (const t of fresh) { const k = `${t.name}|${t.option}`; byPlayer[k] = (byPlayer[k] || 0) + t.chips; }
    claude.ticker({
      question: r.question, options: r.options, pricesPct: pct(prices(r.q)), secondsLeft: r.left,
      recentTrades: Object.entries(byPlayer).map(([k, chips]) => { const [player, o] = k.split('|'); return { player, bought: r.options[o], chips }; }),
    }).then(t => say(r.code, 'ticker', t));
  }
}, 10000);