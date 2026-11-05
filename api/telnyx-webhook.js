import { Resend } from 'resend';

export default async function handler(req, res) {
  try {
    let body = {};
    try {
      if (typeof req.body === 'string') {
        body = JSON.parse(req.body);
      } else if (req.body && typeof req.body === 'object') {
        body = req.body;
      }
    } catch (e) {
      try {
        body = Object.fromEntries(new URLSearchParams(req.body).entries());
      } catch (err) {}
    }

    console.log("TELNYX INCOMING WEBHOOK QUERY:", req.query);
    console.log("TELNYX INCOMING WEBHOOK BODY:", JSON.stringify(body));

    const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
    const SUPABASE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    const rawTo = body.To || body.to || body.data?.payload?.to || "";
    const callerNumber = body.From || body.from || body.data?.payload?.from || "Unknown Caller";
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : "+1" + rawTo);
    
    const currentStep = req.query.step || body.step || '';
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || body.data?.payload?.recording_urls?.mp3 || "";
    const dialCallStatus = body.DialCallStatus || body.dial_call_status || "";

    res.setHeader('Content-Type', 'text/xml');

    // STEP 4: Post-Dial Fallback Handler (Triggers if live dial times out quickly or hits carrier block)
    if (currentStep === 'ended') {
      if (dialCallStatus === 'completed') {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup />
</Response>`);
      }

      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Our dispatch network has secured your emergency summary. Perfect! Our team will be with you as soon as possible. Goodbye.</Say>
    <Hangup />
</Response>`);
    }

    // STEP 3: Route call after recording, trigger email, and attempt live contractor bridge
    const isRouteStep = currentStep === 'route' || Boolean(recordingUrl) || body.CallStatus === 'completed' || (body.RecordingSid);

    if (isRouteStep && currentStep !== 'record' && currentStep !== 'ended') {
      let forwardNumber = null;
      let contractorEmail = null;
      let clientName = "Contractor";

      try {
        const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=forward_number,email,client_name,contractor_phone&limit=1`;
        
        const dbResponse = await fetch(queryUrl, {
          method: 'GET',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const responseText = await dbResponse.text();
        console.log("SUPABASE FETCH RESPONSE:", responseText);

        if (dbResponse.ok) {
          const rows = JSON.parse(responseText);
          if (rows && rows.length > 0) {
            forwardNumber = rows[0].forward_number || rows[0].contractor_phone;
            contractorEmail = rows[0].email;
            clientName = rows[0].client_name || "Contractor";
          }
        }
      } catch (dbErr) {
        console.error('DB Error:', dbErr);
      }

      // Email dispatch to contractor with audio recording link
      if (contractorEmail && process.env.RESEND_API_KEY) {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          const emailResult = await resend.emails.send({
            from: 'Heartland Dispatch <onboarding@resend.dev>',
            to: contractorEmail,
            subject: `🚨 Emergency Call Alert - Call from ${callerNumber}`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #eee;">
                <h2 style="color: #000; text-transform: uppercase;">🚨 New Emergency Call Dispatched</h2>
                <p>Hello <strong>${clientName}</strong>,</p>
                <p>An emergency caller attempted to reach your live dispatch line.</p>
                <div style="background-color: #f9f9f9; padding: 15px; margin: 15px 0; font-family: monospace;">
                  <p style="margin: 4px 0;"><strong>Caller Phone:</strong> ${callerNumber}</p>
                  <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                  ${recordingUrl ? `<p style="margin: 4px 0;"><strong>Voice Summary Audio:</strong> <a href="${recordingUrl}" target="_blank">Listen To Audio Summary</a></p>` : ''}
                </div>
              </div>
            `
          });
          console.log("RESEND EMAIL SUCCESS:", emailResult);
        } catch (mailErr) {
          console.error('Resend Email Error:', mailErr);
        }
      }

      const targetDialNumber = String(forwardNumber).split(',')[0].trim();
      const endCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=ended`;
      const safeCallerId = masterTelnyxNumber.length > 3 ? masterTelnyxNumber : "+18005550199";

      // Ring operator live for 8 seconds using YOUR Telnyx number as callerId to bypass carrier spam filters
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting you to the on-call team now.</Say>
    <Dial timeout="8" callerId="${safeCallerId}" action="${endCallbackUrl}" method="POST">
        <Number>${targetDialNumber}</Number>
    </Dial>
</Response>`);
    }

    // STEP 2: Record prompt
    if (currentStep === 'record' || body.Digits || body.digits) {
      const recordCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=route`;

      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you. Please summarize your emergency situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7#" playBeep="true" />
    <Say voice="alice">Processing your transmission.</Say>
</Response>`);
    }

    // STEP 1: Gather Initial Digits (18-second timeout)
    const gatherCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=record`;

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${gatherCallbackUrl}" method="POST" numDigits="10" timeout="18">
        <Say voice="alice">Thank you for using Heartland Dispatch emergency service. Please enter your contractor's 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive any keypad input. Goodbye.</Say>
    <Hangup />
</Response>`);

  } catch (error) {
    console.error('CRITICAL TOP-LEVEL ERROR:', error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">An error occurred while processing your call. Please try again later.</Say>
    <Hangup />
</Response>`);
  }
}