import { buffer } from 'micro';

// Disable default body parser so Stripe signature verification works
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const SUPABASE_BASE_URL = "https://oexjbmllasslcxfqprlq.supabase.co";
  const SUPABASE_ANON_KEY = "process.env.SUPABASE_SERVICE_ROLE_KEY";

  try {
    const rawBody = await buffer(req);
    const event = JSON.parse(rawBody.toString());

    // 1. SUCCESSFUL CHECKOUT (Trial started or paid)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      // Pull custom metadata passed from your website checkout button
      const contractorPhone = session.metadata?.contractor_phone; // e.g. "+15623744750"
      const forwardNumber = session.metadata?.forward_number || contractorPhone; // Cell phone to ring
      const clientName = session.metadata?.client_name || session.customer_details?.name;
      const stripeCustomerId = session.customer;
      const stripeSubscriptionId = session.subscription;

      if (contractorPhone) {
        // Upsert contractor into Supabase with active status
        await fetch(`${SUPABASE_BASE_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            contractor_phone: contractorPhone,
            forward_number: forwardNumber,
            client_name: clientName,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            status: 'active'
          })
        });
      }
    }

    // 2. PAYMENT FAILED OR SUBSCRIPTION CANCELED (Revoke access)
    if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
      const subscription = event.data.object;
      const stripeCustomerId = subscription.customer;

      // Mark contractor status as suspended in Supabase
      await fetch(`${SUPABASE_BASE_URL}/rest/v1/clients?stripe_customer_id=eq.${stripeCustomerId}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: 'suspended'
        })
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
}