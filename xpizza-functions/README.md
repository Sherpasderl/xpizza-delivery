# X Pizza Delivery — Cloud Functions

A single Cloud Function (`createOrder`) that Make.com calls when a new order arrives.
Replaces the two Onfleet HTTP modules in the Make scenario.

## Architecture

```
[xpizzaorders.netlify.app]
        ↓ webhook
   [Make.com scenario]
        ↓ Google Sheets log    (unchanged)
        ↓ UltraMsg WhatsApp    (unchanged)
        ↓
        │ if order_type == "delivery":
        ↓
   [Cloud Function: createOrder]   ← NEW (replaces Onfleet)
        ↓ Admin SDK
   [Firebase Realtime Database]
        ↓
   [Dispatcher sees the new order]
```

---

## One-time setup

You'll need:
- Node.js 18 or 20 installed (you probably already have it)
- The Firebase CLI

### 1. Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

### 2. Initialize the functions folder

From the `xpizza-functions/` directory:

```bash
cd xpizza-functions
firebase use xpizza-delivery   # tell the CLI which project to deploy to
npm install                    # install firebase-admin, firebase-functions
```

If `firebase use` complains, run `firebase init functions` first and pick the
`xpizza-delivery` project, JavaScript (not TypeScript), no ESLint, install
dependencies = yes. Then OVERWRITE the generated `index.js` and `package.json`
with the ones in this folder.

### 3. Generate the shared secret

```bash
openssl rand -hex 32
```

Copy the output (a 64-character hex string). This is your `MAKE_SECRET`.

### 4. Create the .env file

Copy `.env.example` to `.env` and paste the secret:

```bash
cp .env.example .env
# Edit .env, replace placeholder with the secret you generated
```

`.env` is gitignored — never commit it.

### 5. Deploy

```bash
npm run deploy
```

After a successful deploy the CLI prints something like:

```
✔ functions[createOrder(us-central1)] Successful create operation.
Function URL (createOrder(us-central1)): https://createorder-abc123-uc.a.run.app
```

**Copy that URL.** You'll paste it into Make.com next.

---

## Wiring up Make.com

### 1. Open your scenario

Open the `X Pizza Delivery Op` scenario in Make.com.

### 2. Disable the two Onfleet HTTP modules in the Delivery route

You can either delete them or just right-click → "Disable module." (Disable first, in case you want to roll back.)

### 3. Add a new HTTP module in the Delivery route

Add an `HTTP > Make a request` module right where the first Onfleet call used to be.

Configuration:

| Field | Value |
|---|---|
| **URL** | `<paste the Function URL from step 5 above>` |
| **Method** | POST |
| **Headers** | Add: `Authorization` = `Bearer <paste your MAKE_SECRET>`<br>Add: `Content-Type` = `application/json` |
| **Body type** | Raw |
| **Content type** | JSON (application/json) |
| **Request content** | (see below) |
| **Parse response** | Yes |

**Request content** (paste this into the body field, leaving the Make `{{...}}` mappings):

```json
{
  "order_id": "{{3.order_id}}",
  "customer_name": "{{3.customer_name}}",
  "customer_phone": "{{3.customer_phone}}",
  "items_text": "{{3.items_text}}",
  "total": {{3.total}},
  "lat": {{3.lat}},
  "lng": {{3.lng}},
  "address_detected": "{{3.address_detected}}",
  "address_details": "{{3.address_details}}",
  "notes": "{{3.notes}}",
  "maps_link": "{{3.maps_link}}",
  "payment_method": "{{3.payment_method}}",
  "order_type": "{{3.order_type}}"
}
```

The `{{3.xxx}}` references match the existing module numbering (module 3 is the Parse JSON step). If your numbering is different after editing, adjust accordingly.

> **Note on `payment_method`**: I added it to the body even though I don't see it in your existing Sheet log. If your order form sends it in the webhook payload, the dispatcher will display it. If not, the field stays empty — no harm done.

### 4. Save and run

Run the scenario manually with a test order, or trigger one through the order form.

---

## Verifying it works

After a test order:

1. **Check Cloud Function logs**:
   ```bash
   firebase functions:log
   ```
   You should see `createOrder: wrote order <id>`.

2. **Check Make execution**: the HTTP module should show a 200 response with `{"ok": true, "order_id": "..."}`.

3. **Check the dispatcher**: open `xpizzadispatch.netlify.app`, the new order should appear in the **SIN ASIGNAR** section within ~1 second.

4. **Check Firebase**: in Firebase Console → Realtime Database, you should see entries at:
   - `/orders/{order_id}` — full order
   - `/tasks/{order_id}_pickup` — pickup task at restaurant
   - `/tasks/{order_id}_delivery` — delivery task at customer

---

## Common errors

| Status | What it means | Fix |
|---|---|---|
| `401 Unauthorized` | Bearer token mismatch | Verify the `Authorization` header in Make matches the `MAKE_SECRET` in `.env`. Redeploy after editing `.env`. |
| `400 Bad Request` | Missing/invalid field | Read the `detail` field in the response body. Likely the order form is missing a field, or `lat`/`lng`/`total` arrived as text that can't be parsed. |
| `500 Database write failed` | RTDB rejected the write | Check Cloud Function logs. Likely a security rule problem (shouldn't happen since Admin SDK bypasses rules, but worth checking). |
| `200 idempotent: true` | Same `order_id` already exists | Not an error — Make probably retried. Order is already in the dispatcher. |
| Make HTTP module times out | Cold start on Cloud Function | First call after a quiet period takes ~3-5 seconds. Subsequent calls are <500ms. |

---

## Maintenance

- **Rotate the secret**: generate a new one, update `.env`, redeploy, update Make's `Authorization` header. Old secret stops working immediately.
- **View invocations + costs**: Firebase Console → Functions → `createOrder` → Metrics.
- **Update the function code**: edit `index.js`, run `npm run deploy`. The new version is live in ~30 seconds.

---

## What this does NOT do

- Does not send customer SMS on assignment / en route / delivered (you weren't using that anyway).
- Does not handle order updates after creation (only INSERTs new orders). Dispatcher manages all post-creation state.
- Does not validate customer phone format or geocode addresses. Whatever the order form sends is what gets stored.
