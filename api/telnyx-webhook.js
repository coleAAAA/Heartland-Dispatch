// --- FULLY SELF-CONTAINED TELNYX + SUPABASE WEBHOOK HANDLER ---

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

    // Standardize incoming Telnyx number format with leading '+'
    let rawTo = body.To || body.to || body.data?.payload?.to;
    let myTelnyxNumber = rawTo ? (rawTo.startsWith('+') ? rawTo : `+${rawTo}`) : null;
    const customerPhone = body.From || body.from || body.data?.payload?.from;

    console.log(`Inbound Call from ${customerPhone} to Telnyx line ${myTelnyxNumber}`);

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
            console.log(`Found matching forward number: ${forwardNumber}`);
          }
        } else {
          console.error('Supabase REST query failed status:', dbResponse.status);
        }
      } catch (dbErr) {
        console.error('Database fetch error:', dbErr.message);
      }
    }

    res.setHeader('Content-Type', 'text/xml');

    let audioResponseXml = '';

    if (forwardNumber) {
      audioResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for reaching out! Connecting you to our emergency team now.</Say>
    <Dial timeout="20">${forwardNumber}</Dial>
</Response>`;
    } else {
      audioResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for reaching out to us! We will have a team member with you shortly to address the problem.</Say>
    <Hangup />
</Response>`;
    }

    return res.status(200).send(audioResponseXml);

  } catch (error) {
    console.error('Webhook Error:', error.message);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for reaching out to us! We will have a team member with you shortly to address the problem.</Say>
    <Hangup />
</Response>`);
  }
}
}