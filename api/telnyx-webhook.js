// api/telnyx-webhook.js
// Heartland Dispatch call flow (Telnyx TeXML). Callers dial the dispatch number, enter a contractor's phone number,
// leave a message, and the contractor is alerted by phone + email.
//
// Optional environment variables (the flow works without them):
//   WEBHOOK_SECRET        any long random string. Signs the internal URLs so nobody else can trigger alerts. RECOMMENDED.
//   OWNER_EMAIL           your email. Gets a message whenever a call fails. RECOMMENDED.
//   ENABLE_TRANSCRIPTION  set to "true" to try Telnyx transcription (off by default).
//   RESEND_FROM           verified sender, e.g. Heartland Dispatch <dispatch@heartlanddispatch.app>

import crypto from 'node:crypto';
import { Resend } from 'resend';

const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";

// ---------- small helpers ----------
const xml = (inner) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${inner}
</Response>`;

// Escape text going into XML / HTML (a raw "&" in a URL or company name breaks TeXML)
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const toE164 = (s) => {
  const d = last10(s);
  return d.length === 10 ? `+1${d}` : null;
};
const pretty = (s) => {
  const d = last10(s);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : 'an unknown number';
};
const spokenDigits = (s) => last10(s).split('').join(', ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (...vals) => vals.find((v) => typeof v === 'string' && v.trim() !== '') || '';

// Demo line. When a prospect enters this number they hear the contractor's alert played back INSIDE their own call, so nothing
// rings and nobody has to be awake. You just get an email with their number as a lead. Change it with DEMO_NUMBER in Vercel.
const DEMO_DIGITS = last10(process.env.DEMO_NUMBER) || '3024390062';

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// ---------- signed URLs (stops strangers from forging "message recorded" requests) ----------
const secret = () => process.env.WEBHOOK_SECRET || '';
const sign = (...parts) =>
  secret() ? crypto.createHmac('sha256', secret()).update(parts.join('|')).digest('hex').slice(0, 24) : '';
const sigOk = (given, ...parts) => {
  if (!secret()) return true; // not configured: allowed, but logged in the route step
  const expected = sign(...parts);
  const g = String(given || '');
  return g.length === expected.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(expected));
};

// ---------- database ----------
const dbKey = () => process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbFetch = (url, opts = {}) =>
  fetch(url, {
    ...opts,
    headers: {
      apikey: dbKey(),
      Authorization: `Bearer ${dbKey()}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(3000),
  });

// Returns the matching ACTIVE client, or null. Any phone number registered on the account works
// (primary or backup). THROWS if the database call itself fails.
async function findClient(digits) {
  if (digits.length !== 10) return null;
  const url = new URL(`${SUPABASE_BASE_URL}/rest/v1/clients`);
  url.searchParams.set('select', 'id,forward_number,email,client_name,contractor_phone');
  url.searchParams.set('or', `(contractor_phone.ilike.*${digits}*,forward_number.ilike.*${digits}*)`);
  url.searchParams.set('status', 'eq.active'); // suspended or unpaid signups don't get service
  url.searchParams.set('limit', '5');

  const dbRes = await dbFetch(url);
  const text = await dbRes.text();
  console.log('SUPABASE', dbRes.status, text);
  if (!dbRes.ok) throw new Error(`Supabase lookup failed with status ${dbRes.status}`);
  const rows = JSON.parse(text);
  // If a number somehow appears on two accounts, the account whose MAIN number it is wins.
  return rows.find((r) => last10(r.contractor_phone) === digits) || rows[0] || null;
}

