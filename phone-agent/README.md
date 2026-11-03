# Free AI phone receptionist for RA Ledger Solutions

Answers calls, handles common questions (services, area, consultation, CPA status) and takes messages.
Messages go to `messages.jsonl` and, optionally, a free ntfy.sh push notification.

**Stack (all free tiers):** Twilio trial number (voice + speech-to-text) → this Node server (no npm deps) → Groq free LLM (Llama 3.1).

## Setup (~15 min)
1. Get a free Groq key: https://console.groq.com
2. Deploy `phone-agent/` on a free host (Render, Railway, Fly) with start command `node server.js`,
   or test locally with `ngrok http 3000`. Set env vars from `.env.example`.
3. Create a Twilio account, get a number, and set **Voice → A call comes in → Webhook (POST)** to `https://YOUR-HOST/voice`.
4. Call it. Optional: forward 646-480-1247 to the Twilio number (carrier "forward when busy/no answer").

## Know the limits of "free"
- Twilio trial: ~US$15 credit, only verified numbers can call in until you upgrade; callers hear a trial notice. A US number is ~$1.15/mo and ~1¢/min after that.
- Free hosts may sleep (first call slow) — use a paid/always-on tier for reliability.
- Groq free tier is rate-limited; on any error the agent falls back to "email us" and hangs up.
- Calls may be recorded/transcribed by providers; if you add recording, follow NY consent rules.
- Edit what the agent may say in `knowledge.js`. It is told never to quote prices or give tax advice.
