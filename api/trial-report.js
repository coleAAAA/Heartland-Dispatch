// api/trial-report.js
// Runs once a day (Vercel Cron, see vercel.json). About a week into each customer's trial it emails them an honest
// "here's what your line caught" report, so they see the value before the trial ends and nobody is surprised by the charge.
//
// Environment variables:
//   CRON_SECRET    REQUIRED. Any random string of letters and numbers. Vercel sends it automatically when it runs the job,
//                  and this endpoint refuses everyone else.
//   OWNER_EMAIL    optional. You get a short summary after each run that sent reports (so you can reach out personally).
//   SUPPORT_EMAIL  optional. Shown in the email and used as the reply-to (defaults to coleeritter@gmail.com).
//   RESEND_FROM    verified sender, e.g. Heartland Dispatch <dispatch@heartlanddispatch.app>
//   TRIAL_DAYS     optional, default 10 (must match your Stripe trial length)
//   REPORT_AFTER_DAYS  optional, default 7
//   STRIPE_SECRET_KEY  needed for the automatic trial extension (Stripe -> Developers -> API keys -> Secret key).
//                  Test mode needs the sk_test_ key, live mode needs the sk_live_ key. Without it, the report still goes out
//                  and the email just says "reply and we will extend your trial".
//   EXTEND_DAYS    optional, default 7: how many free days a customer with zero captured calls gets (once)
//   AUTO_EXTEND    optional: set to "false" to turn the automatic extension off

import { Resend } from 'resend';

const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
const DISPATCH_NUMBER_PRETTY = '615-640-8506';
const SUPPORT_DEFAULT = 'coleeritter@gmail.com';
const PRICE = '$250';
const BILLING_URL = 'https://billing.stripe.com/p/login/14AfZ94a49dg9bkcmA0sU00'; // Stripe customer portal: cancel / update card
const TIP =
  'Tip: if our emails land in Promotions, Spam or All Mail, drag one to your Primary tab and add dispatch@heartlanddispatch.app to your contacts so you never miss one.';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 10; // keeps each run well inside Vercel's time limit; anyone left over is picked up tomorrow

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const pretty = (s) => {
  const d = last10(s);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : 'Unknown number';
};
const dashed = (s) => {
  const d = last10(s);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(s || '');
};
const dayStr = (d) => d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric' });
const timeStr = (iso) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const key = () => process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function db(method, table, params, body) {
  const url = new URL(`${SUPABASE_BASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${table} failed ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function sendMail({ to, subject, text, html, replyTo }) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM || 'Heartland Dispatch <onboarding@resend.dev>',
      to,
      subject,
      text,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    if (error) {
      console.error('RESEND ERROR:', JSON.stringify(error));
      return false;
    }
    console.log('RESEND OK:', data?.id);
    return true;
  } catch (e) {
    console.error('RESEND THROW:', e.message);
    return false;
  }
}

// ---------- Stripe: automatic one-time trial extension ----------
async function stripeApi(method, path, form, idempotencyKey) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${method} ${path} failed ${r.status}: ${j?.error?.message || ''}`);
  return j;
}

// Returns the new trial end date if the customer's trial was extended (now or earlier), or null if there was nothing to do.
// Throws if Stripe or the database fails (the caller falls back to the "reply and we will extend" wording).
async function extendTrial(client, extendDays, nowMs) {
  if (!process.env.STRIPE_SECRET_KEY || !client.stripe_subscription_id) return null;

  const sub = await stripeApi('GET', `subscriptions/${client.stripe_subscription_id}`);
  if (sub.status !== 'trialing' || !sub.trial_end) return null; // trial is already over, or this is not a trial: leave it alone

  // Claim the extension first so it can only ever happen once per customer, even if two runs overlap
  const claimed = await db(
    'PATCH',
    'clients',
    { id: `eq.${client.id}`, trial_extended_at: 'is.null' },
    { trial_extended_at: new Date(nowMs).toISOString() }
  );
  if (claimed.length === 0) return new Date(sub.trial_end * 1000); // already extended earlier

  const newEndSec = Math.floor((Math.max(sub.trial_end * 1000, nowMs) + extendDays * DAY_MS) / 1000);
  try {
    await stripeApi(
      'POST',
      `subscriptions/${sub.id}`,
      { trial_end: String(newEndSec), proration_behavior: 'none' },
      `hd-extend-${client.id}`
    );
  } catch (e) {
    // Give the claim back so a later run can try again
    await db('PATCH', 'clients', { id: `eq.${client.id}` }, { trial_extended_at: null }).catch(() => {});
    throw e;
  }
  return new Date(newEndSec * 1000);
}

