// Vercel serverless function (Node.js runtime): calls Gemini API for gift ideas.
// Requires env var GEMINI_API_KEY set in Vercel project settings.
//
// Design notes (see docs/MASTER-PROMPT.md PART B lessons):
// - Tries a short ordered list of models, each with its own timeout, falling
//   through to the next on failure — model names and free-tier availability
//   both drift over time.
// - Free-tier Gemini quota is tied to the Google Cloud project behind the
//   key, not the key itself. If you've been testing another app (e.g. the
//   bill splitter) with a key from the same project, this app's requests
//   share that same daily quota.
// - Always returns { error: string } with the real upstream message so a
//   failure is debuggable from the phone, not just a blank "try again".

export const config = {
  maxDuration: 60,
};

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const PER_ATTEMPT_TIMEOUT_MS = 15000;

async function tryModel(model, apiKey, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );

    const bodyText = await response.text();

    if (!response.ok) {
      let message = bodyText;
      let isQuota = false;
      try {
        const parsedErr = JSON.parse(bodyText);
        message = (parsedErr.error && parsedErr.error.message) || bodyText;
        isQuota =
          response.status === 429 ||
          (parsedErr.error && parsedErr.error.status === 'RESOURCE_EXHAUSTED');
      } catch (e) {
        // bodyText wasn't JSON, use as-is
      }
      return { ok: false, model, status: response.status, message, isQuota };
    }

    const data = JSON.parse(bodyText);
    const rawText =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!rawText) {
      return { ok: false, model, status: 502, message: 'No content returned from model', isQuota: false };
    }

    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { ok: false, model, status: 502, message: 'Could not parse model response as JSON', isQuota: false };
    }

    if (!parsed.ideas || !Array.isArray(parsed.ideas)) {
      return { ok: false, model, status: 502, message: 'Malformed ideas list from model', isQuota: false };
    }

    return { ok: true, model, ideas: parsed.ideas };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      model,
      status: aborted ? 504 : 500,
      message: aborted ? `Timed out after ${PER_ATTEMPT_TIMEOUT_MS / 1000}s` : String(err),
      isQuota: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing the GEMINI_API_KEY environment variable.' });
    return;
  }

  const { name, relation, interests, styleTags, budget, occasion, pastGifts } = req.body || {};

  const styleLine =
    Array.isArray(styleTags) && styleTags.length ? styleTags.join(', ') : 'not specified';
  const interestsLine = interests && interests.trim() ? interests.trim() : 'not much noted';
  const pastGiftsLine =
    Array.isArray(pastGifts) && pastGifts.length ? pastGifts.join(', ') : 'none';

  const prompt = `You are brainstorming as a close friend of the gift-giver — not a marketer, not a product catalog, not a sponsored listicle. Be honest, specific, and a little opinionated, the way a friend would when they actually know someone.

Person: ${name || 'Unknown'}
Relationship to gift-giver: ${relation || 'not specified'}
Style / vibe: ${styleLine}
Interests / notes: ${interestsLine}
Budget: ${budget || 'moderate, no strict limit'}
Occasion: ${occasion || 'no specific occasion'}
Already given before (do not repeat or suggest close variants): ${pastGiftsLine}

Hard rules:
- Do NOT default to generic gifts (mugs, candles, gift cards, generic stationery, "spa day", socks, water bottles) unless the interests or style explicitly point to them.
- Do NOT name specific commercial brands or push particular products like an advertisement — describe the gift concept plainly.
- Every single idea must clearly trace back to a specific interest, style tag, or relationship detail listed above. No filler idea that could apply to literally anyone.
- If interests are sparse, lean harder on the relationship and style vibe rather than falling back to generic ideas — say something a real friend would think of, not a safe default.
- Tone: plain and honest, like thinking out loud with a friend. Not persuasive, not salesy.

Suggest exactly 5 ideas, varying price point within the budget. For each: a short concrete description, and one sentence explaining which specific detail above it connects to.

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{"ideas":[{"text":"string","reason":"string"}]}`;

  const attempts = [];
  for (const model of MODELS) {
    const result = await tryModel(model, apiKey, prompt);
    attempts.push(result);
    if (result.ok) {
      res.status(200).json({ ideas: result.ideas, modelUsed: result.model });
      return;
    }
    // Don't bother trying the next model if it's a quota/auth problem —
    // it'll almost certainly fail the same way (same key, same project).
    if (result.isQuota || result.status === 401 || result.status === 403) {
      break;
    }
  }

  const last = attempts[attempts.length - 1];
  console.error('All Gemini attempts failed:', JSON.stringify(attempts));

  if (last && last.isQuota) {
    res.status(429).json({
      error:
        "Gemini free-tier daily quota is used up for this API key's project. This can happen fast if the same key/project is shared with another app (e.g. the bill splitter's receipt scanner). Wait for the daily reset, or create a key under a separate Google Cloud project.",
    });
    return;
  }

  res.status(last ? last.status || 500 : 500).json({
    error: last ? `${last.model}: ${last.message}` : 'Unknown error — no model attempts recorded',
  });
}