// Call log. Doubles as a duplicate guard: each CallSid can be "claimed" once.
// Returns 'claimed', 'duplicate' or 'unknown' (log table missing or unreachable). Never throws.
async function claimCall(callSid, row) {
  if (!callSid) return 'unknown';
  try {
    const url = new URL(`${SUPABASE_BASE_URL}/rest/v1/calls`);
    url.searchParams.set('on_conflict', 'call_sid');
    const r = await dbFetch(url, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ call_sid: callSid, ...row }),
    });
    const t = await r.text();
    if (!r.ok) {
      console.error('CALL LOG UNAVAILABLE', r.status, t.slice(0, 200));
      return 'unknown';
    }
    return JSON.parse(t).length ? 'claimed' : 'duplicate';
  } catch (e) {
    console.error('CALL LOG ERROR', e.message);
    return 'unknown';
  }
}

async function updateCall(callSid, fields) {
  if (!callSid) return;
  try {
    const url = new URL(`${SUPABASE_BASE_URL}/rest/v1/calls`);
    url.searchParams.set('call_sid', `eq.${callSid}`);
    await dbFetch(url, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(fields) });
  } catch (e) {
    console.error('CALL LOG UPDATE ERROR', e.message);
  }
}

// ---------- notify you when something breaks ----------
async function alertOwner(subject, detail) {
  const to = process.env.OWNER_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) return;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await withTimeout(
      resend.emails.send({
        from: process.env.RESEND_FROM || 'Heartland Dispatch <onboarding@resend.dev>',
        to,
        subject: `⚠️ ${subject}`,
        text: String(detail || '').slice(0, 3000),
      }),
      6000,
      'owner alert'
    );
  } catch (e) {
    console.error('OWNER ALERT FAILED:', e.message);
  }
}

// ---------- what callers hear (kept short on purpose) ----------
const SAY = {
  first:
    'Heartland Dispatch emergency line. If anyone is in danger, hang up and dial 9 1 1. Otherwise, enter the 10 digit phone number of the contractor you called.',
  noInput: 'Sorry, I did not catch that. Please enter the 10 digit phone number of the contractor you called.',
  badLength: 'That was not 10 digits. Please enter all 10 digits again, from the beginning.',
  notFound: 'We could not find that number. Please enter all 10 digits again, from the beginning.',
  again: 'No problem. Please enter all 10 digits again, from the beginning.',
  record:
    'This call is recorded, and by staying on the line you agree to that. After the beep, say your name, your phone number, your address, and what is wrong. Press any key when you are done.',
  demoRecord:
    'Welcome to the demo. This call is recorded, and by staying on the line you agree to that. After the beep, pretend you are a customer with an emergency. Say what is wrong, then press any key and stay on the line. You will hear exactly what the contractor gets.',
  silent: 'I did not hear anything. After the beep, please say what is wrong. Press any key when you are done.',
  gaveUpNoInput:
    'We did not get a number. Please call back and try again. If anyone is in danger, hang up and dial 9 1 1.',
  gaveUpNotFound:
    'Sorry, we still could not find that number. Please check it and call back. If anyone is in danger, hang up and dial 9 1 1.',
  failure:
    'We are sorry, our system could not reach the contractor. Please call the contractor directly. If anyone is in danger, hang up and dial 9 1 1.',
};

// One voice for everything. Set TTS_VOICE in Vercel to change it without touching code (for example "alice" to go back to the old one).
const VOICE = process.env.TTS_VOICE || 'Polly.Joanna-Neural';
const say = (text) => `<Say voice="${VOICE}">${text}</Say>`;
const hangupWith = (text) => xml(`${say(text)}\n<Hangup />`);

