import { Resend } from 'resend';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  try {
    let body = {};
    if (req.body) {
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body);
        } catch (e) {
          try {
            const params = new URLSearchParams(req.body);
            body = Object.fromEntries(params.entries());
          } catch (err) {
            body = {};
          }
        }
      } else if (Buffer.isBuffer(req.body)) {
        try {
          const str = req.body.toString('utf8');
          const params = new URLSearchParams(str);
          body = Object.fromEntries(params.entries());
        } catch (err) {
          body = {};
        }
      } else if (typeof req.body === 'object') {
        body = req.body;
      }
    }

    const query = req.query || {};
    const merged = { ...query, ...body };

    const currentStep = merged.step || '';
    const rawTo = merged.To || merged.to || '';
    const callerNumber = merged.From || merged.from || 'Unknown Caller';
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : '+16155550199');
    const recordingUrl = merged.RecordingUrl || merged.recording_url || merged.recordingUrl || '';

    const rawDigits = merged.digits || merged.Digits || merged.DIGITS || '';
    const cleanDigits = String(rawDigits).replace(/\D/g, '');

    console.log(`[PIPELINE DEBUG] Step: "${currentStep}" | Digits: "${cleanDigits}"`);

    const SUPABASE_BASE_URL = 'https://oexjbmllasslcxfqprlq.supabase.co';
    // Check multiple common Vercel variable naming conventions
    const SUPABASE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    
    console.log(`[SUPABASE CONFIG] URL exists: ${!!SUPABASE_BASE_URL} | Key length: ${SUPABASE_KEY ? SUPABASE_KEY.length : 'MISSING'}`);

    const hostHeader = req.headers.host || 'heartlanddispatch-gamma.vercel.app';
    const validateUrl = `https://${hostHeader}/api/telnyx-webhook?step=validate`;

    // Intelligent JavaScript-side matching with explicit debug logs
    async function smartFindContractor(enteredDigits) {
      if (!enteredDigits) {
        console.log('[SMART FIND] No digits provided to search.');
        return null;
      }
      if (!SUPABASE_KEY) {
        console.error('[SMART FIND ERROR] SUPABASE_KEY is missing in environment variables!');
        return null;
      }

      try {
        const fetchUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=*`;
        console.log(`[SMART FIND] Fetching from Supabase: ${fetchUrl}`);

        const dbResponse = await fetch(fetchUrl, {
          method: 'GET',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        console.log(`[SMART FIND] Supabase Response Status: ${dbResponse.status}`);

        if (!dbResponse.ok) {
          const errText = await dbResponse.text();
          console.error('[SMART FIND] Supabase Error Body:', errText);
          return null;
        }

        const rows = await dbResponse.json();
        console.log(`[SMART FIND] Fetched ${rows ? rows.length : 0} rows from clients table.`);

        if (!rows || rows.length === 0) return null;

        // Log available contractor phones for debugging comparison
        rows.forEach((r, idx) => {
          console.log(`[DB ROW ${idx}] contractor_phone: "${r.contractor_phone}" | cleaned: "${String(r.contractor_phone || '').replace(/\D/g, '')}"`);
        });

        // Match where cleaned database phone matches entered digits
        const match = rows.find(r => {
          const dbClean = String(r.contractor_phone || '').replace(/\D/g, '');
          return dbClean === enteredDigits || dbClean.endsWith(enteredDigits) || enteredDigits.endsWith(dbClean) || dbClean.includes(enteredDigits);
        });

        if (match) {
          console.log('[SMART FIND] MATCH FOUND!', match.client_name);
        } else {
          console.warn('[SMART FIND] NO MATCH found for entered digits:', enteredDigits);
        }

        return match || null;
      } catch (err) {
        console.error('[SMART FIND EXCEPTION]', err);
        return null;
      }
    }

    // ------------------------------------------------------------------
    // STEP 3: Route Final Call, Send Resend Email & Outbound Ring
    // ------------------------------------------------------------------
    if (currentStep === 'route') {
      let forwardNumber = null;
      let contractorEmail = null;
      let clientName = 'Contractor';

      const contractor = await smartFindContractor(cleanDigits);
      if (contractor) {
        forwardNumber = contractor.forward_number || contractor.contractor_phone || null;
        contractorEmail = contractor.email || null;
        clientName = contractor.client_name || 'Contractor';
      }

      if (contractorEmail && contractorEmail !== 'null' && process.env.RESEND_API_KEY) {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: 'Heartland Dispatch <onboarding@resend.dev>',
            to: contractorEmail,
            subject: `🚨 Emergency Call Alert from ${callerNumber}`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #eee;">
                <h2 style="color: #d9534f; text-transform: uppercase;">🚨 Emergency Dispatch Alert</h2>
                <p>Hello <strong>${clientName}</strong>,</p>
                <p>An urgent call was placed to your after-hours dispatch line.</p>
                <div style="background-color: #f9f9f9; padding: 15px; margin: 15px 0; font-family: monospace;">
                  <p style="margin: 4px 0;"><strong>Caller Phone:</strong> ${callerNumber}</p>
                  <p style="margin: 4px 0;"><strong>Keypad Matched:</strong> ${cleanDigits}</p>
                  <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                  ${recordingUrl ? `<p style="margin: 10px 0 4px 0;"><strong>Voice Summary Audio:</strong> <a href="${recordingUrl}" target="_blank" style="color: #0275d8;">Listen To Audio Recording</a></p>` : ''}
                </div>
              </div>
            `
          });
        } catch (mailErr) {
          console.error('[RESEND ERROR]', mailErr);
        }
      }

      if (forwardNumber && process.env.TELNYX_API_KEY) {
        try {
          const targetNumber = String(forwardNumber).split(',')[0].trim();
          const cleanTo = targetNumber.startsWith('+') ? targetNumber : `+1${targetNumber}`;
          const cleanFrom = masterTelnyxNumber.length > 3 ? masterTelnyxNumber : '+16155550199';

          await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              connection_id: process.env.TELNYX_CONNECTION_ID || '',
              to: cleanTo,
              from: cleanFrom,
              webhook_url: `https://${hostHeader}/api/telnyx-webhook?step=outbound_alert`
            })
          });
        } catch (outboundErr) {
          console.error('[OUTBOUND ERROR]', outboundErr);
        }
      }

      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Our dispatch network has secured your emergency summary. Perfect! Our team will be with you as soon as possible. Goodbye.</Say>
    <Hangup />
