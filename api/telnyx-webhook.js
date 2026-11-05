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

    let rawTo = body.To || body.to || body.data?.payload?.to || "";
    let myTelnyxNumber = rawTo.startsWith('+') ? rawTo : (rawTo ? `+${rawTo}` : null);

    let forwardNumber = null;

    if (myTelnyxNumber) {
      try {
        const queryUrl = `${SUPABASE_BASE_URL}/rest/v1/clients?telnyx_number=eq.${encodeURIComponent(myTelnyxNumber)}&select=forward_number`;
        
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
          if (rows && rows.length > 0 && rows[0].forward_number) {
            forwardNumber = rows[0].forward_number;
          }
        }
      } catch (dbErr) {
        console.error('Database error:', dbErr.message);
      }
    }

    res.setHeader('Content-Type', 'text/xml');

    if (forwardNumber && myTelnyxNumber) {
      // Passing callerId prevents carriers from flagging the outbound leg as unverified
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for reaching out! Connecting you to our team now.</Say>
    <Dial timeout="20" callerId="${myTelnyxNumber}">${forwardNumber}</Dial>
</Response>`);
    } else {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for reaching out to us! We will have a team member with you shortly to address the problem.</Say>
    <Hangup />
</Response>`);
    }

  } catch (error) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for reaching out to us! We will have a team member with you shortly to address the problem.</Say>
    <Hangup />
</Response>`);
  }
}