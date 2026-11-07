// api/save-lead.js
// Called by index.html. Saves the signup as a PENDING row (it only starts working after Stripe confirms payment).
// If the same email submits again before paying, the pending row is UPDATED instead of duplicated.

const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
const DEFAULT_STRIPE_LINK = 'https://buy.stripe.com/14AfZ94a49dg9bkcmA0sU00';

// Returns exactly 10 digits or null
const toPhone = (s) => {
  let d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_ERROR = 'Could not save your details. Please try again, or email support if it keeps happening.';

export default async function handler(req, res) {
  // Same-origin only (index.html and this API live on the same site), so no CORS headers are needed.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    // Hidden "website" field: real people never fill it in, bots do. Pretend it worked.
    if (String(body.website || '').trim() !== '') {
      console.log('save-lead: honeypot hit');
      return res.status(200).json({ success: true });
    }

    // Accept old and new field names
    const clientName = String(body.company_name || body.client_name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const email = String(body.owner_email || body.email || '').trim().toLowerCase().slice(0, 254);
    const primary = toPhone(body.primary_phone || body.contractor_phone);

    if (!clientName) return res.status(400).json({ error: 'Please enter your company name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!primary) {
      return res.status(400).json({ error: 'Please enter your primary phone as 10 digits, like 6155550199.' });
    }

    const rawBackups = Array.isArray(body.backup_phones)
      ? body.backup_phones
      : String(body.forward_number || '').split(',');

    const backups = [];
    for (const raw of rawBackups.filter((v) => String(v ?? '').trim() !== '')) {
      const p = toPhone(raw);
      if (!p) {
        return res
          .status(400)
          .json({ error: `"${String(raw).slice(0, 20)}" is not a valid 10-digit backup number.` });
      }
      if (p !== primary && !backups.includes(p)) backups.push(p);
    }
    if (backups.length > 5) {
      return res.status(400).json({ error: 'You can add up to 5 backup numbers.' });
    }

    const key = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      console.error('save-lead: Supabase key missing');
      return res.status(500).json({ error: 'Server configuration error. Please contact support.' });
    }

    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const table = (params = {}) => {
      const u = new URL(`${SUPABASE_BASE_URL}/rest/v1/clients`);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u;
    };
    const db = (url, opts = {}) => fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) }, signal: AbortSignal.timeout(8000) });

    // 1. Refuse a main number that already belongs to an ACTIVE customer (as a main OR a backup number)
    const conflictRes = await db(
      table({
        select: 'id',
        or: `(contractor_phone.ilike.*${primary}*,forward_number.ilike.*${primary}*)`,
        status: 'eq.active',
        limit: '1',
      })
    );
    if (!conflictRes.ok) {
      console.error('save-lead conflict check failed:', conflictRes.status, await conflictRes.text());
      return res.status(500).json({ error: GENERIC_ERROR });
    }
    if ((await conflictRes.json()).length > 0) {
      return res.status(409).json({
        error: 'That phone number is already registered with Heartland Dispatch. If it is yours, please email support and we will sort it out.',
      });
    }

    // 2. Is there already a PENDING signup with this email? (They are fixing a mistake or came back later.)
    const pendingRes = await db(table({ select: 'id', email: `eq.${email}`, status: 'eq.pending', limit: '1' }));
    if (!pendingRes.ok) {
      console.error('save-lead pending check failed:', pendingRes.status, await pendingRes.text());
      return res.status(500).json({ error: GENERIC_ERROR });
    }
    const pending = await pendingRes.json();

    const payload = {
      client_name: clientName,
      contractor_phone: primary,
      forward_number: backups.join(','),
      email,
      status: 'pending',
    };

    // 3. Update the pending row, or create a new one
    let id;
    if (pending.length > 0) {
      id = pending[0].id;
      const r = await db(table({ id: `eq.${id}` }), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        console.error('save-lead update failed:', r.status, await r.text());
        return res.status(500).json({ error: GENERIC_ERROR });
      }
    } else {
      const r = await db(table(), {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      if (!r.ok) {
        console.error('save-lead insert failed:', r.status, text);
        return res.status(500).json({ error: GENERIC_ERROR });
      }
      id = JSON.parse(text)[0]?.id;
      if (!id) {
        console.error('save-lead: insert returned no id:', text);
        return res.status(500).json({ error: GENERIC_ERROR });
      }
    }

    console.log('LEAD SAVED (pending):', id);

    // 4. Stripe link carries the row id so the Stripe webhook knows which row to activate
    const link = new URL(process.env.STRIPE_PAYMENT_LINK || DEFAULT_STRIPE_LINK);
    link.searchParams.set('client_reference_id', id);
    link.searchParams.set('prefilled_email', email);

    return res.status(200).json({ success: true, id, stripeUrl: link.toString() });
  } catch (error) {
    console.error('Critical save-lead error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}