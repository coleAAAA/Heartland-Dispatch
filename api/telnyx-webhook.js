export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const MY_MOBILE_PHONE = process.env.MY_MOBILE_PHONE;

  // Always force XML response headers for Telnyx TeXML
  res.setHeader('Content-Type', 'text/xml');
  const rejectXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Reject />
</Response>`;

  // 1. Handle Inbound Call (Form Data or JSON Payload)
  const customerPhone = req.body?.From || req.body?.from || req.body?.data?.payload?.from;
  const myTelnyxNumber = req.body?.To || req.body?.to || req.body?.data?.payload?.to;
  const eventType = req.body?.data?.event_type;

  // Handle forward of inbound SMS text replies
  if (eventType === 'message.received') {
    const textMsg = req.body?.data?.payload?.text;
    const sender = req.body?.data?.payload?.from;
    const recipient = req.body?.data?.payload?.to;

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

  // 2. Trigger Missed-Call Automated Text
  if (customerPhone && myTelnyxNumber) {
    fetch('https://api.telnyx.com/v2/messages', {
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
    }).catch(err => console.error('Telnyx SMS Trigger Error:', err.message));
  }

  // Always return valid TeXML to drop the call gracefully
  return res.status(200).send(rejectXml);
}