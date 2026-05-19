const express = require('express');
const cors    = require('cors');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your GitHub Pages portal
app.use(cors({
  origin: [
    'https://contactrelayops.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'RelayOps backend running', version: '1.0.0' });
});

// ── CREATE STRIPE PAYMENT LINK ──
// POST /create-payment-link
// Body: { amount, jobType, address, jobId, customerEmail }
// Returns: { url }
app.post('/create-payment-link', async (req, res) => {
  try {
    const { amount, jobType, address, jobId, customerEmail } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    const productName = `${jobType || 'Property Maintenance'} — ${(address || '').split(',')[0]}`;
    const description = `RelayOps job coordination · Job ID: ${jobId || 'N/A'}`;

    // Create a Price object (required for Payment Links)
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: amountCents,
      product_data: {
        name: productName,
        description: description,
        metadata: { jobId: jobId || '', relayops: 'true' }
      }
    });

    // Create Payment Link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: {
          custom_message: 'Thank you! Your RelayOps job payment is confirmed. Your vendor will be dispatched shortly.'
        }
      },
      metadata: {
        jobId: jobId || '',
        customerEmail: customerEmail || '',
        relayops: 'true'
      },
      // Pre-fill customer email if provided
      ...(customerEmail ? {
        customer_creation: 'always',
        billing_address_collection: 'auto'
      } : {})
    });

    console.log(`Payment link created: ${paymentLink.url} for job ${jobId}`);
    res.json({ url: paymentLink.url, id: paymentLink.id });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK (for auto-updating job status when paid) ──
// POST /webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed' ||
      event.type === 'payment_intent.succeeded') {

    const session  = event.data.object;
    const metadata = session.metadata || {};
    const jobId    = metadata.jobId;

    if (jobId) {
      // Update job status in Supabase via REST
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

      if (SUPABASE_URL && SUPABASE_KEY) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ status: 'assigned', admin_notes: 'Payment received via Stripe' })
          });
          console.log(`Job ${jobId} updated to assigned after payment`);
        } catch (e) {
          console.error('Supabase update failed:', e.message);
        }
      }
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`RelayOps backend running on port ${PORT}`);
});
