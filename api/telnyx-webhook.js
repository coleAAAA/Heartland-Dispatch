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
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : null);
    
    const currentStep = req.query.step || body.step || '';
    const digitsEntered = body.Digits || body.digits || req.query.digits || "";
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || body.data?.payload?.recording_urls?.mp3 || "";

    res.setHeader('Content-Type', 'text/xml');

    // STEP 4: Final bridge after contractor presses 1 to accept
    if (currentStep === 'connect' || digitsEntered === '1') {
      const dialTarget = req.query.to || body.to || "";
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting you now.</Say>
    <Dial timeout="25" callerId="${masterTelnyxNumber || callerNumber}">${dialTarget}</Dial>
</Response>`);
    }

    // STEP 3: Route call if we have a recording URL or step is explicitly route
    const isRouteStep = currentStep === 'route' || Boolean(recordingUrl) || body.CallStatus === 'completed' || (body.RecordingSid);

    if (isRouteStep && currentStep !== 'record' && currentStep !== 'connect' && !body.Digits) {
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

      if (forwardNumber) {
        if (contractorEmail && process.env.RESEND_API_KEY) {
          try {
            const resend = new Resend(process.env.RESEND_API_KEY);
            await resend.emails.send({
              from: 'Heartland Dispatch <onboarding@resend.dev>',
              to: contractorEmail,
              subject: `🚨 Emergency Call Alert - Call from ${callerNumber}`,
              html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #eee;">
                  <h2 style="color: #000; text-transform: uppercase;">🚨 New Emergency Call Dispatched</h2>
                  <p>Hello <strong>${clientName}</strong>,</p>
                  <p>An emergency caller was just connected to your dispatch line.</p>
                  <div style="background-color: #f9f9f9; padding: 15px; margin: 15px 0; font-family: monospace;">
                    <p style="margin: 4px 0;"><strong>Caller Phone:</strong> ${callerNumber}</p>
                    <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                    ${recordingUrl ? `<p style="margin: 4px 0;"><strong>Voice Summary Audio:</strong> <a href="${recordingUrl}" target="_blank">Listen To Audio Summary</a></p>` : ''}
                  </div>
                </div>
              `
            });
          } catch (emailErr) {
            console.error('Email Error:', emailErr);
          }
        }

        const targetDialNumber = String(forwardNumber).split(',')[0].trim();
        const acceptCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=connect&to=${encodeURIComponent(targetDialNumber)}`;

        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${acceptCallbackUrl}" method="POST" numDigits="1" timeout="10">
        <Say voice="alice">You have an emergency dispatch call. Press 1 to accept.</Say>
    </Gather>
    <Say voice="alice">No response received. Goodbye.</Say>
    <Hangup />
</Response>`);
      } else {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">We could not locate any contractor records in the database. Goodbye.</Say>
    <Hangup />
</Response>`);
      }
    }

    // STEP 2: Record prompt (Triggered after entering contractor number)
    if (currentStep === 'record' || body.Digits || body.digits) {
      const recordCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=route`;

      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you. Please summarize your emergency situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7#" playBeep="true" />
    <Say voice="alice">Connecting your call now.</Say>
</Response>`);
    }

    // STEP 1: Gather Initial Digits
    const gatherCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=record`;

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${gatherCallbackUrl}" method="POST" numDigits="10" timeout="8">
        <Say voice="alice">Thank you for using Heartland Dispatch emergency service. Please enter your contractor's 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive any keypad input. Goodbye.</Say>
    <Hangup />
</Response>`);

  } catch (error) {
    console.error('CRITICAL ERROR:', error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">An error occurred while processing your call. Please try again later.</Say>
    <Hangup />
</Response>`);
  }
}