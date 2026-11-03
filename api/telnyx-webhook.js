export default async function handler(req, res) {
  // Always set XML content type immediately for Telnyx TeXML
  res.setHeader('Content-Type', 'text/xml');
  const rejectXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Reject />
</Response>`;

  try {
    console.log('--- NEW TELNYX WEBHOOK REQUEST ---');
    console.log('Method:', req.method);
    console.log('Raw body type:', typeof req.body);
    console.log('Raw body value:', req.body);

    let body = req.body || {};

    // If body arrived as a URL-encoded string or Buffer, parse it cleanly
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        try {
          const params = new URLSearchParams(body);
          body = Object.fromEntries(params.entries());
        } catch (err) {
          console.error('Failed to parse string body:', err.message);
        }
      }
    } else if (Buffer.isBuffer(body)) {
      try {
        const text = body.toString('utf8');
        const params = new URLSearchParams(text);
        body = Object.fromEntries(params.entries());
      } catch (err) {
        console.error('Failed to parse buffer body:', err.message);
      }
    }

    console.log('Parsed body object:', JSON.stringify(body));

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const MY_MOBILE_PHONE = process.env.MY_MOBILE_PHONE;

    // Extract phone numbers across TeXML form fields and JSON event payloads
    const customerPhone = body.From || body.from || body.data?.payload?.from;
    const myTelnyxNumber = body.To || body.to || body.data?.payload?.to;
    const eventType = body.data?.event_type;

    console.log(`Extracted -> From: ${customerPhone} | To: ${myTelnyxNumber} | Event: ${eventType}`);

    // Handle inbound SMS text replies from customers
    if (eventType === 'message.received') {
      const textMsg = body.data?.payload?.text;
      const sender = body.data?.payload?.from;
      const recipient = body.data?.payload?.to;

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
        });
      }
      return res.status(200).send(rejectXml);
    }

    // Trigger the missed-call text-back
    if (customerPhone && myTelnyxNumber) {
      console.log('Sending missed-call SMS to customer:', customerPhone);
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
      console.log('Telnyx SMS API Response:', JSON.stringify(smsData));
    } else {
      console.warn('Skipped SMS: Missing customerPhone or myTelnyxNumber.');
    }

    return res.status(200).send(rejectXml);
  } catch (error) {
    console.error('Critical Webhook Error:', error.message);
    return res.status(200).send(rejectXml);
  }
}