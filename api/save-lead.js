export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    // Accept both old and new field names so nothing breaks
    const client_name = body.company_name || body.client_name;
    const contractor_phone = body.primary_phone || body.contractor_phone;
    const forward_number = (body.backup_phones && body.backup_phones[0]) || body.forward_number || contractor_phone;
    const email = body.owner_email || body.email;

    if (!contractor_phone) {
      return res.status(400).json({ error: 'Missing required contractor phone number' });
    }

    const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
    const SUPABASE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_KEY) {
      return res.status(500).json({ error: 'Server configuration error: Supabase key missing' });
    }

    // Perfectly matched to your Supabase columns: client_name, contractor_phone, forward_number, email
    const payload = {
      client_name: client_name || "Heartland Dispatch Client",
      contractor_phone: String(contractor_phone).trim(),
      forward_number: String(forward_number).trim(),
      email: email ? String(email).trim() : null
    };

    console.log("Saving lead to Supabase:", payload);

    const dbResponse = await fetch(`${SUPABASE_BASE_URL}/rest/v1/clients`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(payload)
    });

    const responseText = await dbResponse.text();
    
    if (!dbResponse.ok) {
      console.error('Supabase insert failed:', responseText);
      return res.status(500).json({ error: 'Database save failed', details: responseText });
    }

    let insertedData = [];
    try {
      insertedData = JSON.parse(responseText);
    } catch (e) {}

    return res.status(200).json({ 
      success: true, 
      message: 'Lead saved successfully',
      data: insertedData,
      stripeUrl: 'https://buy.stripe.com/14AfZ94a49dg9bkcmA0sU00'
    });

  } catch (error) {
    console.error('Critical save-lead error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}