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
    
    const currentStep = req.query.step || body.step || '';
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || body.data?.payload?.recording_urls?.mp3 || "";

    res.setHeader('Content-Type', 'text/xml');

    // STEP 3: Route call, trigger email, and deliver flawless AI confirmation
    const isRouteStep = currentStep === 'route' || Boolean(recordingUrl) || body.CallStatus === 'completed' || (body.RecordingSid);

    if (isRouteStep && currentStep !== 'record') {
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
            contractorEmail = rows[0].email;
            clientName = rows[0].client_name || "Contractor";
          }
        }
      } catch (dbErr) {
        console.error('DB Error:', dbErr);
      }

      // Non-blocking email dispatch to coleeritter@gmail.com with audio link
      if (contractorEmail && process.env.RESEND_API_KEY) {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          resend.emails.send({
            from: 'Heartland Dispatch <onboarding@resend.dev>',
            to: contractorEmail,
            subject: `🚨 Emergency Call Alert - Call from ${callerNumber}`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #eee;">
                <h2 style="color: #000; text-transform: uppercase;">🚨 New Emergency Call Dispatched</h2>
                <p>Hello <strong>${clientName}</strong>,</p>
                <p>An emergency caller submitted a secure voice summary.</p>
                <div style="background-color: #f9f9f9; padding: 15px; margin: 15px 0; font-family: monospace;">
                  <p style="margin: 4px 0;"><strong>Caller Phone:</strong> ${callerNumber}</p>
                  <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                  ${recordingUrl ? `<p style="margin: 4px 0;"><strong>Voice Summary Audio:</strong> <a href="${recordingUrl}" target="_blank">Listen To Audio Summary</a></p>` : ''}
                </div>
              </div>
            `
          }).catch(mailErr => console.error('Background Email Error:', mailErr));
        } catch (emailInitErr) {
          console.error('Resend Init Error:', emailInitErr);
        }
      }

      // Pristine, professional confirmation eliminating carrier password prompts forever
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Our dispatch network has secured your emergency summary. Perfect! Our team will be with you soon. Goodbye.</Say>
    <Hangup />
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

    // STEP 1: Gather Initial Digits (18-second relaxed timeout)
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