// All Claude calls live here and run server-side, so the API key never reaches a browser.
// Every function returns null on any failure, so the game works fine without Claude.
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5'; // fast and cheap for live commentary

async function ask(system, user, max = 400) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error('Claude error', res.status, await res.text()); return null; }
    const data = await res.json();
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() || null;
  } catch (e) { console.error('Claude failed:', e.message); return null; }
}
const parse = t => { try { return JSON.parse(String(t).replace(/```json|```/g, '').trim()); } catch { return null; } };

const VOICE = `You are the commentator for Second Thoughts, a playful group-decision game. The host asks a question, each friend submits one option, then everyone sets confidence sliders, trades play-money on the options while teammates pitch under silly handicaps, and a wheel weighted by the group's confidence picks the winner.
Rules: use ONLY the names and numbers in the data, and never invent events. Tease choices and bets, never people's traits or looks. The wheel decides; you only comment, you never recommend overriding it. Plain text, no markdown, no emojis.`;

// When the room is shy: Claude adds options for the host's question, skipping ones already submitted
async function buildOptions(prompt, existing = []) {
  const user = existing.length ? `Decision: ${prompt}\nAlready on the list (do not repeat): ${existing.join('; ')}` : prompt;
  const out = parse(await ask(
    'Turn a group decision into one clear question and 2 to 6 distinct, concrete, comparable options. Reply with ONLY JSON: {"question":"...","options":["..."]}. Question under 80 characters, each option under 30. If the request is not a harmless group decision, reply {"question":"","options":[]}.',
    user, 300));
  if (!out || !Array.isArray(out.options)) return null;
  const options = out.options.map(o => String(o).slice(0, 30)).filter(Boolean).slice(0, 6);
  return options.length ? { question: String(out.question || '').slice(0, 80), options } : null;
}

// Silly pitch handicaps, loosely themed on the topic
async function handicaps(question, options, n) {
  const out = parse(await ask(
    `Invent ${n} different silly, harmless rules a player must follow while pitching an option out loud, like "Speak only in questions". Each under 8 words. Nothing about bodies, identity, or anything unsafe. Loosely theme a few on the topic. Reply with ONLY a JSON array of ${n} strings.`,
    JSON.stringify({ topic: question, options }), 300));
  return Array.isArray(out) ? out.map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, n + 3) : null;
}

const opening = ctx => ask(VOICE + '\nGive a two sentence opening-bell take on the group\'s round-1 confidence: who is the favorite and how split the room is.', JSON.stringify(ctx), 200);
const report = ctx => ask(VOICE + '\nWrite a 3 to 4 sentence analyst report: why confidence and prices moved, who pitched most persuasively (priceChangePts), whether the chaos card or an upset mattered, and who made the best bet (chip board). End with one playful line.', JSON.stringify(ctx), 350);

module.exports = { buildOptions, handicaps, opening, report };