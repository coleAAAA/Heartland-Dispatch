export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  
  // TeXML to speak aloud to the caller and then hang up gracefully
  const audioResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">We will be with you shortly.</Say>
    <Hangup />
</Response>`;

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

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const customerPhone = body.From || body.from || body.data?.payload?.from;
    const myTelnyxNumber = body.To || body.to || body.data?.payload?.to;

    // Trigger the automated text-back
    if (customerPhone && myTelnyxNumber) {
      console.log(`Attempting SMS to ${customerPhone} from ${myTelnyxNumber}...`);
      
      const smsRes = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: myTelnyxNumber,
          to: customerPhone,
          text: "Hey, this is Heartland Dispatch! Saw we missed your call. What HVAC/plumbing issue can we help you with right now? Text me details or photos here."
        })
      });

      const smsData = await smsRes.json();
      console.log('Telnyx SMS Response:', JSON.stringify(smsData));
    }

    return res.status(200).send(audioResponseXml);
  } catch (error) {
    console.error('Webhook Error:', error.message);
    return res.status(200).send(audioResponseXml);
  }
}