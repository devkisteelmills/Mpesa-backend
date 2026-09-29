/**
 * COBRA FX — M-Pesa STK Push backend (Daraja)
 * Sandbox first. Put secrets in Railway Variables — never in this file.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ----- Config from environment -----
const {
  DARAJA_CONSUMER_KEY,
  DARAJA_CONSUMER_SECRET,
  DARAJA_SHORTCODE = '174379',
  DARAJA_PASSKEY,
  DARAJA_CALLBACK_URL,
  DARAJA_ENV = 'sandbox' // sandbox | production
} = process.env;

const DARAJA_BASE =
  DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

// In-memory store for demo (use a real database in production)
const pendingPayments = new Map(); // checkoutRequestID -> { phone, amount, status, userId }

function requiredEnv() {
  const missing = [];
  if (!DARAJA_CONSUMER_KEY) missing.push('DARAJA_CONSUMER_KEY');
  if (!DARAJA_CONSUMER_SECRET) missing.push('DARAJA_CONSUMER_SECRET');
  if (!DARAJA_PASSKEY) missing.push('DARAJA_PASSKEY');
  if (!DARAJA_CALLBACK_URL) missing.push('DARAJA_CALLBACK_URL');
  return missing;
}

/** Get OAuth access token from Daraja */
async function getAccessToken() {
  const auth = Buffer.from(
    `${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await axios.get(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

/** Password for STK: base64(shortcode + passkey + timestamp) */
function buildPassword(timestamp) {
  const raw = `${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${timestamp}`;
  return Buffer.from(raw).toString('base64');
}

/** Timestamp YYYYMMDDHHmmss */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** Normalize Kenyan phone to 2547... */
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7')) p = '254' + p;
  if (p.startsWith('+')) p = p.slice(1);
  return p;
}

// Health check
app.get('/', (req, res) => {
  const missing = requiredEnv();
  res.json({
    service: 'COBRA FX Payments API',
    mpesa: {
      env: DARAJA_ENV,
      ready: missing.length === 0,
      missing: missing.length ? missing : undefined
    },
    stripe: {
      ready: !!process.env.STRIPE_SECRET_KEY,
      mode: (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live') ? 'live' : 'test'
    }
  });
});

/**
 * Start STK Push (deposit)
 * POST /api/deposit/mpesa
 * Body: { phone: "07...", amount: 10, userId: "optional" }
 */
app.post('/api/deposit/mpesa', async (req, res) => {
  const missing = requiredEnv();
  if (missing.length) {
    return res.status(500).json({
      error: 'Server not configured',
      missing
    });
  }

  try {
    const { phone, amount, userId } = req.body || {};
    const amt = Math.round(Number(amount));
    const msisdn = normalizePhone(phone || '');

    if (!msisdn || msisdn.length < 12) {
      return res.status(400).json({ error: 'Valid phone required (e.g. 07XXXXXXXX)' });
    }
    if (!amt || amt < 1) {
      return res.status(400).json({ error: 'Amount must be at least 1' });
    }

    const token = await getAccessToken();
    const ts = timestamp();
    const password = buildPassword(ts);

    const payload = {
      BusinessShortCode: DARAJA_SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amt,
      PartyA: msisdn,
      PartyB: DARAJA_SHORTCODE,
      PhoneNumber: msisdn,
      CallBackURL: DARAJA_CALLBACK_URL,
      AccountReference: 'COBRAFX',
      TransactionDesc: 'COBRA FX Deposit'
    };

    const stkRes = await axios.post(
      `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = stkRes.data;
    const checkoutId = data.CheckoutRequestID;

    if (checkoutId) {
      pendingPayments.set(checkoutId, {
        phone: msisdn,
        amount: amt,
        userId: userId || null,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
    }

    // Sandbox: success response looks like ResponseCode "0"
    if (data.ResponseCode === '0') {
      return res.json({
        ok: true,
        message: 'STK Push sent. Check the phone and enter M-Pesa PIN.',
        checkoutRequestId: checkoutId,
        merchantRequestId: data.MerchantRequestID
      });
    }

    return res.status(400).json({
      ok: false,
      error: data.ResponseDescription || data.errorMessage || 'STK failed',
      raw: data
    });
  } catch (err) {
    const msg =
      err.response?.data?.errorMessage ||
      err.response?.data?.ResponseDescription ||
      err.message;
    console.error('STK error:', err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * Daraja callback — Safaricom calls this after user enters PIN
 * POST /mpesa/callback
 */
app.post('/mpesa/callback', (req, res) => {
  console.log('M-Pesa callback:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) {
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const checkoutId = body.CheckoutRequestID;
    const resultCode = body.ResultCode;
    const record = pendingPayments.get(checkoutId);

    if (record) {
      if (resultCode === 0) {
        record.status = 'completed';
        // Metadata has Amount, MpesaReceiptNumber, PhoneNumber
        const items = body.CallbackMetadata?.Item || [];
        const get = (name) => items.find((i) => i.Name === name)?.Value;
        record.receipt = get('MpesaReceiptNumber');
        record.paidAmount = get('Amount');
        console.log('PAYMENT SUCCESS', record);
        // TODO: credit user balance in your real database here
      } else {
        record.status = 'failed';
        record.failReason = body.ResultDesc;
        console.log('PAYMENT FAILED', record);
      }
      pendingPayments.set(checkoutId, record);
    }
  } catch (e) {
    console.error('Callback parse error:', e.message);
  }

  // Always acknowledge Daraja
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

/**
 * Check status of a payment (frontend can poll)
 * GET /api/deposit/status/:checkoutRequestId
 */
app.get('/api/deposit/status/:id', (req, res) => {
  const record = pendingPayments.get(req.params.id);
  if (!record) {
    return res.status(404).json({ status: 'unknown' });
  }
  res.json({
    status: record.status,
    amount: record.amount,
    phone: record.phone,
    receipt: record.receipt || null,
    failReason: record.failReason || null
  });
});

// ========== B2C WITHDRAW (M-Pesa to phone) ==========
const {
  DARAJA_INITIATOR_NAME,
  DARAJA_SECURITY_CREDENTIAL,
  DARAJA_RESULT_URL,
  DARAJA_TIMEOUT_URL
} = process.env;

const pendingWithdrawals = new Map();

/**
 * Send money to customer phone (B2C)
 * POST /api/withdraw/mpesa
 * Body: { phone, amount, userId? }
 *
 * Railway vars required:
 *   DARAJA_INITIATOR_NAME
 *   DARAJA_SECURITY_CREDENTIAL  (encrypted initiator password from Daraja)
 *   DARAJA_RESULT_URL           e.g. https://xxx.up.railway.app/mpesa/b2c/result
 *   DARAJA_TIMEOUT_URL          e.g. https://xxx.up.railway.app/mpesa/b2c/timeout
 */
app.post('/api/withdraw/mpesa', async (req, res) => {
  if (!DARAJA_INITIATOR_NAME || !DARAJA_SECURITY_CREDENTIAL) {
    return res.status(500).json({
      ok: false,
      error:
        'B2C not configured. Add DARAJA_INITIATOR_NAME and DARAJA_SECURITY_CREDENTIAL on Railway. Enable B2C on Daraja first.'
    });
  }

  const resultUrl =
    DARAJA_RESULT_URL ||
    (DARAJA_CALLBACK_URL || '').replace('/mpesa/callback', '/mpesa/b2c/result');
  const timeoutUrl =
    DARAJA_TIMEOUT_URL ||
    (DARAJA_CALLBACK_URL || '').replace('/mpesa/callback', '/mpesa/b2c/timeout');

  try {
    const { phone, amount, userId } = req.body || {};
    const amt = Math.round(Number(amount));
    const msisdn = normalizePhone(phone || '');

    if (!msisdn || msisdn.length < 12) {
      return res.status(400).json({ ok: false, error: 'Valid phone required' });
    }
    if (!amt || amt < 1) {
      return res.status(400).json({ ok: false, error: 'Amount must be at least 1' });
    }

    const token = await getAccessToken();

    const payload = {
      InitiatorName: DARAJA_INITIATOR_NAME,
      SecurityCredential: DARAJA_SECURITY_CREDENTIAL,
      CommandID: 'BusinessPayment',
      Amount: amt,
      PartyA: DARAJA_SHORTCODE,
      PartyB: msisdn,
      Remarks: 'COBRA FX Withdrawal',
      QueueTimeOutURL: timeoutUrl,
      ResultURL: resultUrl,
      Occasion: 'Withdrawal'
    };

    const b2cRes = await axios.post(
      `${DARAJA_BASE}/mpesa/b2c/v1/paymentrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = b2cRes.data;
    console.log('B2C response:', JSON.stringify(data));

    if (data.ConversationID || data.OriginatorConversationID) {
      pendingWithdrawals.set(data.ConversationID || data.OriginatorConversationID, {
        phone: msisdn,
        amount: amt,
        userId: userId || null,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
    }

    if (data.ResponseCode === '0') {
      return res.json({
        ok: true,
        message: 'Withdrawal submitted to M-Pesa',
        conversationId: data.ConversationID,
        originatorConversationId: data.OriginatorConversationID
      });
    }

    return res.status(400).json({
      ok: false,
      error: data.ResponseDescription || data.errorMessage || 'B2C request failed',
      raw: data
    });
  } catch (err) {
    const msg =
      err.response?.data?.errorMessage ||
      err.response?.data?.ResponseDescription ||
      err.message;
    console.error('B2C error:', err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/mpesa/b2c/result', (req, res) => {
  console.log('B2C result:', JSON.stringify(req.body, null, 2));
  try {
    const rs = req.body?.Result;
    if (rs) {
      const id = rs.ConversationID || rs.OriginatorConversationID;
      const rec = pendingWithdrawals.get(id);
      if (rec) {
        rec.status = rs.ResultCode === 0 ? 'completed' : 'failed';
        rec.resultDesc = rs.ResultDesc;
        pendingWithdrawals.set(id, rec);
        console.log(rs.ResultCode === 0 ? 'WITHDRAW SUCCESS' : 'WITHDRAW FAILED', rec);
      }
    }
  } catch (e) {
    console.error('B2C result parse:', e.message);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/mpesa/b2c/timeout', (req, res) => {
  console.log('B2C timeout:', JSON.stringify(req.body));
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ========== STRIPE (cards) ==========
const Stripe = require('stripe');
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

// Where user returns after paying (your trading site)
const SITE_URL = process.env.SITE_URL || 'https://devkisteelmills.co.ke';

/**
 * Create Stripe Checkout Session
 * POST /api/deposit/card
 * Body: { amount: 50, userId?: string }
 * amount is in USD dollars (we charge in cents)
 */
app.post('/api/deposit/card', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({
      error: 'Stripe not configured. Add STRIPE_SECRET_KEY on Railway.'
    });
  }

  try {
    const { amount, userId } = req.body || {};
    const dollars = Number(amount);
    if (!dollars || dollars < 1) {
      return res.status(400).json({ error: 'Minimum amount is 1 USD' });
    }

    const cents = Math.round(dollars * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'COBRA FX Deposit',
              description: 'Account funding'
            },
            unit_amount: cents
          },
          quantity: 1
        }
      ],
      metadata: {
        userId: userId || 'web',
        amountUsd: String(dollars)
      },
      success_url:
        SITE_URL +
        '/dashboard.html?stripe=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: SITE_URL + '/dashboard.html?stripe=cancel'
    });

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id
    });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Confirm a Checkout Session was paid
 * GET /api/deposit/card/status?session_id=cs_...
 */
app.get('/api/deposit/card/status', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id required' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      const amountUsd =
        session.metadata?.amountUsd ||
        (session.amount_total != null ? session.amount_total / 100 : null);
      return res.json({
        status: 'completed',
        amount: amountUsd,
        sessionId: session.id
      });
    }

    return res.json({
      status: session.payment_status || 'pending',
      amount: session.metadata?.amountUsd || null
    });
  } catch (err) {
    console.error('Stripe status error:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`COBRA FX Payments API on port ${PORT}`);
  console.log(`M-Pesa env: ${DARAJA_ENV}`);
  console.log(`Stripe: ${stripe ? 'configured' : 'NOT set'}`);
  const missing = requiredEnv();
  if (missing.length) {
    console.warn('M-Pesa missing env:', missing.join(', '));
  } else {
    console.log('M-Pesa config OK');
  }
});
