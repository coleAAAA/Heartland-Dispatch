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

    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const eventType = body.data?.event_type;

    // --- CASE 1: INBOUND TEXT MESSAGE RECEIVED ---
    if (eventType === 'message.received') {
      const sender = body.data?.payload?.from?.phone_number;
      const recipient = body.data?.payload?.to?.[0]?.phone_number || body.data?.payload?.to;

      console.log(`Inbound SMS received from ${sender} to ${recipient}`);

      if (sender && recipient) {
        // Send automated text reply to the person who texted you
        await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: recipient,
            to: sender,
            text: "Thanks for reaching out to Heartland Dispatch! We received your message and will be with you shortly. Feel free to send details or photos of your HVAC/plumbing issue."
          })
        });
      }
      return res.status(200).json({ status: 'ok' });
    }

    // --- CASE 2: INBOUND CALL RECEIVED ---
    res.setHeader('Content-Type', 'text/xml');
    const audioResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">We will be with you shortly.</Say>
    <Hangup />
</Response>`;

    const customerPhone = body.From || body.from || body.data?.payload?.from;
    const myTelnyxNumber = body.To || body.to || body.data?.payload?.to;

    if (customerPhone && myTelnyxNumber) {
      console.log(`Inbound Call -> Sending missed-call SMS to ${customerPhone} from ${myTelnyxNumber}`);
      
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
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Say voice="alice">We will be with you shortly.</Say><Hangup /></Response>`);
  }
}