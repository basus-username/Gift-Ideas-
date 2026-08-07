// Vercel serverless function (Node.js runtime): calls Gemini API for gift ideas.
// Requires env var GEMINI_API_KEY set in Vercel project settings.

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
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

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingLevel: 'MINIMAL' },
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', errText);
      res.status(502).json({ error: 'Gemini API error', detail: errText });
      return;
    }

    const data = await response.json();
    const rawText =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!rawText) {
      console.error('Unexpected Gemini response shape:', JSON.stringify(data));
      res.status(502).json({ error: 'No content returned from model' });
      return;
    }

    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model JSON:', cleaned);
      res.status(502).json({ error: 'Could not parse model response' });
      return;
    }

    if (!parsed.ideas || !Array.isArray(parsed.ideas)) {
      res.status(502).json({ error: 'Malformed ideas list from model' });
      return;
    }

    res.status(200).json({ ideas: parsed.ideas });
  } catch (err) {
    console.error('Function error:', err);
    res.status(500).json({ error: 'Internal error', detail: String(err) });
  }
}