</Response>`);
    }

    // ------------------------------------------------------------------
    // STEP 2: Validate Digits & Prompt For Voice Recording
    // ------------------------------------------------------------------
    if (currentStep === 'validate' || (cleanDigits.length > 0 && currentStep !== 'record')) {
      let contractorExists = false;

      if (cleanDigits.length >= 10) {
        const contractor = await smartFindContractor(cleanDigits);
        if (contractor) {
          contractorExists = true;
        }
      }

      if (!contractorExists) {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${validateUrl}" method="POST" numDigits="10" timeout="12">
        <Say voice="alice">We could not find an active contractor matching that phone number. Please double check and re-enter the 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive a valid phone number. Thank you for calling Heartland Dispatch. Goodbye.</Say>
    <Hangup />
</Response>`);
      }

      const recordCallbackUrl = `https://${hostHeader}/api/telnyx-webhook?step=route&digits=${cleanDigits}`;
      return res.status(200->send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Please note, this emergency message will be recorded and dispatched to your contractor. Please summarize your situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7" playBeep="true" />
    <Say voice="alice">Processing your transmission.</Say>
</Response>`);
    }

    // ------------------------------------------------------------------
    // STEP 1: Initial Inbound Greeting
    // ------------------------------------------------------------------
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${validateUrl}" method="POST" numDigits="10" timeout="15">
        <Say voice="alice">Thank you for calling Heartland Dispatch emergency service. Please enter your contractor's 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive any keypad input. Thank you for calling Heartland Dispatch. Goodbye.</Say>
    <Hangup />
</Response>`);

  } catch (error) {
    console.error('[CRITICAL WEBHOOK CRASH]', error);
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">An error occurred while processing your call. Please try again later.</Say>
    <Hangup />
</Response>`);
  }
}