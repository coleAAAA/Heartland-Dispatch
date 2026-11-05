export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { company_name, owner_email, primary_phone, backup_phones } = req.body;
  const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SUPER_SECRET_KEY;

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SUPER_SECRET_KEY environment variable is missing.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    // Format primary phone into clean 10-digit / E.164 standard
    let cleanPrimary = (primary_phone || '').replace(/\D/g, '');
    if (cleanPrimary.length === 10) {
      cleanPrimary = `+1${cleanPrimary}`;
    } else if (cleanPrimary.length > 0 && !cleanPrimary.startsWith('+')) {
      cleanPrimary = `+${cleanPrimary}`;
    }

    // Format any secondary forward numbers
    const cleanBackup = (backup_phones || []).map(num => {
      let clean = num.replace(/\D/g, '');
      return clean.length === 10 ? `+1${clean}` : clean;
    }).join(', ');

    const response = await fetch(`${SUPABASE_BASE_URL}/rest/v1/clients`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        client_name: company_name,
        email: owner_email,
        contractor_phone: cleanPrimary,
        forward_number: cleanBackup || cleanPrimary,
        status: 'pending_trial'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Supabase Save Lead Error:', errText);
      return res.status(500).json({ error: errText });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Save lead server error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}