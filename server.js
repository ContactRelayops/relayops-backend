const express = require('express');
const cors    = require('cors');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://contactrelayops.github.io',
    'https://getrelayhq.com',
    'https://www.getrelayhq.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'RelayOps backend running', version: '1.0.0' });
});

app.post('/create-payment-link', async (req, res) => {
  try {
    const { amount, jobType, address, jobId, customerEmail } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);
    const productName = `${jobType || 'Property Maintenance'} — ${(address || '').split(',')[0]}`;

    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: amountCents,
      product_data: {
        name: productName,
        metadata: { jobId: jobId || '', relayops: 'true' }
      }
    });

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
      }
    });

    console.log(`Payment link created: ${paymentLink.url} for job ${jobId}`);
    res.json({ url: paymentLink.url, id: paymentLink.id });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed' ||
      event.type === 'payment_intent.succeeded') {
    const session  = event.data.object;
    const jobId    = session.metadata?.jobId;

    if (jobId) {
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
