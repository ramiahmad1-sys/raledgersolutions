// Free AI phone receptionist: Twilio (voice) -> this server -> Groq free LLM.
// Zero npm dependencies. Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SYSTEM = require('./knowledge');

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const NTFY_TOPIC = process.env.NTFY_TOPIC; // optional free push notifications via ntfy.sh
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN; // optional: validates requests really come from Twilio
const PUBLIC_URL = process.env.PUBLIC_URL; // required with TWILIO_AUTH_TOKEN, e.g. https://abc.ngrok-free.app
const MESSAGES = path.join(__dirname, 'messages.jsonl');
const calls = new Map(); // CallSid -> chat history (in memory; fine for a small office)

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function twiml(say, { end = false } = {}) {
  const gather = `<Gather input="speech" action="/respond" method="POST" speechTimeout="auto" language="en-US" actionOnEmptyResult="true">`
    + `<Say voice="Polly.Joanna-Generative">${esc(say)}</Say></Gather>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${
    end ? `<Say voice="Polly.Joanna-Generative">${esc(say)}</Say><Hangup/>` : gather
  }</Response>`;
}

async function think(history) {
  if (!GROQ_KEY) { // no key: still take a message instead of failing
    return { reply: "Thanks for calling RA Ledger Solutions. Please leave your name, number and reason for calling after the tone, or email certifiedacct10@gmail.com. Goodbye.", end: true, message: null };
  }
  const res = await fetch(process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3, max_tokens: 1000, ...(/gpt-oss/.test(MODEL) ? { reasoning_effort: 'low' } : {}),
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, ...history],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function saveMessage(callSid, from, m) {
  const rec = { time: new Date().toISOString(), callSid, callerId: from, ...m };
  fs.appendFileSync(MESSAGES, JSON.stringify(rec) + '\n');
  console.log('NEW MESSAGE', rec);
  if (NTFY_TOPIC) {
    fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST', headers: { Title: 'New call message' },
      body: `${m.name} (${m.phone})\n${m.reason}`,
    }).catch(e => console.error('ntfy failed', e.message));
  }
}

function validSignature(req, params) {
  if (!TWILIO_TOKEN) return true;
  const url = PUBLIC_URL + req.url;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const sig = crypto.createHmac('sha1', TWILIO_TOKEN).update(data).digest('base64');
  const given = String(req.headers['x-twilio-signature'] || '');
  return given.length === sig.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(sig));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    const p = Object.fromEntries(new URLSearchParams(body));
    const send = xml => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); };
    if (req.method === 'GET' && req.url === '/check') {
      let groq = 'missing (add GROQ_API_KEY in Render > Environment)';
      if (GROQ_KEY) {
        try { const r = await think([{ role: 'user', content: 'What services do you offer?' }]); groq = 'working - sample reply: ' + r.reply; }
        catch (e) { groq = 'set but failing: ' + String(e.message).slice(0, 200); }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(`Server: running\nGroq key: ${groq}\nPush notifications (NTFY_TOPIC): ${NTFY_TOPIC ? 'on' : 'off'}\nTwilio webhook: <this address>/voice (HTTP POST)`);
    }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('RA Ledger phone agent is running'); }
    if (!validSignature(req, p)) { res.writeHead(403); return res.end('Forbidden'); }

    const sid = p.CallSid || 'test';
    try {
      if (req.url === '/voice') {
        calls.set(sid, []);
        return send(twiml('Thank you for calling RA Ledger Solutions. I\'m the virtual assistant. How can I help you today?'));
      }
      if (req.url === '/respond') {
        const heard = (p.SpeechResult || '').trim();
        if (!heard) return send(twiml("Sorry, I didn't catch that. Could you say it again?"));
        const history = calls.get(sid) || [];
        history.push({ role: 'user', content: heard });
        const out = await think(history);
        history.push({ role: 'assistant', content: JSON.stringify(out) });
        calls.set(sid, history);
        const m = out.message;
        if (m && m.name && m.phone && m.reason) await saveMessage(sid, p.From, m);
        if (out.end) calls.delete(sid);
        return send(twiml(out.reply, { end: !!out.end }));
      }
      res.writeHead(404); res.end();
    } catch (e) {
      console.error(e);
      send(twiml("I'm sorry, I'm having trouble right now. Please call back or email certifiedacct10@gmail.com. Goodbye.", { end: true }));
    }
  });
});

server.listen(PORT, () => console.log(`Phone agent listening on :${PORT}`));
