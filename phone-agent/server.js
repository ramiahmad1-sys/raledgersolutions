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
// Alert channels. A caller's message is only worth taking if it reaches you, so several are
// supported and every send is retried and logged. Configure at least one.
const ALERT_SMS_TO = process.env.ALERT_SMS_TO;         // your mobile, e.g. +15551234567 (must accept SMS)
const SMS_ACCOUNT_SID = process.env.SMS_ACCOUNT_SID;   // from the Twilio console
const SMS_AUTH_TOKEN = process.env.SMS_AUTH_TOKEN;
const SMS_FROM = process.env.SMS_FROM;                 // a Twilio number on that account
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO;
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'onboarding@resend.dev';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Overridable so the alert path can be exercised without calling the real services.
const TWILIO_API_URL = process.env.TWILIO_API_URL || 'https://api.twilio.com';
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
// fetch() reports every network failure as the bare string "fetch failed"; the real reason is in .cause.
const why = e => [e.message, e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(' - ');

// One alert send: short timeout, a few attempts, and the real reason logged on every failure.
async function deliver(label, url, init, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
      if (res.ok) { console.log(`${label}: delivered (attempt ${i})`); return true; }
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      console.error(`${label}: attempt ${i}/${attempts} failed - HTTP ${res.status} ${detail}`);
      // Bad credentials, a number that cannot receive SMS, an unverified sender: retrying cannot help.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e) {
      console.error(`${label}: attempt ${i}/${attempts} failed - ${why(e)}`);
    }
    if (i < attempts) await sleep(1000 * i);
  }
  console.error(`${label}: NOT DELIVERED`);
  return false;
}

function smsAlert(text) {
  if (!(ALERT_SMS_TO && SMS_ACCOUNT_SID && SMS_AUTH_TOKEN && SMS_FROM)) return null;
  return deliver('SMS alert', `${TWILIO_API_URL}/2010-04-01/Accounts/${encodeURIComponent(SMS_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SMS_ACCOUNT_SID}:${SMS_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: ALERT_SMS_TO, From: SMS_FROM, Body: text }).toString(),
  });
}

function emailAlert(subject, text) {
  if (!(ALERT_EMAIL_TO && RESEND_API_KEY)) return null;
  return deliver('Email alert', RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: ALERT_EMAIL_FROM, to: [ALERT_EMAIL_TO], subject, text }),
  });
}

function ntfyAlert(text) {
  if (!NTFY_TOPIC) return null;
  return deliver('ntfy alert', `${NTFY_URL}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST', headers: { Title: 'New call message' }, body: text,
  });
}

const alertChannels = () => [
  ALERT_SMS_TO && SMS_ACCOUNT_SID && SMS_AUTH_TOKEN && SMS_FROM ? 'SMS' : null,
  ALERT_EMAIL_TO && RESEND_API_KEY ? 'email' : null,
  NTFY_TOPIC ? 'ntfy' : null,
].filter(Boolean);

// Runs in the background: the caller must never wait on an alert, because Twilio
// gives up on the webhook at about 15 seconds and plays an error to them instead.
async function alertAll(rec) {
  const text = `${rec.name} (${rec.phone})\n${rec.reason}`;
  const sent = await Promise.all([
    smsAlert(text), emailAlert(`New call: ${rec.name}`, text), ntfyAlert(text),
  ].filter(Boolean));
  if (!sent.length) console.error('ALERT: no channel configured, so this message reached nobody:', JSON.stringify(rec));
  else if (!sent.some(Boolean)) console.error('ALERT: every channel failed, so this message reached nobody:', JSON.stringify(rec));
}

async function saveMessage(callSid, from, m) {
  const rec = { time: new Date().toISOString(), callSid, callerId: from, ...m };
  // Best effort only: on Render's free tier this file is wiped on every restart and redeploy,
  // so the alert below, not this line, is what actually preserves the message.
  try { fs.appendFileSync(MESSAGES, JSON.stringify(rec) + '\n'); }
  catch (e) { console.error('Could not write messages.jsonl:', e.message); }
  console.log('NEW MESSAGE', rec);
  alertAll(rec).catch(e => console.error('alert dispatch error:', why(e)));
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
      const ch = alertChannels();
      return res.end(`Server: running\nGroq key: ${groq}\nAlert channels: ${ch.length ? ch.join(', ') : 'NONE - callers\' messages would reach nobody'}\nTwilio webhook: <this address>/voice (HTTP POST)`);
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

server.listen(PORT, () => {
  console.log(`Phone agent listening on :${PORT}`);
  const ch = alertChannels();
  if (ch.length) console.log('Alert channels:', ch.join(', '));
  else console.warn('WARNING: no alert channel is configured, so nobody is told when a caller leaves a message. '
    + 'Set ALERT_SMS_TO with SMS_ACCOUNT_SID, SMS_AUTH_TOKEN and SMS_FROM, and/or ALERT_EMAIL_TO with RESEND_API_KEY.');
});
