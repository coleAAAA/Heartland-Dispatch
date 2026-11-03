export default async function handler(req, res) {
  // Always set XML content type immediately for Telnyx TeXML
  res.setHeader('Content-Type', 'text/xml');
  const normalResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <!-- Allow normal call handling/ringing -->
</Response>`;

  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } 
      catch (e) {
        try { body = Object.fromEntries(new URLSearchParams(body).entries()); } catch (err) {}
      }
    }

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

    // customerPhone is the person who called (+1615...)
    // myTelnyxNumber is your Heartland Dispatch number (+16156408506)
    const customerPhone = body.From || body.from || body.data?.payload?.from;
    const myTelnyxNumber = body.To || body.to || body.data?.payload?.to;

    console.log(`Inbound Call Detected -> From: ${customerPhone} | To: ${myTelnyxNumber}`);

    // Automatically send the SMS text-back to the caller
    if (customerPhone && myTelnyxNumber) {
      console.log(`Sending automated text-back to customer: ${customerPhone}`);
      
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
      console.log('Telnyx SMS Delivery Result:', JSON.stringify(smsData));
    } else {
      console.warn('Could not send SMS: Missing customerPhone or myTelnyxNumber in request payload.');
    }

    return res.status(200).send(normalResponseXml);
  } catch (error) {
    console.error('Webhook Execution Error:', error.message);
    return res.status(200).send(normalResponseXml);
  }
}