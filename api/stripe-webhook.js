import { buffer } from 'micro';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await buffer(req);
    
    // Securely verify using your exact Vercel environment variable name
    event = stripe.webhooks.constructEvent(
      rawBody, 
      sig, 
      process.env.STRIPE_SECRET_WEBHOOK_KEY
    );

    // 1. SUCCESSFUL CHECKOUT (Trial started or paid)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      const contractorPhone = session.metadata?.contractor_phone; // e.g. "+15623744750"
      const forwardNumber = session.metadata?.forward_number || contractorPhone; // Cell phone to ring
      const clientName = session.metadata?.client_name || session.customer_details?.name;
      const stripeCustomerId = session.customer;
      const stripeSubscriptionId = session.subscription;

      if (contractorPhone) {
        // Upsert contractor into Supabase with active status using the service role key (bypasses RLS safely)
        await fetch(`${SUPABASE_BASE_URL}/rest/v1/clients`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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