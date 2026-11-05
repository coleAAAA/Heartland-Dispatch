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
    
    // Grab digits passed from query params or request body
    const capturedDigits = body.Digits || body.digits || req.query.digits || "";
    
    const currentStep = req.query.step || body.step || '';
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || body.data?.payload?.recording_urls?.mp3 || "";

    res.setHeader('Content-Type', 'xml');

    // STEP 3: Route call, query Supabase using keypad digits, trigger alerts, and confirm
    const isRouteStep = currentStep === 'route' || Boolean(recordingUrl) || body.CallStatus === 'completed' || (body.RecordingSid);

    if (isRouteStep && currentStep !== 'record') {
      let forwardNumber = null;
      let contractorEmail = null;
      let clientName = "Contractor";

      try {
        // Clean the digits down to just numbers for accurate database matching
        const cleanDigits = String(capturedDigits).replace(/\D/g, '');
        console.log("Querying Supabase for contractor matching keypad digits:", cleanDigits);

        // Query Supabase filtering by the contractor_phone matching the keypad input
        const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?contractor_phone=eq.${cleanDigits}&select=contractor_phone,forward_number,email,client_name&limit=1`;
        
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
            forwardNumber = rows[0].contractor_phone || rows[0].forward_number;
            contractorEmail = rows[0].email;
            clientName = rows[0].client_name || "Contractor";
          } else {
            console.warn("No matching contractor row found in Supabase for digits:", cleanDigits);
          }
        }
      } catch (dbErr) {
        console.error('DB Error:', dbErr);
      }

      // Fallback if Supabase row isn't found
      const targetForwardNumber = forwardNumber || capturedDigits || "+15625089424";
      const targetEmail = contractorEmail || "coleeritter@gmail.com";

      // 1. Explicitly Awaited Email Dispatch to track Resend success/failure in Vercel logs
      if (targetEmail && process.env.RESEND_API_KEY) {
        try {
          console.log("Attempting to send email via Resend to:", targetEmail);
          const resend = new Resend(process.env.RESEND_API_KEY);
          const emailResponse = await resend.emails.send({
            from: 'Heartland Dispatch <onboarding@resend.dev>',
            to: targetEmail,
            subject: `🚨 Emergency Call Alert - Call from ${callerNumber}`,
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #eee;">
                <h2 style="color: #000; text-transform: uppercase;">🚨 New Emergency Call Dispatched</h2>
                <p>Hello <strong>${clientName}</strong>,</p>
                <p>An emergency caller at <strong>${callerNumber}</strong> submitted a secure voice summary.</p>
                <div style="background-color: #f9f9f9; padding: 15px; margin: 15px 0; font-family: monospace;">
                  <p style="margin: 4px 0;"><strong>Caller Phone:</strong> ${callerNumber}</p>
                  <p style="margin: 4px 0;"><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                  ${recordingUrl ? `<p style="margin: 4px 0;"><strong>Voice Summary Audio:</strong> <a href="${recordingUrl}" target="_blank">Listen To Audio Summary</a></p>` : ''}
                </div>
              </div>
            `
          });
          console.log("RESEND API RESPONSE SUCCESS:", JSON.stringify(emailResponse));
        } catch (mailErr) {
          console.error('RESEND API EXCEPTION ERROR:', mailErr);
        }
      } else {
        console.warn("Skipping email: Missing targetEmail or RESEND_API_KEY");
      }

      // 2. Simultaneous Outbound Call Trigger to Contractor via Telnyx API
      if (targetForwardNumber && process.env.TELNYX_API_KEY) {
        try {
          const targetNumber = String(targetForwardNumber).split(',')[0].trim();
          const cleanTo = targetNumber.startsWith('+') ? targetNumber : `+1${targetNumber}`;
          const cleanFrom = masterTelnyxNumber.length > 3 ? masterTelnyxNumber : "+16155550199";

          console.log(`Initiating Telnyx outbound call from ${cleanFrom} to ${cleanTo}`);
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
          console.error('Outbound Init Error:', outboundErr);
        }
      }

      // Pristine, confident customer reassurance confirmation
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Our dispatch network has secured your emergency summary. Perfect! Our team will be with you as soon as possible. Goodbye.</Say>
    <Hangup />
</Response>`);
    }

    // STEP 2: Record prompt (Passes keypad digits forward via query params)
    if (currentStep === 'record' || body.Digits || body.digits) {
      const digitsToPass = body.Digits || body.digits || req.query.digits || "";
      const recordCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=route&digits=${digitsToPass}`;

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
    res.setHeader('Content-Type', 'xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">An error occurred while processing your call. Please try again later.</Say>
    <Hangup />
</Response>`);
  }
}