// ---------- the report email ----------
function buildReport({ client, calls, tests, trialEnd, support, extendedTo, extendDays }) {
  const name = client.client_name || 'your company';
  const myNumber = dashed(client.contractor_phone);
  const line = `For emergencies, call ${DISPATCH_NUMBER_PRETTY} and enter our number: ${myNumber}`;
  const endStr = dayStr(extendedTo || trialEnd);
  const endSentence = `Your free trial ends on ${endStr}. After that it is ${PRICE}/month, charged to the card you gave us at signup.`;
  const cancelSentence = `To cancel or update your card, use ${BILLING_URL} or just reply "cancel". There is no contract.`;

  const n = calls.length;
  const testNote = tests.length
    ? `(We also saw ${tests.length} test call${tests.length === 1 ? '' : 's'} made from your own phone${tests.length === 1 ? '' : 's'}, which ${tests.length === 1 ? 'is' : 'are'} not counted.)`
    : '';

  if (n > 0) {
    const shown = calls.slice(0, 10);
    const subject = `Your first week: ${n} message${n === 1 ? '' : 's'} left on your line`;
    const textRows = shown
      .map((c) => `- ${timeStr(c.created_at)}  ${pretty(c.caller_number)}${c.recording_url ? `  Listen: ${c.recording_url}` : ''}`)
      .join('\n');
    const text = `Hi ${name},

Here is what your Heartland Dispatch line did in its first week.

${n} message${n === 1 ? '' : 's'} left on your line:
${textRows}
${testNote}

If any of these turned into work, that is the line doing its job. If you have not called them back yet, do it now.

${endSentence}
${cancelSentence}

How is it going? Hit reply and tell us. A real person reads every response.

${TIP}

Support: ${support}`;

    const rowsHtml = shown
      .map(
        (c) => `
      <tr>
        <td style="padding:10px 8px;border-top:1px solid #e3e3e3;color:#555;white-space:nowrap;">${esc(timeStr(c.created_at))}</td>
        <td style="padding:10px 8px;border-top:1px solid #e3e3e3;font-weight:bold;">${esc(pretty(c.caller_number))}</td>
        <td style="padding:10px 8px;border-top:1px solid #e3e3e3;text-align:right;">${
          c.recording_url ? `<a href="${esc(c.recording_url)}" style="color:#000;">&#9654; Listen</a>` : ''
        }</td>
      </tr>`
      )
      .join('');
    const html = `
  <div style="font-family: Arial, sans-serif; max-width: 560px; padding: 24px; color: #111;">
    <h2 style="margin: 0 0 6px;">${n} message${n === 1 ? '' : 's'} left on your line this week</h2>
    <p style="margin: 0 0 18px; color: #444;">Here is what your Heartland Dispatch line caught in its first week.</p>
    <table style="width:100%;border-collapse:collapse;font-size:15px;margin:0 0 6px;">${rowsHtml}</table>
    ${testNote ? `<p style="color:#777;font-size:13px;margin:8px 0 0;">${esc(testNote)}</p>` : ''}
    <p style="margin: 20px 0; color:#333;">If any of these turned into work, that is the line doing its job. If you have not called them back yet, do it now.</p>
    <p style="margin: 0 0 6px; color:#333;">${esc(endSentence)}</p>
    <p style="margin: 0 0 20px; color:#333;">To cancel or update your card, <a href="${esc(BILLING_URL)}">manage your billing here</a> or just reply &ldquo;cancel&rdquo;. There is no contract.</p>
    <p style="margin: 0; color:#333;">How is it going? Hit reply and tell us. A real person reads every response.</p>
    <p style="color:#777;font-size:13px;margin:20px 0 0;">${esc(TIP)}</p>
    <p style="color:#777;font-size:13px;margin:8px 0 0;">Support: <a href="mailto:${esc(support)}">${esc(support)}</a></p>
  </div>`;
    return { subject, text, html };
  }

  // No real messages yet: be honest, make sure it is set up, and make the offer.
  const offerText = extendedTo
    ? `Because your line has not caught a real call yet, we extended your free trial by ${extendDays} days at no charge, so you get a fair look at it working. If you would rather cancel, reply "cancel". There is no contract.`
    : `If your line has not caught a real call by then, reply to this email and we will extend your trial until it has. If you would rather cancel, reply "cancel". There is no contract.`;
  const subject = extendedTo
    ? `Your first week: no messages yet, so we extended your trial`
    : `Your first week: no messages yet (here is how to make sure it works)`;
  const text = `Hi ${name},

Nobody has left a message on your Heartland Dispatch line yet. That can simply mean a quiet week. It also means you have not seen it work yet, so here is how to be sure it is ready:

1. Is this line in your voicemail greeting and on your website?
   "${line}"
2. Have you tested it end to end? Call ${DISPATCH_NUMBER_PRETTY} from a different phone, enter ${last10(client.contractor_phone)}, and leave a message. You should get a phone call and an email.
${testNote}

${endSentence}

${offerText}

Manage or cancel any time: ${BILLING_URL}

${TIP}

Support: ${support}`;

  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 560px; padding: 24px; color: #111;">
    <h2 style="margin: 0 0 6px;">No messages yet, and that may just be a quiet week</h2>
    <p style="margin: 0 0 18px; color: #444;">Nobody has left a message on your line yet. It also means you have not seen it work, so here is how to be sure it is ready.</p>
    <p style="margin: 0 0 6px; font-weight: bold;">1. Is this line in your voicemail greeting and on your website?</p>
    <p style="margin: 0 0 18px; padding: 14px; background: #f3f3f3; border-left: 4px solid #000;">${esc(line)}</p>
    <p style="margin: 0 0 6px; font-weight: bold;">2. Have you tested it end to end?</p>
    <p style="margin: 0 0 18px; color:#333;">Call <strong>${esc(DISPATCH_NUMBER_PRETTY)}</strong> from a different phone, enter <strong>${esc(
      last10(client.contractor_phone)
    )}</strong>, and leave a message. You should get a phone call and an email.</p>
    ${testNote ? `<p style="color:#777;font-size:13px;margin:0 0 14px;">${esc(testNote)}</p>` : ''}
    <p style="margin: 0 0 14px; color:#333;">${esc(endSentence)}</p>
    <p style="margin: 0 0 20px; color:#333;"><strong>${esc(offerText.split('. If you would rather')[0])}.</strong> If you would rather cancel, reply &ldquo;cancel&rdquo;. There is no contract.</p>
    <p style="color:#777;font-size:13px;margin:0 0 8px;">Manage or cancel any time: <a href="${esc(BILLING_URL)}">billing page</a>.</p>
    <p style="color:#777;font-size:13px;margin:0 0 8px;">${esc(TIP)}</p>
    <p style="color:#777;font-size:13px;margin:0;">Support: <a href="mailto:${esc(support)}">${esc(support)}</a></p>
  </div>`;
  return { subject, text, html };
}

export default async function handler(req, res) {
  // Only Vercel's scheduler may run this. If CRON_SECRET is not set, nobody can (fail closed).
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    console.error('TRIAL REPORT: unauthorized (is CRON_SECRET set, and did you redeploy after adding it?)');
    return res.status(401).json({ ok: false });
  }

  const support = process.env.SUPPORT_EMAIL || SUPPORT_DEFAULT;
  const trialDays = Number(process.env.TRIAL_DAYS) || 10;
  const afterDays = Number(process.env.REPORT_AFTER_DAYS) || 7;
  const extendDays = Number(process.env.EXTEND_DAYS) || 7;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const summary = { checked: 0, sent: 0, failed: 0, extended: 0 };
  const digest = [];

  try {
    // Active customers who started their trial at least a week ago (but not ages ago), and have not had a report yet.
    const due = await db('GET', 'clients', {
      select: 'id,client_name,email,contractor_phone,forward_number,activated_at,stripe_subscription_id,trial_extended_at',
      status: 'eq.active',
      trial_report_sent_at: 'is.null',
      and: `(activated_at.lte.${iso(now - afterDays * DAY_MS)},activated_at.gte.${iso(now - 30 * DAY_MS)})`,
      order: 'activated_at.asc',
      limit: String(MAX_PER_RUN),
    });
    summary.checked = due.length;

    for (const client of due) {
      try {
        // Claim it first, so two overlapping runs can never send the same report twice.
        const claimed = await db(
          'PATCH',
          'clients',
          { id: `eq.${client.id}`, trial_report_sent_at: 'is.null' },
          { trial_report_sent_at: iso(now) }
        );
        if (claimed.length === 0) continue;

        const rows = await db('GET', 'calls', {
          select: 'created_at,caller_number,recording_url',
          client_id: `eq.${client.id}`,
          outcome: 'eq.delivered',
          created_at: `gte.${client.activated_at}`,
          order: 'created_at.desc',
          limit: '50',
        });

        // Calls made from the customer's own numbers are their tests: show them separately, never as "wins".
        const own = new Set(
          [client.contractor_phone, ...String(client.forward_number || '').split(',')].map(last10).filter(Boolean)
        );
        const calls = rows.filter((c) => !own.has(last10(c.caller_number)));
        const tests = rows.filter((c) => own.has(last10(c.caller_number)));

        const trialEnd = new Date(new Date(client.activated_at).getTime() + trialDays * DAY_MS);

        // Nobody has left a real message yet: give them extra free days automatically (once), so they get a fair look.
        let extendedTo = null;
        let extendNote = '';
        if (calls.length === 0 && process.env.AUTO_EXTEND !== 'false') {
          try {
            extendedTo = await extendTrial(client, extendDays, now);
            if (extendedTo) summary.extended++;
          } catch (e) {
            console.error('TRIAL EXTEND FAILED:', client.id, e.message);
            extendNote = `  (auto-extend FAILED: ${e.message.slice(0, 120)})`;
          }
        }

        const mail = buildReport({ client, calls, tests, trialEnd, support, extendedTo, extendDays });

        const ok = await sendMail({ to: client.email, replyTo: support, ...mail });
        if (!ok) {
          // Put it back so tomorrow's run tries again
          await db('PATCH', 'clients', { id: `eq.${client.id}` }, { trial_report_sent_at: null });
          summary.failed++;
          continue;
        }
        summary.sent++;
        const block = [
          `${client.client_name || '(no name)'}`,
          `Email: ${client.email}   Phone: ${dashed(client.contractor_phone)}`,
          `Real messages: ${calls.length}${tests.length ? `   |   Own-phone tests: ${tests.length}` : ''}`,
          `Trial ends: ${dayStr(extendedTo || trialEnd)}${extendedTo ? ` (auto-extended ${extendDays} days)` : ''}`,
          calls.length === 0
            ? 'Next step: reach out personally this week and help them get the voicemail line in place.'
            : 'Next step: ask how it is going. Good moment to ask for a testimonial.',
        ];
        if (extendNote) block.push(extendNote.trim());
        digest.push(block.join('\n'));
      } catch (e) {
        console.error('TRIAL REPORT customer error:', client.id, e.message);
        summary.failed++;
        try {
          await db('PATCH', 'clients', { id: `eq.${client.id}` }, { trial_report_sent_at: null });
        } catch {
          /* nothing more we can do; next run will see the row either way */
        }
      }
    }

    if (digest.length && process.env.OWNER_EMAIL) {
      await sendMail({
        to: process.env.OWNER_EMAIL,
        subject: `Heartland Dispatch: ${digest.length} trial report${digest.length === 1 ? '' : 's'} sent today`,
        text: digest.join('\n\n-----\n\n'),
      });
    }

    console.log('TRIAL REPORT RUN:', JSON.stringify(summary));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('TRIAL REPORT ERROR:', e.message);
    if (process.env.OWNER_EMAIL) {
      await sendMail({
        to: process.env.OWNER_EMAIL,
        subject: '⚠️ Heartland Dispatch: trial report job failed',
        text: `${e.message}\n\nMost likely the new columns are missing. Run supabase-setup.sql again.`,
      });
    }
    return res.status(500).json({ ok: false });
  }
}
    return res.status(500).json({ ok: false });
  }
}
