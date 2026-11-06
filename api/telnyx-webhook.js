import { Resend } from 'resend';

export default async function handler(req, res) {
  // Always return valid XML headers
  res.setHeader('Content-Type', 'text/xml');

  try {
    // 1. Safe Body Parser (Handles both raw JSON and Form URL Encoded without triggering url.parse crashes)
    let body = {};
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        const params = new URLSearchParams(req.body);
        body = Object.fromEntries(params.entries());
      }
    } else if (req.body && typeof req.body === 'object') {
      body = req.body;
    }

    // Extract query or body parameters safely
    const query = req.query || {};
    const currentStep = query.step || body.step || '';
    
    // Safely extract input parameters across Telnyx / TeXML fields
    const rawTo = body.To || body.to || body.data?.payload?.to || "";
    const callerNumber = body.From || body.from || body.data?.payload?.from || "Unknown Caller";
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : "+16155550199");
    
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || body.data?.payload?.recording_urls?.mp3 || "";
    
    // Extract entered digits from Telnyx payload or URL query string
    const enteredDigits = query.digits || body.Digits || body.digits || body.data?.payload?.digits || "";
    const cleanDigits = String(enteredDigits).replace(/\D/g, '');

    const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
    const SUPABASE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    // ------------------------------------------------------------------
    // STEP 3: Route Final Call, Deliver Email Alert & Trigger Outbound Call
    // ------------------------------------------------------------------
    if (currentStep === 'route') {
      let forwardNumber = null;
      let contractorEmail = null;
      let clientName = "Contractor";

      if (cleanDigits && SUPABASE_KEY) {
        try {
          const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=forward_number,email,client_name,contractor_phone&contractor_phone=eq.${cleanDigits}`;
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
              forwardNumber = rows[0].forward_number || rows[0].contractor_phone;
              contractorEmail = rows[0].email;
              clientName = rows[0].client_name || "Contractor";
            }
          }
        } catch (dbErr) {
          console.error('DB Fetch Error during routing:', dbErr);
        }
      }

      // 1. Non-blocking Email Alert via Resend
      if (contractorEmail && process.env.RESEND_API_KEY) {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          resend.emails.send({
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
          }).catch(mailErr => console.error('Background Email Error:', mailErr));
        } catch (emailInitErr) {
          console.error('Resend Init Error:', emailInitErr);
        }
      }

      // 2. Non-blocking Outbound Call via Telnyx Call Control API
      if (forwardNumber && process.env.TELNYX_API_KEY) {
        try {
          const targetNumber = String(forwardNumber).split(',')[0].trim();
          const cleanTo = targetNumber.startsWith('+') ? targetNumber : `+1${targetNumber}`;
          const cleanFrom = masterTelnyxNumber.length > 3 ? masterTelnyxNumber : "+16155550199";

          fetch('https://api.telnyx.com/v2/calls', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              connection_id: process.env.TELNYX_CONNECTION_ID || "",
              to: cleanTo,
              from: cleanFrom,
              webhook_url: `https://${req.headers.host}/api/telnyx-webhook?step=outbound_alert`
            })
          }).catch(telnyxErr => console.error('Background Outbound Call Error:', telnyxErr));
        } catch (outboundErr) {
          console.error('Outbound Call Error:', outboundErr);
        }
      }

      // Final reassurance message played to the caller before hanging up
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Our dispatch network has secured your emergency summary. Perfect! Our team will be with you as soon as possible. Goodbye.</Say>
    <Hangup />
</Response>`);
    }

    // ------------------------------------------------------------------
    // STEP 2: Validate Entered Digits & Prompt For Voice Recording
    // ------------------------------------------------------------------
    if (currentStep === 'validate' || (cleanDigits.length >= 10 && currentStep !== 'record')) {
      let contractorExists = false;

      // Verify if the entered 10 digits match a valid contractor in Supabase
      if (cleanDigits && SUPABASE_KEY) {
        try {
          const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=id&contractor_phone=eq.${cleanDigits}`;
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

      // IF NUMBER IS INVALID / UNMATCHED: Play polite retry message and loop back to Gather
      if (!contractorExists) {
        const retryGatherUrl = `https://${req.headers.host}/api/telnyx-webhook?step=validate`;
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${retryGatherUrl}" method="POST" numDigits="10" timeout="10">
        <Say voice="alice">We could not find an active contractor matching that phone number. Please double check and enter the 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive a valid phone number. Thank you for calling Heartland Dispatch. Goodbye.</Say>
    <Hangup />
</Response>`);
      }

      // IF NUMBER IS VALID: Prompt for Emergency Voice Recording
      const recordCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=route&digits=${cleanDigits}`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you. Please summarize your emergency situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7" playBeep="true" />
    <Say voice="alice">Processing your transmission.</Say>
</Response>`);
    }

    // ------------------------------------------------------------------
    // STEP 1: Initial Inbound Call Greeting & Gather Digits
    // ------------------------------------------------------------------
    const initialGatherUrl = `https://${req.headers.host}/api/telnyx-webhook?step=validate`;
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