// ---------- the alert email ----------
function buildAlertEmail({ clientName, prettyCaller, callbackTel, timeStr, recordingUrl, seconds, demo = false }) {
  const length = Number.isFinite(seconds) && seconds > 0 ? ` (${Math.round(seconds)} sec)` : '';
  const text = `${demo ? 'DEMO LEAD: someone just tried the demo line. Follow up while it is fresh.' : `Emergency call for ${clientName}.`}\nCaller: ${prettyCaller}\nTime: ${timeStr}\n${
    recordingUrl ? `Listen${length}: ${recordingUrl}` : 'No message was recorded. Call the number above.'
  }\n\nTip: if our alerts land in Promotions, Spam or All Mail, drag one to your Primary tab and add dispatch@heartlanddispatch.app to your contacts.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; padding: 20px;">
      <h2 style="margin: 0 0 8px;">${demo ? '📞 Demo lead' : `🚨 Emergency call for ${esc(clientName)}`}</h2>
      <p style="margin: 0 0 16px; color: #444;">${demo ? 'Someone just tried the demo line. Follow up while it is fresh.' : 'A customer is waiting to hear back. Please call them as soon as you can.'}</p>
      <p style="font-size: 20px; margin: 0 0 4px;"><strong>${esc(prettyCaller)}</strong></p>
      <p style="color: #666; margin: 0 0 16px;">${esc(timeStr)}</p>
      ${
        callbackTel
          ? `<p><a href="tel:${callbackTel}" style="display: inline-block; background: #000; color: #fff; padding: 14px 22px; text-decoration: none; font-weight: bold;">Call back ${esc(prettyCaller)}</a></p>`
          : ''
      }
      ${
        recordingUrl
          ? `<p><a href="${esc(recordingUrl)}" style="display: inline-block; border: 2px solid #000; color: #000; padding: 12px 20px; text-decoration: none; font-weight: bold;">&#9654; Listen to their message${esc(length)}</a></p>`
          : '<p>No message was recorded. Please call the number above.</p>'
      }
      <p style="color: #888; font-size: 12px; margin: 24px 0 0;">Tip: if our alerts land in Promotions, Spam or All Mail, drag one to your Primary tab and add dispatch@heartlanddispatch.app to your contacts.</p>
    </div>`;
  return { text, html };
}

// ---------- keep the recording permanently ----------
// Telnyx's own recording links stop working after 10 minutes. So right after a message is recorded, we copy the audio into a
// storage bucket named "recordings" in Supabase (public bucket, random unguessable file names) and use THAT link in the
// email and the call log. If anything goes wrong we return null and the Telnyx link is used instead (it still works for 10 minutes).
async function saveRecording(recordingUrl) {
  const key = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !recordingUrl) return null;
  const src = await fetch(recordingUrl, { signal: AbortSignal.timeout(3000) });
  if (!src.ok) throw new Error(`download failed ${src.status}`);
  const type = (src.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
  const audio = Buffer.from(await src.arrayBuffer());
  if (audio.length === 0 || audio.length > 10 * 1024 * 1024) throw new Error(`unexpected size ${audio.length}`);
  const ext = /wav/i.test(type) ? 'wav' : 'mp3';
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const up = await fetch(`${SUPABASE_BASE_URL}/storage/v1/object/recordings/${path}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': type, 'x-upsert': 'true' },
    body: audio,
    signal: AbortSignal.timeout(3000),
  });
  if (!up.ok) throw new Error(`upload failed ${up.status}: ${(await up.text()).slice(0, 200)}`);
  return `${SUPABASE_BASE_URL}/storage/v1/object/public/recordings/${path}`;
}

