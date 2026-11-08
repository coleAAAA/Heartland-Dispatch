// api/stripe-webhook.js
// Stripe -> Supabase. Activates a signup when checkout completes (and emails a welcome message with setup steps),
// suspends/reactivates on subscription changes.
// No extra npm packages needed beyond "resend": the signature check uses Node's built-in crypto.
//
// Optional environment variables:
//   OWNER_EMAIL    your email. Gets a message if an activation fails (so a paying customer is never left waiting).
//   SUPPORT_EMAIL  shown in the welcome email (defaults to coleeritter@gmail.com)
//   RESEND_FROM    verified sender, e.g. Heartland Dispatch <dispatch@heartlanddispatch.app>

import crypto from 'node:crypto';
import { Resend } from 'resend';

// Stripe's signature needs the RAW body, so turn off Vercel's body parser
export const config = {
  api: {
    bodyParser: false,
  },
};

const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
const DISPATCH_NUMBER_PRETTY = '615-640-8506';
const SUPPORT_DEFAULT = 'coleeritter@gmail.com';
const BILLING_URL = 'https://billing.stripe.com/p/login/14AfZ94a49dg9bkcmA0sU00'; // Stripe customer portal: cancel / update card

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const prettyPhone = (s) => {
  const d = last10(s);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : String(s || '');
};

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verifies the "Stripe-Signature" header (HMAC-SHA256 of "<timestamp>.<raw body>")
function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map((p) => p.split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest();

  return signatures.some((sig) => {
    const buf = Buffer.from(sig, 'hex');
    return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
  });
}

const dbKey = () => process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function db(method, filter, fields, extra = {}) {
  const url = new URL(`${SUPABASE_BASE_URL}/rest/v1/clients`);
  for (const [k, v] of Object.entries(filter)) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      apikey: dbKey(),
      Authorization: `Bearer ${dbKey()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: fields ? JSON.stringify(fields) : undefined,
    signal: AbortSignal.timeout(8000),
    ...extra,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} failed ${r.status}: ${text}`);
  return JSON.parse(text);
}
const patchClients = (filter, fields) => db('PATCH', filter, fields);
const getClients = (filter) => db('GET', { select: '*', ...filter });

async function sendMail({ to, subject, text, html, replyTo }) {
  if (!process.env.RESEND_API_KEY || !to) return { ok: false };
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
      return { ok: false };
    }
    console.log('RESEND OK:', data?.id);
    return { ok: true };
  } catch (e) {
    console.error('RESEND THROW:', e.message);
    return { ok: false };
  }
}

async function alertOwner(subject, detail) {
  if (!process.env.OWNER_EMAIL) return;
  await sendMail({ to: process.env.OWNER_EMAIL, subject: `⚠️ ${subject}`, text: String(detail).slice(0, 3000) });
}

