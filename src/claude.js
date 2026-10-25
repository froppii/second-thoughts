// Every Claude call lives here and runs server-side, so the API key never reaches a browser.
// Every function returns null on failure, so the game keeps going without Claude.
// CLAUDE_MOCK=1 returns canned lines, handy for testing the pipeline without a key.
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5'; // fast and cheap for live commentary
const MOCK = !!process.env.CLAUDE_MOCK;

async function ask(system, user, max = 300) {
  if (MOCK) return mock(system, user);
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error('Claude error', res.status, await res.text()); return null; }
    const data = await res.json();
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() || null;
  } catch (e) { console.error('Claude failed:', e.message); return null; }
}
const parse = t => { try { return JSON.parse(String(t).replace(/```json|```/g, '').trim()); } catch { return null; } };

const VOICE = `You are the live commentator for Second Thoughts, a playful group-decision game. The host asks a question and each friend submits one option. Everyone taps their phone to show confidence, then trades play-money on the options while teammates pitch out loud under silly handicaps. At the closing bell each option's score is its round-2 confidence averaged with its market price, plus a little random noise and a chaos card, and the highest score wins.
Rules: use ONLY the names and numbers in the data, and never invent events. Tease choices and bets, never people's traits or looks. The closing bell decides; you only comment and never tell people to override it. Plain text, no markdown, no emojis. Sound like a quick, warm sports or finance commentator.`;

// When the room is shy: add options for the host's question, skipping ones already submitted
export async function buildOptions(question, existing = []) {
  const out = parse(await ask(
    'Suggest 2 to 5 distinct, concrete, comparable options for a group decision. Reply with ONLY a JSON array of strings, each under 30 characters. If the request is not a harmless group decision, reply [].',
    existing.length ? `Decision: ${question}\nAlready on the list (do not repeat): ${existing.join('; ')}` : `Decision: ${question}`));
  return Array.isArray(out) ? out.map(String).filter(Boolean) : null;
}

// Silly pitch handicaps, loosely themed on the topic
export async function handicaps(question, options, n) {
  const out = parse(await ask(
    `Invent ${n + 2} different silly, harmless rules a player must follow while pitching an option out loud, like "Speak only in questions". Each under 8 words. Nothing about bodies, identity, or anything unsafe. Loosely theme a few on the topic. Reply with ONLY a JSON array of strings.`,
    { topic: question, options }));
  return Array.isArray(out) ? out.map(String).filter(Boolean) : null;
}

const line = (task, max = 160) => ctx => ask(`${VOICE}\n${task}`, ctx, max);
export const firstTake = line('The options are in and round 1 is starting. In 1 or 2 short sentences, react to the lineup of options and who submitted what. Do not predict a winner.');
export const opening = line("The market just opened at the group's round-1 confidence. In 2 short sentences: who is the early favorite and how split is the room.");
export const pitchReaction = line('A pitch slot just ended. In ONE short sentence, react to how much the pitched option\'s price moved during the pitch (priceChangePts) and the handicap they pitched under.', 90);
export const ticker = line('You are on the live market ticker. In ONE short sentence, call the most interesting recent trades or price moves.', 90);
export const report = line('The closing bell rang. Write a 3 to 4 sentence analyst report: how confidence and prices moved, who pitched most persuasively (priceChangePts), whether the chaos card or an upset mattered, and who made the best bet (chip board). End with one playful line.', 350);

// one short personal line per player for their phone, as {"name": "line"}
export async function notes(ctx) {
  const out = parse(await ask(`${VOICE}\nFor EACH player in chipBoard, write one short personal line (under 20 words) about how their bets and taps played out. Reply with ONLY a JSON object mapping player name to line.`, ctx, 500));
  return out && typeof out === 'object' && !Array.isArray(out) ? out : null;
}

function mock(system, user) {
  const u = typeof user === 'string' ? user : JSON.stringify(user);
  if (system.includes('Suggest 2 to 5')) return '["Pizza", "Sushi", "Dumplings"]';
  if (system.includes('Invent')) return '["Pitch like a weather report", "Rhyme every sentence", "Use only food metaphors"]';
  if (system.includes('personal line')) { const names = [...u.matchAll(/"player":"([^"]+)"/g)].map(m => m[1]); return JSON.stringify(Object.fromEntries(names.map(n => [n, `${n}, the market saw you coming.`]))); }
  if (system.includes('ticker')) return 'Mock ticker: chips are flying and the favorite is feeling the heat.';
  if (system.includes('pitch slot')) return 'Mock: that pitch moved the needle, handicap and all.';
  if (system.includes('analyst report')) return 'Mock report: confidence shifted, the market agreed, and the bell made it official. Nice trading, everyone.';
  if (system.includes('market just opened')) return 'Mock opening bell: the room is split and the favorite is nervous.';
  return 'Mock first take: what a lineup.';
}