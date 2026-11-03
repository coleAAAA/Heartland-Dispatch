import querystring from 'querystring';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const MY_MOBILE_PHONE = process.env.MY_MOBILE_PHONE;

  // 1. Force XML response headers for Telnyx TeXML
  res.setHeader('Content-Type', 'text/xml');
  const rejectXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Reject />
</Response>`;

  // 2. Safely parse body whether it arrives as JSON or Form UrlEncoded
  let parsedBody = req.body || {};
  if (typeof req.body === 'string') {
    try {
      parsedBody = JSON.parse(req.body);
    } catch (e) {
      parsedBody = querystring.parse(req.body);
    }
  }

  // 3. Extract parameters across form-urlencoded and JSON events
  const customerPhone = parsedBody.From || parsedBody.from || parsedBody.data?.payload?.from;
  const myTelnyxNumber = parsedBody.To || parsedBody.to || parsedBody.data?.payload?.to;
  const eventType = parsedBody.data?.event_type;

  // 4. Handle Inbound SMS Forwarding
  if (eventType === 'message.received') {
    const textMsg = parsedBody.data?.payload?.text;
    const sender = parsedBody.data?.payload?.from;
    const recipient = parsedBody.data?.payload?.to;

    if (sender && sender !== MY_MOBILE_PHONE) {
      await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TELNYX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: recipient,
          to: MY_MOBILE_PHONE,
          text: `[NEW LEAD - ${sender}]: ${textMsg}`
        })
      }).catch(err => console.error('SMS Forward Error:', err.message));
    }
    return res.status(200).send(rejectXml);
  }

  // 5. Trigger Missed-Call Automated SMS Text-Back
  if (customerPhone && myTelnyxNumber) {
    try {
      await fetch('https://api.telnyx.com/v2/messages', {
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
    } catch (err) {
      console.error('Telnyx SMS Trigger Error:', err.message);
    }
  }

  // Return valid TeXML to drop the call cleanly
  return res.status(200).send(rejectXml);
}