// The first email a new customer gets: short, one job (finish setup), one thing to copy.
async function sendWelcome(row) {
  const support = process.env.SUPPORT_EMAIL || SUPPORT_DEFAULT;
  const name = row.client_name || 'your company';
  const mainPhone = prettyPhone(row.contractor_phone);
  const line = `For emergencies, call ${DISPATCH_NUMBER_PRETTY} and enter our number: ${mainPhone}`;

  const text = `You're live, ${name}.

Your 10-day free trial has started. Emergency calls are now covered.

DO THIS NEXT (2 minutes):
1. Add this line to your voicemail greeting and your website:
   "${line}"
2. Test it: call ${DISPATCH_NUMBER_PRETTY} from a different phone, enter ${last10(row.contractor_phone)}, and leave a message. You should get a phone call and an email shortly after.
3. Keep our emails in your inbox: if this landed in Promotions, Spam or All Mail, drag it to your Primary tab and add dispatch@heartlanddispatch.app to your contacts. Your emergency alerts come from that same address.
4. Reply to this email if anything looks wrong. A real person reads it.

Cancel or update your card any time: ${BILLING_URL}

Support: ${support}`;

  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 540px; padding: 24px; color: #111;">
    <h2 style="margin: 0 0 6px;">You're live, ${esc(name)}.</h2>
    <p style="margin: 0 0 20px; color: #444;">Your 10-day free trial has started. Emergency calls are now covered.</p>
    <p style="margin: 0 0 6px; font-weight: bold;">1. Add this line to your voicemail greeting and website</p>
    <p style="margin: 0 0 20px; padding: 14px; background: #f3f3f3; border-left: 4px solid #000; font-size: 16px;">${esc(line)}</p>
    <p style="margin: 0 0 6px; font-weight: bold;">2. Test it (about a minute)</p>
    <p style="margin: 0 0 20px; color: #333;">Call <strong>${esc(DISPATCH_NUMBER_PRETTY)}</strong> from a different phone, enter <strong>${esc(
      last10(row.contractor_phone)
    )}</strong>, and leave a message. You should get a phone call and an email shortly after.</p>
    <p style="margin: 0 0 6px; font-weight: bold;">3. Keep our emails in your inbox</p>
    <p style="margin: 0 0 20px; color: #333;">If this email landed in Promotions, Spam or All Mail, drag it to your <strong>Primary</strong> tab and add <strong>dispatch@heartlanddispatch.app</strong> to your contacts. Your emergency alerts come from that same address.</p>
    <p style="margin: 0 0 6px; font-weight: bold;">4. Anything look wrong?</p>
    <p style="margin: 0 0 20px; color: #333;">Just reply to this email. A real person reads it.</p>
    <p style="margin: 0 0 24px; color: #333;">Cancel or update your card any time: <a href="${esc(BILLING_URL)}">manage your billing</a>.</p>
    <p style="color: #777; font-size: 13px; margin: 0;">Support: <a href="mailto:${esc(support)}">${esc(support)}</a></p>
  </div>`;

  return sendMail({ to: row.email, subject: `You're live: add this line to your voicemail`, text, html, replyTo: support });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);

  if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], process.env.STRIPE_SECRET_WEBHOOK_KEY)) {
    console.error('STRIPE: signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  try {
    // 1. Checkout finished (trial started or paid): activate the signup
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const fields = {
        status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
      };
      const canActivate = 'in.(pending,suspended)'; // never touches a row that is already active

      // Also stamp when the trial started (used by the day-7 report). If those columns are missing because the SQL was
      // not run yet, still activate the customer: a paying customer must never be left waiting.
      const activate = async (filter) => {
        try {
          return await patchClients(filter, { ...fields, activated_at: new Date().toISOString(), trial_report_sent_at: null });
        } catch (e) {
          if (/activated_at|trial_report_sent_at|PGRST204/i.test(e.message)) {
            console.error('STRIPE: trial columns missing, activating without them. Run supabase-setup.sql.', e.message);
            return patchClients(filter, fields);
          }
          throw e;
        }
      };

      let rows = [];
      if (session.client_reference_id && UUID_RE.test(session.client_reference_id)) {
        rows = await activate({ id: `eq.${session.client_reference_id}`, status: canActivate });
      }
      if (rows.length === 0) {
        // Fallback: match the pending signup by the email used at checkout
        const email = String(session.customer_details?.email || session.customer_email || '')
          .trim()
          .toLowerCase();
        if (email) rows = await activate({ email: `eq.${email}`, status: 'eq.pending' });
      }

      if (rows.length === 0) {
        // Stripe re-sends events. If this customer is already active, this is a repeat: succeed quietly.
        const already = session.customer ? await getClients({ stripe_customer_id: `eq.${session.customer}`, status: 'eq.active', limit: '1' }) : [];
        if (already.length > 0) {
          console.log('STRIPE: repeat event, already active:', session.customer);
        } else {
          // Throwing returns 500, so Stripe retries and the failure shows up in the Stripe dashboard
          throw new Error(`No pending signup found for checkout session ${session.id}`);
        }
      } else {
        console.log('STRIPE: activated', rows.length, 'row(s) for customer', session.customer);
        // Welcome email (never blocks activation, and never throws)
        for (const row of rows) await sendWelcome(row);
      }
    }

    // 2. Subscription changed or ended: suspend / reactivate
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      let newStatus = null;

      if (event.type === 'customer.subscription.deleted') newStatus = 'suspended';
      else if (['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(sub.status)) newStatus = 'suspended';
      else if (['active', 'trialing'].includes(sub.status)) newStatus = 'active';
      // "past_due" is a grace period while Stripe retries the card: leave the line working

      if (newStatus && sub.customer) {
        const rows = await patchClients({ stripe_customer_id: `eq.${sub.customer}` }, { status: newStatus });
        console.log('STRIPE: set', newStatus, 'on', rows.length, 'row(s) for customer', sub.customer);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('STRIPE WEBHOOK PROCESSING ERROR:', err.message);
    await alertOwner('Heartland Dispatch: Stripe event failed', `${event?.type}\n${err.message}`);
    return res.status(500).send('Processing error');
  }
}
