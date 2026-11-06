import { Resend } from 'resend';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  try {
    // 1. Foolproof URL and Body Parameter Extraction
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host || 'heartlanddispatch-gamma.vercel.app';
    const parsedUrl = new URL(req.url || '', `${protocol}://${host}`);
    
    const queryStep = parsedUrl.searchParams.get('step') || '';
    const queryDigits = parsedUrl.searchParams.get('digits') || '';

    let body = {};
    if (req.body) {
      if (typeof req.body === 'string') {
        try { body = JSON.parse(req.body); } 
        catch {
          try { body = Object.fromEntries(new URLSearchParams(req.body).entries()); } catch {}
        }
      } else if (Buffer.isBuffer(req.body)) {
        try {
          body = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')).entries());
        } catch {}
      } else if (typeof req.body === 'object') {
        body = req.body;
      }
    }

    const currentStep = queryStep || body.step || '';
    const rawTo = body.To || body.to || '';
    const callerNumber = body.From || body.from || 'Unknown Caller';
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : '+16155550199');
    const recordingUrl = body.RecordingUrl || body.recording_url || '';

    const rawDigits = queryDigits || body.Digits || body.digits || '';
    const cleanDigits = String(rawDigits).replace(/\D/g, '');

    console.log(`[CALL PIPELINE] Step: "${currentStep}" | Digits: "${cleanDigits}" | Caller: "${callerNumber}"`);

    const SUPABASE_BASE_URL = 'https://oexjbmllasslcxfqprlq.supabase.co';
    const SUPABASE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const validateUrl = `https://${host}/api/telnyx-webhook?step=validate`;

    // 2. Bulletproof Supabase Lookup with Strict 3-Second Timeout
    async function getContractor(targetDigits) {
      if (!targetDigits || !SUPABASE_KEY) return null;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      try {
        const response = await fetch(`${SUPABASE_BASE_URL}/rest/v1/clients?select=*`, {
          method: 'GET',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) return null;
        const rows = await response.json();
        if (!rows || rows.length === 0) return null;

        return rows.find(r => {
          const dbClean = String(r.contractor_phone || '').replace(/\D/g, '');
          return dbClean === targetDigits || dbClean.endsWith(targetDigits) || targetDigits.endsWith(dbClean);
        }) || null;
      } catch (err) {
        clearTimeout(timeoutId);
        console.error('[SUPABASE TIMEOUT/ERROR]', err);
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

      const contractor = await getContractor(cleanDigits);
      if (contractor) {
        forwardNumber = contractor.forward_number || contractor.contractor_phone || null;
        contractorEmail = contractor.email || null;
        clientName = contractor.client_name || 'Contractor';
        console.log(`[ROUTE] Matched Contractor: ${clientName} | Forward: ${forwardNumber} | Email: ${contractorEmail}`);
      } else {
        console.warn(`[ROUTE] No contractor match found for digits: ${cleanDigits}`);
      }

      // Deliver Resend Email (Non-fatal)
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
          console.log('[RESEND] Email sent successfully.');
        } catch (mailErr) {
          console.error('[RESEND ERROR]', mailErr);
        }
      }

      // Telnyx Outbound Call (Non-fatal)
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
              webhook_url: `https://${host}/api/telnyx-webhook?step=outbound_alert`
            })
          });
          console.log(`[TELNYX] Outbound call placed to ${cleanTo}`);
        } catch (outboundErr) {
          console.error('[TELNYX OUTBOUND ERROR]', outboundErr);
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

      if (cleanDigits.length >= 10 && SUPABASE_KEY) {
        const contractor = await getContractor(cleanDigits);
        if (contractor) {
          contractorExists = true;
        }
      }

      // If invalid/not found, present retry gather prompt cleanly
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

      // Successful validation: Play legal disclosure and trigger recording with digits passed in query string
      const recordCallbackUrl = `https://${host}/api/telnyx-webhook?step=route&digits=${cleanDigits}`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Please note, this emergency message will be recorded and dispatched to your contractor. Please summarize your situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7" playBeep="true" />
    <Say voice="alice">Processing your transmission.</Say>
</Response>`);
    }

    // ------------------------------------------------------------------
    // STEP 1: Initial Inbound Greeting
    // ------------------------------------------------------------------
    const initialGatherUrl = `https://${host}/api/telnyx-webhook?step=validate`;
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${initialGatherUrl}" method="POST" numDigits="10" timeout="15">
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