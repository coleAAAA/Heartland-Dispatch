import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { 
        body = JSON.parse(body); 
      } catch (e) {
        try { 
          body = Object.fromEntries(new URLSearchParams(body).entries()); 
        } catch (err) {}
      }
    }

    const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_s5g6zto95X5OcknvsfTsYg_w_orUPV0";
    
    // Extract call parameters from Telnyx payload
    const rawTo = body.To || body.to || body.data?.payload?.to || "";
    const callerNumber = body.From || body.from || body.data?.payload?.from || "Unknown Caller";
    const masterTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : null);
    
    const currentStep = req.query.step || '';
    const digitsEntered = req.query.digits || body.Digits || body.digits || body.data?.payload?.digits || "";
    const recordingUrl = body.RecordingUrl || body.recording_url || body.data?.payload?.recording_url || "";

    res.setHeader('Content-Type', 'text/xml');

    // STEP 3: Voice summary recorded -> Send Resend Email -> Dial Contractor Line
    if (currentStep === 'route') {
      // Robust Phone Formatting: Extract raw digits and build E.164 (+1) format
      let digitsOnly = digitsEntered.replace(/\D/g, '');
      if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
        digitsOnly = digitsOnly.substring(1);
      }
      
      const formattedE164 = digitsOnly.length === 10 ? `+1${digitsOnly}` : '';

      let forwardNumber = null;
      let subscriptionStatus = null;
      let contractorEmail = null;
      let clientName = null;

      try {
        let queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?select=forward_number,status,email,client_name,contractor_phone`;
        
        if (formattedE164) {
          // Query matching contractor_phone with or without +1
          queryUrl += `&or=(contractor_phone.eq.${encodeURIComponent(formattedE164)},contractor_phone.eq.${encodeURIComponent(digitsOnly)})`;
        } else {
          queryUrl += `&order=id.desc&limit=1`;
        }
        
        const dbResponse = await fetch(queryUrl, {
          method: 'GET',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (dbResponse.ok) {
          const rows = await dbResponse.json();
          if (rows && rows.length > 0) {
            forwardNumber = rows[0].forward_number || rows[0].contractor_phone;
            subscriptionStatus = rows[0].status || 'pending_trial';
            contractorEmail = rows[0].email;
            clientName = rows[0].client_name || "Contractor";
          }
        }
      } catch (dbErr) {
        console.error('Database query error:', dbErr.message);
      }

      if (forwardNumber && (subscriptionStatus === 'active' || subscriptionStatus === 'pending_trial')) {
        
        // Trigger automated email via Resend
        if (contractorEmail) {
          try {
            await resend.emails.send({
              from: process.env.RESEND_FROM_EMAIL || 'Heartland Dispatch <onboarding@resend.dev>',
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
                    ${recordingUrl ? `<p style="margin: 4px 0;"><strong>Voice Summary Audio:</strong> <a href="${recordingUrl}" target="_blank" style="color: #000; text-decoration: underline;">Listen To Audio Summary</a></p>` : ''}
                  </div>
                  
                  <p style="font-size: 11px; color: #888; margin-top: 20px;">Heartland Dispatch Automated System</p>
                </div>
              `
            });
          } catch (emailErr) {
            console.error('Email send error:', emailErr.message);
          }
        }

        const targetDialNumber = forwardNumber.split(',')[0].trim();

        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting you to our on-call team member now.</Say>
    <Dial timeout="25" callerId="${masterTelnyxNumber || callerNumber}">${targetDialNumber}</Dial>
</Response>`);

      } else if (subscriptionStatus === 'suspended' || subscriptionStatus === 'canceled') {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">We are sorry, but this contractor's dispatch service is currently inactive. Goodbye.</Say>
    <Hangup />
</Response>`);
      } else {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">We could not locate a contractor matching that phone number. Goodbye.</Say>
    <Hangup />
</Response>`);
      }
    }

    // STEP 2: Capture emergency voice situation description
    if (currentStep === 'record') {
      const recordCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=route&digits=${encodeURIComponent(digitsEntered)}`;

      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you. Please summarize your emergency situation after the beep, and press 7 when you are finished.</Say>
    <Record action="${recordCallbackUrl}" method="POST" maxLength="45" finishOnKey="7#" playBeep="true" />
    <Say voice="alice">Connecting your call now.</Say>
</Response>`);
    }

    // STEP 1: Initial Inbound Call - Gather keypad input
    const gatherCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=record`;

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${gatherCallbackUrl}" method="POST" numDigits="10" timeout="8">
        <Say voice="alice">Thank you for using Heartland Dispatch emergency service. Our team will be with you shortly. Please enter your contractor's 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive any keypad input. Goodbye.</Say>
    <Hangup />
</Response>`);

  } catch (error) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">An error occurred while processing your call. Please try again later.</Say>
    <Hangup />
</Response>`);
  }
}