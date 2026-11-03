export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const MY_MOBILE_PHONE = process.env.MY_MOBILE_PHONE;

  // 1. TeXML Call Handling: Immediately return valid TeXML to reject/hang up call without cost
  const isTeXMLCall = req.body?.CallSid || req.body?.data?.payload?.call_control_id || req.body?.data?.event_type === 'call.initiated';

  if (isTeXMLCall) {
    res.setHeader('Content-Type', 'text/xml');
    const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Reject />
</Response>`;

    const customerPhone = req.body?.From || req.body?.data?.payload?.from;
    const myTelnyxNumber = req.body?.To || req.body?.data?.payload?.to;

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

    return res.status(200).send(xmlResponse);
  }

  // 2. Standard Telnyx Webhooks (Call Progress & SMS Inbound)
  try {
    const event = req.body?.data;
    if (!event) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
    }

    const eventType = event.event_type;

    if (eventType === 'call.hangup') {
      const callStatus = event.payload?.hangup_cause;
      const customerPhone = event.payload?.from;
      const myTelnyxNumber = event.payload?.to;

      if (['ORIGINATOR_CANCEL', 'NORMAL_CLEARING', 'USER_BUSY', 'NO_ANSWER'].includes(callStatus)) {
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
      }
    }

    if (eventType === 'message.received') {
      const customerPhone = event.payload?.from;
      const customerText = event.payload?.text;
      const myTelnyxNumber = event.payload?.to;

      if (customerPhone && customerPhone !== MY_MOBILE_PHONE) {
        await fetch('https://api.telnyx.com/v2/messages', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: myTelnyxNumber,
            to: MY_MOBILE_PHONE,
            text: `[NEW LEAD - ${customerPhone}]: ${customerText}`
          })
        });
      }
    }

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Telnyx Webhook Error:', error.message);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
  }
}