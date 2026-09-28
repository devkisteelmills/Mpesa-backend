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
    service: 'COBRA FX M-Pesa API',
    env: DARAJA_ENV,
    ready: missing.length === 0,
    missing: missing.length ? missing : undefined
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

app.listen(PORT, () => {
  console.log(`COBRA FX M-Pesa API on port ${PORT}`);
  console.log(`Env: ${DARAJA_ENV}`);
  const missing = requiredEnv();
  if (missing.length) {
    console.warn('Missing env vars:', missing.join(', '));
  } else {
    console.log('Config OK — ready for STK Push');
  }
});
