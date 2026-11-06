import { Resend } from 'resend';

export default async function handler(req, res) {
  // ALWAYS set XML header first so Telnyx TeXML never chokes on responses
  res.setHeader('Content-Type', 'text/xml');

  try {
    let body = {};
    let rawBody = req.body;

    if (Buffer.isBuffer(rawBody)) rawBody = rawBody.toString('utf8');
    
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody);
      } catch (e) {
        try {
          const params = new URLSearchParams(rawBody);
          body = Object.fromEntries(params.entries());
        } catch (err) {
          body = {};
        }
      }
    } else if (rawBody && typeof rawBody === 'object') {
      body = rawBody;
    }

    const query = req.query || {};
    const currentStep = query.step || body.step || '';

    const rawTo = body.To || body.to || body.data?.payload?.to || "";
    const callerNumber = body.From || body.from || body.data?.payload?.from || "Unknown Caller";
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : "+16155550199");
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || body.data?.payload?.recording_urls?.mp3 || "";

    const enteredDigits = query.digits || query.Digits || body.Digits || body.digits || "";
    const cleanDigits = String(enteredDigits).replace(/\D/g, '');

    const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
    const SUPABASE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const hostHeader = req.headers.host || 'heartlanddispatch-gamma.vercel.app';

    // ------------------------------------------------------------------
    // STEP 3: Route Final Call, Deliver Email & Outbound Ring
    // ------------------------------------------------------------------
    if (currentStep === 'route') {
      let forwardNumber = null;
      let contractorEmail = null;
      let clientName = "Contractor";

      if (cleanDigits && SUPABASE_KEY) {
        try {
          const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=forward_number,email,client_name,contractor_phone&contractor_phone=like.*${cleanDigits}*`;
          const dbResponse = await fetch(queryUrl, {
            method: 'GET',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            }
          });

          if (dbResponse.ok) {
            const rows = await dbResponse.json();
            if (rows && rows.length > 0) {
              forwardNumber = rows[0].forward_number || rows[0].contractor_phone || null;
              contractorEmail = rows[0].email || null;
              clientName = rows[0].client_name || "Contractor";
            }
          }
        } catch (dbErr) {
          console.error('DB Fetch Error during routing:', dbErr);
        }
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
          console.error('Resend Error:', mailErr);
        }
      }

      if (forwardNumber && process.env.TELNYX_API_KEY) {
        try {
          const targetNumber = String(forwardNumber).split(',')[0].trim();
          const cleanTo = targetNumber.startsWith('+') ? targetNumber : `+1${targetNumber}`;
          const cleanFrom = masterTelnyxNumber.length > 3 ? masterTelnyxNumber : "+16155550199";

          await fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              connection_id: process.env.TELNYX_CONNECTION_ID || "",
              to: cleanTo,
              from: cleanFrom,
              webhook_url: `https://${hostHeader}/api/telnyx-webhook?step=outbound_alert`
            })
          });
        } catch (outboundErr) {
          console.error('Outbound Call Error:', outboundErr);
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
    if (currentStep === 'validate' || (cleanDigits.length >= 10 && currentStep !== 'record')) {
      let contractorExists = false;

      if (cleanDigits && SUPABASE_KEY) {
        try {
          const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=id&contractor_phone=like.*${cleanDigits}*`;
          const dbResponse = await fetch(queryUrl, {
            method: 'GET',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            }
          });

          if (dbResponse.ok) {
            const rows = await dbResponse.json();
            if (rows && rows.length > 0) {
              contractorExists = true;
            }
          }
        } catch (dbErr) {
          console.error('Database Validation Error:', dbErr);
        }
      }

      if (!contractorExists) {
        const retryGatherUrl = `https://${hostHeader}/api/telnyx-webhook?step=validate`;
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${retryGatherUrl}" method="POST" numDigits="10" timeout="10">
        <Say voice="alice">We could not find an active contractor matching that phone number. Please double check and enter the 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive a valid phone number. Thank you for calling Heartland Dispatch. Goodbye.</Say>
    <Hangup />
</Response>`);
      }

      const recordCallbackUrl = `https://${hostHeader}/api/telnyx-webhook?step=route&digits=${cleanDigits}`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you. Please summarize your emergency situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7" playBeep="true" />
    <Say voice="alice">Processing your transmission.</Say>
</Response>`);
    }

    // ------------------------------------------------------------------
    // STEP 1: Initial Inbound Greeting (Runs immediately when dialed)
    // ------------------------------------------------------------------
    const initialGatherUrl = `https://${hostHeader}/api/telnyx-webhook?step=validate`;
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${initialGatherUrl}" method="POST" numDigits="10" timeout="15">
        <Say voice="alice">Thank you for calling Heartland Dispatch emergency service. Please enter your contractor's 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive any keypad input. Goodbye.</Say>
    <Hangup />
</Response>`);

  } catch (error) {
    console.error('CRITICAL TOP-LEVEL WEBHOOK ERROR:', error);
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">An error occurred while processing your call. Please try again later.</Say>
    <Hangup />
</Response>`);
  }
}