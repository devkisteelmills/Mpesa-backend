# COBRA FX — M-Pesa backend (Daraja + Railway)

This small server sends **M-Pesa STK Push** (deposit PIN on the phone) using your Safaricom Daraja **Sandbox** keys.

---

## What you need ready

- Consumer Key  
- Consumer Secret  
- Sandbox Passkey: `bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919`  
- Shortcode: `174379`  
- Free [Railway](https://railway.app) account  

---

## Deploy on Railway (step by step)

### 1. Create GitHub repo for the backend only

1. Go to GitHub → New repository  
2. Name: `cobrafx-mpesa-backend` (public or private)  
3. Upload **only** the files in this folder:
   - `package.json`
   - `server.js`
   - `README.md`
   - `.env.example`  
4. Do **not** put Consumer Secret in any file on GitHub  

### 2. New project on Railway

1. Open [https://railway.app](https://railway.app) → login (GitHub is easiest)  
2. **New Project** → **Deploy from GitHub repo**  
3. Select `cobrafx-mpesa-backend`  
4. Railway builds it (uses `npm start`)  

### 3. Add environment variables

In Railway → your service → **Variables** → add:

| Variable | Value |
|----------|--------|
| `DARAJA_CONSUMER_KEY` | your key |
| `DARAJA_CONSUMER_SECRET` | your secret |
| `DARAJA_PASSKEY` | `bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919` |
| `DARAJA_SHORTCODE` | `174379` |
| `DARAJA_ENV` | `sandbox` |
| `DARAJA_CALLBACK_URL` | (set after step 4) |

### 4. Public URL

1. Railway → your service → **Settings** → **Networking** / **Generate Domain**  
2. You get something like: `https://cobrafx-mpesa-production-xxxx.up.railway.app`  
3. Set variable:

```text
DARAJA_CALLBACK_URL=https://YOUR-RAILWAY-DOMAIN.up.railway.app/mpesa/callback
```

4. Redeploy if needed (Railway often restarts when variables change)

### 5. Test the server

Open in browser:

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/
```

You should see:

```json
{ "service": "COBRA FX M-Pesa API", "env": "sandbox", "ready": true }
```

If `ready: false`, check **missing** keys in the JSON.

### 6. Test STK Push (Sandbox)

Use a tool like [https://reqbin.com](https://reqbin.com) or Postman:

**POST** `https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/deposit/mpesa`

Body (JSON):

```json
{
  "phone": "254708374149",
  "amount": 1,
  "userId": "test-user"
}
```

Expected: `{ "ok": true, "message": "STK Push sent..." }`  

On Sandbox, Safaricom may not always hit a real phone; check Railway **Logs** for callback messages.

---

## Connect COBRA FX website later

When the API works, change the site deposit button to:

```js
fetch('https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/deposit/mpesa', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: phoneFromForm, amount: amountFromForm })
})
```

Then poll:

```text
GET /api/deposit/status/CHECKOUT_REQUEST_ID
```

until `status` is `completed` or `failed`.

---

## Security

- Never commit real secrets  
- Use Railway Variables only  
- For live M-Pesa you need Daraja **Production** go-live + real Paybill/Till  

---

## Production (later)

1. Complete Safaricom production / go-live  
2. New production Key, Secret, Passkey, Shortcode  
3. On Railway set `DARAJA_ENV=production` and update all variables  
```
