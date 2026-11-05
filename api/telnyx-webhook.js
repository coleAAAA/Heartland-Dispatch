import { Resend } from 'resend';

// Initialize Resend with your API Key from Vercel Environment Variables
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
    const digitsEntered = body.Digits || body.digits || body.data?.payload?.digits || "";
    
    // Check if this is the callback step after keypad input
    const isRoutingStep = req.query.step === 'route' || Boolean(digitsEntered);

    res.setHeader('Content-Type', 'text/xml');

    // STEP 2: Caller entered the 10-digit contractor phone number
    if (isRoutingStep && digitsEntered) {
      let cleanDigits = digitsEntered.replace(/\D/g, '');
      if (cleanDigits.length === 10) {
        cleanDigits = `+1${cleanDigits}`;
      } else if (!cleanDigits.startsWith('+')) {
        cleanDigits = `+${cleanDigits}`;
      }

      let forwardNumber = null;
      let subscriptionStatus = null;
      let contractorEmail = null;
      let clientName = null;

      try {
        // Query contractor details including email from Supabase
        const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?contractor_phone=eq.${encodeURIComponent(cleanDigits)}&select=forward_number,status,email,client_name`;
        
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
            forwardNumber = rows[0].forward_number;
            subscriptionStatus = rows[0].status;
            contractorEmail = rows[0].email;
            clientName = rows[0].client_name || "Contractor";
          }
        }
      } catch (dbErr) {
        console.error('Database query error:', dbErr.message);
      }

      // Check active subscription status
      if (forwardNumber && subscriptionStatus === 'active') {
        
        // Trigger Instant Auto-Email Alert via Resend
        if (contractorEmail) {
          try {
            await resend.emails.send({
              from: 'Dispatch System <alerts@yourdomain.com>', // Replace with your verified sender domain or resend default
              to: contractorEmail,
              subject: `🚨 Incoming Emergency Dispatch Call - ${callerNumber}`,
              html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                  <h2 style="color: #d9534f;">🚨 New Emergency Call Connected</h2>
                  <p>Hello <strong>${clientName}</strong>,</p>
                  <p>An urgent call was just routed to your mobile dispatch line.</p>
                  <table style="width: 100%; max-width: 400px; border-collapse: collapse; margin: 20px 0;">
                    <tr>
                      <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ccc;">Caller Number:</td>
                      <td style="padding: 8px; border-bottom: 1px solid #ccc;">${callerNumber}</td>
                    </tr>
                    <tr>
                      <td style="padding: 8px; font-weight: bold; border-bottom: 1px solid #ccc;">Time:</td>
                      <td style="padding: 8px; border-bottom: 1px solid #ccc;">${new Date().toLocaleString()}</td>
                    </tr>
                  </table>
                  <p style="font-size: 12px; color: #777;">This automated dispatch notice was sent by your platform.</p>
                </div>
              `
            });
          } catch (emailErr) {
            console.error('Email dispatch failed:', emailErr.message);
          }
        }

        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting you to your contractor now.</Say>
    <Dial timeout="20" callerId="${masterTelnyxNumber}">${forwardNumber}</Dial>
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
    <Say voice="alice">We could not locate a contractor matching that phone number. Please try calling back and re-entering the number. Goodbye.</Say>
    <Hangup />
</Response>`);
      }
    }

    // STEP 1: Initial Inbound Call - Greet caller and gather keypad digits
    const webhookCallbackUrl = `https://${req.headers.host}/api/telnyx-webhook?step=route`;

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather action="${webhookCallbackUrl}" method="POST" numDigits="10" timeout="10">
        <Say voice="alice">Thank you for calling emergency dispatch. Please enter your contractor's 10-digit phone number on your keypad now.</Say>
    </Gather>
    <Say voice="alice">We did not receive any input. Goodbye.</Say>
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