// ---------- alert the contractor (email + every registered phone). Never throws. ----------
async function deliver({ params, digits, rec, baseUrl, mode }) {
  // mode "action": the caller is still on the line (fail open if the call log is unavailable)
  // mode "callback": safety net after a hang-up (only acts when it can prove nobody else already did)
  const realSid = first(params.CallSid, params.call_sid);
  const callSid = params.tok ? `rec:${params.tok}` : realSid; // the dedupe key
  const recordingUrl = first(
    params.RecordingUrl,
    params.recording_url,
    params.data?.payload?.recording_url,
    params.data?.payload?.recording_urls?.mp3
  );
  const callerNumber = first(params.caller, params.From, params.from, params.Caller) || 'Unknown Caller';
  const seconds = Number(params.RecordingDuration);

  const client = await findClient(digits); // throws on database failure; the caller handles it
  if (!client) return { outcome: 'no_client' };

  const claim = await claimCall(callSid, {
    client_id: client.id,
    contractor_phone: digits,
    telnyx_call_sid: realSid || null,
    caller_number: last10(callerNumber) || null,
    recording_url: recordingUrl || null,
    recording_seconds: Number.isFinite(seconds) ? seconds : null,
    outcome: 'processing',
  });
  if (claim === 'duplicate' || (mode === 'callback' && claim !== 'claimed')) {
    console.log('SKIPPING DELIVERY:', mode, claim);
    return { outcome: 'duplicate', clientName: client.client_name };
  }

  const clientName = client.client_name || 'Contractor';
  // Every number on the account (primary + backups) rings. Normalized, de-duplicated, invalid entries dropped.
  // The demo line never rings a phone (the prospect hears the alert inside their own call), so it can stay on overnight.
  const isDemo = digits === DEMO_DIGITS;
  const ringNumbers = isDemo ? [] : [
    ...new Set(
      [client.contractor_phone, ...String(client.forward_number || '').split(',')].map(toE164).filter(Boolean)
    ),
  ];

  const prettyCaller = pretty(callerNumber);
  const timeStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const fromNumber = process.env.TELNYX_FROM_NUMBER || params.To;

  // IMPORTANT: await these. Vercel freezes the function once the response is sent.
  // Each task resolves to { channel, ok }.
  const tasks = [];

  // Copy the recording to permanent storage in the background. The phone alerts start right away with the Telnyx link
  // (they play within seconds); only the email waits for the permanent link, and gives up after 3.5 seconds.
  const savedPromise = recordingUrl
    ? withTimeout(saveRecording(recordingUrl), 3500, 'save recording').catch((e) => {
        console.error('SAVE RECORDING FAILED (using the Telnyx link instead):', e.message);
        return null;
      })
    : Promise.resolve(null);

  const mailTo = isDemo ? first(process.env.OWNER_EMAIL, client.email) : client.email;
  if (mailTo && process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    tasks.push(
      savedPromise
        .then((savedUrl) => {
          const mail = buildAlertEmail({
            clientName,
            prettyCaller,
            callbackTel: toE164(callerNumber),
            timeStr,
            recordingUrl: savedUrl || recordingUrl,
            seconds,
            demo: isDemo,
          });
          return withTimeout(
            resend.emails.send({
              from: process.env.RESEND_FROM || 'Heartland Dispatch <onboarding@resend.dev>',
              to: mailTo,
              subject: isDemo
                ? `📞 Demo lead: ${prettyCaller} just tried the demo line`
                : `🚨 Emergency call from ${prettyCaller} - call back now`,
              text: mail.text,
              html: mail.html,
            }),
            7000,
            'email'
          );
        })
        .then(({ data, error }) => {
          // Resend does NOT throw on API errors; it returns { error }
          if (error) {
            console.error('RESEND ERROR:', JSON.stringify(error));
            return { channel: 'email', ok: false };
          }
          console.log('RESEND OK:', data?.id);
          return { channel: 'email', ok: true };
        })
        .catch((e) => {
          console.error('RESEND THROW:', e.message);
          return { channel: 'email', ok: false };
        })
    );
  } else {
    console.error('Email skipped. email:', client.email, 'hasKey:', !!process.env.RESEND_API_KEY);
  }

  if (ringNumbers.length && process.env.TELNYX_API_KEY && process.env.TELNYX_TEXML_APP_ID) {
    for (const to of ringNumbers) {
      tasks.push(
        fetch(`https://api.telnyx.com/v2/texml/calls/${process.env.TELNYX_TEXML_APP_ID}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            To: to,
            From: fromNumber,
            Url: `${baseUrl}?step=outbound_alert&caller=${encodeURIComponent(callerNumber)}&company=${encodeURIComponent(clientName)}${
              recordingUrl ? `&audio=${encodeURIComponent(recordingUrl)}` : ''
            }`,
          }),
          signal: AbortSignal.timeout(6000),
        })
          .then(async (r) => {
            console.log('TELNYX OUTBOUND', to, r.status, await r.text());
            return { channel: 'phone', ok: r.ok };
          })
          .catch((e) => {
            console.error('TELNYX OUTBOUND THROW', to, e.message);
            return { channel: 'phone', ok: false };
          })
      );
    }
  } else {
    console.error('Outbound calls skipped. ringNumbers:', ringNumbers);
  }

  const results = await Promise.all(tasks);
  const channels = [...new Set(results.filter((r) => r.ok).map((r) => r.channel))];
  const outcome = channels.length ? 'delivered' : 'failed';

  const savedUrl = await savedPromise; // already finished (the email waited for it); null if saving failed

  await Promise.all([
    updateCall(callSid, {
      outcome,
      channels: channels.join('+') || null,
      ...(savedUrl ? { recording_url: savedUrl } : {}), // the day-7 report links to this, so it must be the permanent one
    }),
    outcome === 'failed'
      ? alertOwner(
          'Heartland Dispatch: alert NOT delivered',
          `Contractor: ${clientName} (${digits})\nCaller: ${prettyCaller}\nRecording: ${recordingUrl || 'none'}\nTime: ${timeStr}\nCheck the Vercel logs for RESEND / TELNYX lines.`
        )
      : null,
  ]);

  return { outcome, channels, clientName };
}

// ---------- the demo line: the prospect hears the contractor's alert inside their own call ----------
// Nothing rings and nobody has to be awake. The owner gets the lead by email (see deliver()).
function demoPlayback(params) {
  const spoken = spokenDigits(params.caller || params.From) || 'unknown';
  const audioRaw = first(
    params.RecordingUrl,
    params.recording_url,
    params.data?.payload?.recording_url,
    params.data?.payload?.recording_urls?.mp3
  );
  const audio = /^https:\/\//i.test(audioRaw) ? audioRaw : '';
  return xml(`${say(`Got it. Here is exactly what the contractor hears. The moment a customer finishes leaving a message, the contractor's phone rings with this.`)}
${say(`This is Heartland Dispatch with an emergency call alert for your company. A customer called while you were unavailable. Their number is ${esc(spoken)}. Here is their message.`)}
${audio ? `<Play>${esc(audio)}</Play>` : say('Your recorded message would play here.')}
${say(`That was the message. Their number again is ${esc(spoken)}. The recording also goes to the contractor's email, with a call back button. That is the whole service. To turn it on for your business, use the sign up link in my message. The first 10 days are free. Goodbye.`)}
<Hangup />`);
}

function closingMessage(result) {
  const who = result.clientName ? esc(result.clientName) : 'the contractor';
  const safety = 'If anyone is in danger, hang up and dial 9 1 1. Goodbye.';
  if (result.outcome === 'duplicate') {
    return `Thank you. ${who} has been alerted and will call you back as soon as they can. ${safety}`;
  }
  // Only promise what actually happened
  const how =
    result.channels.includes('phone') && result.channels.includes('email')
      ? 'by phone and email'
      : result.channels.includes('phone')
        ? 'by phone'
        : 'by email';
  return `Thank you. ${who} has been alerted ${how}. They will call you back as soon as they can. ${safety}`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  try {
    // ---------- parse body (JSON, form-encoded, or GET query) ----------
    let body = {};
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch {
        body = Object.fromEntries(new URLSearchParams(req.body));
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    // Merge query + body so it works whether Telnyx uses GET or POST
    const params = { ...req.query, ...body };
    console.log('WEBHOOK PARAMS:', JSON.stringify(params));

    const step = params.step || '';
    const baseUrl = `https://${req.headers.host}/api/telnyx-webhook`;
    const callerDigits = last10(params.caller || params.From);

    // Signed URL for the steps that must not be forgeable
    // "tok" is a random id made for each recording attempt. The hang-up safety net and the normal path both carry it,
    // so we can tell they are the same message without relying on any Telnyx parameter name.
    const signedUrl = (name, digits, rec, tok) => {
      const q = new URLSearchParams({ step: name, contractor: digits, rec: String(rec), tok });
      if (callerDigits) q.set('caller', callerDigits);
      const s = sign(name, digits, rec, tok);
      if (s) q.set('sig', s);
      return `${baseUrl}?${q.toString()}`;
    };

    // Ask for the contractor's number. If nothing is typed, Telnyx falls through to the Redirect (step=noinput).
    const askForNumber = (text, attempt = 1) =>
      xml(`<Gather action="${esc(`${baseUrl}?step=confirm&attempt=${attempt}`)}" method="POST" numDigits="10" timeout="8">
    ${say(text)}
</Gather>
<Redirect method="POST">${esc(`${baseUrl}?step=noinput&attempt=${attempt}`)}</Redirect>`);

    // Prompt + record. "rec" counts recording attempts so a silent caller gets exactly one more chance.
    // Any key ends the recording. The extra callback is a safety net for callers who just hang up.
    const recordXml = (digits, rec, text) => {
      const tok = crypto.randomBytes(8).toString('hex');
      const transcribe =
        process.env.ENABLE_TRANSCRIPTION === 'true'
          ? ` transcription="true" transcriptionCallback="${esc(signedUrl('transcribed', digits, rec, tok))}"`
          : '';
      return xml(`${say(text)}
<Record action="${esc(signedUrl('route', digits, rec, tok))}" method="POST" maxLength="120" timeout="8" finishOnKey="1234567890*#" playBeep="true" recordingStatusCallback="${esc(signedUrl('recorded', digits, rec, tok))}" recordingStatusCallbackMethod="POST"${transcribe} />`);
    };

    // ---------- Status callbacks (fired when a call ends): acknowledge and do nothing ----------
    if (!step && (params.CallbackSource === 'call-progress-events' || params.CallStatus === 'completed')) {
      console.log('STATUS CALLBACK IGNORED:', params.CallStatus);
      return res.status(200).send(xml(''));
    }

    // ---------- Loop guard: never answer a call that came from our own number ----------
    const ownDigits = last10(process.env.TELNYX_FROM_NUMBER);
    if (!step && ownDigits && last10(params.From) === ownDigits) {
      console.error('LOOP GUARD: call from our own number, hanging up');
      return res.status(200).send(xml('<Hangup />'));
    }

    // ---------- outbound_alert: what the contractor hears when they pick up ----------
    if (step === 'outbound_alert') {
      // This plays whether the contractor answers OR it rolls to their voicemail, so it has to make sense on its own.
      const spoken = spokenDigits(params.caller) || 'unknown';
      const company = String(params.company || '').slice(0, 60);
      const intro = company
        ? `This is Heartland Dispatch with an emergency call alert for ${esc(company)}.`
        : 'This is Heartland Dispatch with an emergency call alert.';
      // Play their actual message right on the call (and into voicemail if it rolls there), then repeat the number.
      const audio = /^https:\/\//i.test(String(params.audio || '')) ? String(params.audio) : '';
      const body = audio
        ? `${say(`${intro} A customer called while you were unavailable. Their number is ${esc(spoken)}. Here is their message.`)}
<Play>${esc(audio)}</Play>
${say(`That was the message. Their number again is ${esc(spoken)}. The recording is also in your email. Please call them back as soon as you can. Goodbye.`)}`
        : say(
            `${intro} A customer called while you were unavailable and left a message. Their number is ${esc(spoken)}. Again, ${esc(
              spoken
            )}. The recording was just sent to your email. Please call them back as soon as you can. Goodbye.`
          );
      return res.status(200).send(xml(`${body}\n<Hangup />`));
    }

    // ---------- STEP 4: route (the caller finished recording and is still on the line) ----------
    if (step === 'route') {
      const digits = last10(params.contractor);
      const rec = Number(params.rec) || 1;

      if (!sigOk(params.sig, 'route', digits, rec, String(params.tok || ''))) {
        console.error('BAD SIGNATURE on route');
        return res.status(403).send(xml(''));
      }
      if (!secret()) console.error('WARNING: WEBHOOK_SECRET is not set, so webhook URLs are unsigned.');

      // Caller pressed a key right away or froze: give them one more try. (Skipped if Telnyx sends no duration.)
      const duration = Number(params.RecordingDuration);
      if (Number.isFinite(duration) && duration < 2 && rec < 2 && digits.length === 10) {
        return res.status(200).send(recordXml(digits, rec + 1, SAY.silent));
      }

      // Demo line: email you the lead, then play the contractor's alert back to the caller on this same call. Never rings a phone.
      if (digits === DEMO_DIGITS) {
        try {
          await deliver({ params, digits, rec, baseUrl, mode: 'action' });
        } catch (e) {
          console.error('DEMO DELIVERY FAILED (playing the demo anyway):', e.message);
        }
        return res.status(200).send(demoPlayback(params));
      }

      let result;
      try {
        result = await deliver({ params, digits, rec, baseUrl, mode: 'action' });
      } catch (e) {
        console.error('DELIVERY FAILED:', e.message);
        await alertOwner('Heartland Dispatch: call handling error', `${e.message}\nContractor digits: ${digits}`);
        return res.status(200).send(hangupWith(SAY.failure));
      }
      if (result.outcome === 'no_client') {
        console.error('No active client for digits:', digits);
        return res.status(200).send(hangupWith(SAY.failure));
      }
      if (result.outcome === 'failed') {
        console.error('ALERT NOT DELIVERED ON ANY CHANNEL');
        return res.status(200).send(hangupWith(SAY.failure));
      }
      return res.status(200).send(hangupWith(closingMessage(result)));
    }

    // ---------- recorded: Telnyx says the recording is ready (safety net if the caller hung up) ----------
    if (step === 'recorded') {
      const digits = last10(params.contractor);
      const rec = Number(params.rec) || 1;
      if (!sigOk(params.sig, 'recorded', digits, rec, String(params.tok || ''))) {
        console.error('BAD SIGNATURE on recorded');
        return res.status(403).send(xml(''));
      }

      const status = String(params.RecordingStatus || '').toLowerCase();
      const duration = Number(params.RecordingDuration);
      const hasUrl = !!first(
        params.RecordingUrl,
        params.recording_url,
        params.data?.payload?.recording_url,
        params.data?.payload?.recording_urls?.mp3
      );
      console.log('RECORDING CALLBACK:', JSON.stringify(params).slice(0, 1500));
      if ((status && status !== 'completed') || (Number.isFinite(duration) && duration < 2) || !hasUrl) {
        return res.status(200).send(xml('')); // not a finished, real message
      }

      // Give the normal "action" path a head start. If it already handled this call, the call log says so.
      await sleep(Number(process.env.CALLBACK_DELAY_MS) || 3000);
      try {
        await deliver({ params, digits, rec, baseUrl, mode: 'callback' });
      } catch (e) {
        console.error('CALLBACK DELIVERY FAILED:', e.message);
        await alertOwner('Heartland Dispatch: hang-up delivery error', `${e.message}\nContractor digits: ${digits}`);
      }
      return res.status(200).send(xml(''));
    }

    // ---------- transcribed: optional follow-up email with the message as text ----------
    if (step === 'transcribed') {
      const digits = last10(params.contractor);
      const rec = Number(params.rec) || 1;
      if (!sigOk(params.sig, 'transcribed', digits, rec, String(params.tok || ''))) return res.status(403).send(xml(''));
      console.log('TRANSCRIPTION CALLBACK:', JSON.stringify(params).slice(0, 1500));

      const text = first(
        params.TranscriptionText,
        params.transcription_text,
        params.data?.payload?.transcription_text,
        params.data?.payload?.transcription,
        params.data?.payload?.text
      );
      if (text && process.env.RESEND_API_KEY) {
        try {
          const client = await findClient(digits);
          if (client?.email) {
            const resend = new Resend(process.env.RESEND_API_KEY);
            await withTimeout(
              resend.emails.send({
                from: process.env.RESEND_FROM || 'Heartland Dispatch <onboarding@resend.dev>',
                to: client.email,
                subject: `Message from ${pretty(params.caller)}, as text`,
                text: `What the caller said:\n\n${text}`,
                html: `<div style="font-family: Arial, sans-serif; max-width: 520px; padding: 20px;"><p style="color:#666;margin:0 0 8px;">What the caller said (automatic transcript, may contain mistakes):</p><p style="font-size:16px;line-height:1.5;">${esc(text)}</p></div>`,
              }),
              7000,
              'transcript email'
            );
          }
        } catch (e) {
          console.error('TRANSCRIPT EMAIL FAILED:', e.message);
        }
      }
      return res.status(200).send(xml(''));
    }

    // ---------- noinput: caller typed nothing ----------
    if (step === 'noinput') {
      const attempt = Number(params.attempt) || 1;
      if (attempt >= 2) {
        await claimCall(`${params.CallSid || ''}:gaveup`, { outcome: 'no_input' });
        return res.status(200).send(hangupWith(SAY.gaveUpNoInput));
      }
      return res.status(200).send(askForNumber(SAY.noInput, attempt + 1));
    }

    // ---------- STEP 2: confirm (10 digits received: verify the contractor, say who we found) ----------
    if (step === 'confirm') {
      const attempt = Number(params.attempt) || 1;
      const digits = last10(params.Digits || params.digits);

      // First bad try: ask again. Second bad try: end the call.
      const retryOrEnd = async (text, outcome) => {
        if (attempt >= 2) {
          await claimCall(`${params.CallSid || ''}:gaveup`, { outcome, contractor_phone: digits || null });
          return hangupWith(SAY.gaveUpNotFound);
        }
        return askForNumber(text, attempt + 1);
      };

      if (digits.length !== 10) return res.status(200).send(await retryOrEnd(SAY.badLength, 'bad_number'));

      let client = null;
      try {
        client = await findClient(digits);
      } catch (e) {
        console.error('LOOKUP FAILED:', e.message);
        await alertOwner('Heartland Dispatch: database lookup failed', e.message);
        return res.status(200).send(hangupWith(SAY.failure));
      }
      if (!client) return res.status(200).send(await retryOrEnd(SAY.notFound, 'not_found'));

      const name = client.client_name ? esc(client.client_name) : spokenDigits(digits);
      const recordUrl = `${baseUrl}?step=record&contractor=${digits}`;

      // No button needed to continue: if they press nothing for 3 seconds, we move on. Pressing 2 re-enters.
      return res.status(200).send(
        xml(`<Gather action="${esc(recordUrl)}" method="POST" numDigits="1" timeout="3">
    ${say(`Connecting you to ${name}. If that is not right, press 2.`)}
</Gather>
<Redirect method="POST">${esc(recordUrl)}</Redirect>`)
      );
    }

    // ---------- STEP 3: record ----------
    if (step === 'record') {
      const choice = String(params.Digits || params.digits || '').trim();
      const digits = last10(params.contractor);

      if (digits.length !== 10 || choice === '2') {
        return res.status(200).send(askForNumber(SAY.again, 1));
      }
      return res.status(200).send(recordXml(digits, 1, digits === DEMO_DIGITS ? SAY.demoRecord : SAY.record));
    }

    // ---------- STEP 1: greeting + ask for the contractor's number ----------
    return res.status(200).send(askForNumber(SAY.first, 1));
  } catch (error) {
    console.error('TOP-LEVEL ERROR:', error);
    await alertOwner('Heartland Dispatch: unhandled error in call flow', error?.stack || String(error));
    return res.status(200).send(hangupWith(SAY.failure));
  }
}
