# X Pizza Delivery — Setup Guide

This is the backend for the in-house last-mile delivery operation that replaces Onfleet. Built on Firebase Realtime Database (free Spark plan covers your volume easily).

## Files in this drop

- `SCHEMA.md` — data model reference
- `database.rules.json` — security rules (paste into Firebase console)
- `xpizza-delivery.js` — shared SDK both apps will import
- `test-harness.html` — verify everything works before building real UIs

---

## Setup (45 min, mostly waiting)

### 1. Create the Firebase project (5 min)

1. Go to https://console.firebase.google.com → **Add project**
2. Name: `xpizza-delivery`
3. Disable Google Analytics (not needed)
4. Once created, hit the **</> (Web)** icon to register a web app
5. App nickname: `xpizza-delivery-web` — don't enable hosting yet
6. **Copy the `firebaseConfig` object**, you'll paste it into the test harness

### 2. Enable Realtime Database (3 min)

1. Left sidebar → **Build → Realtime Database**
2. **Create Database** → location: `us-central1` (closest to Honduras with low latency)
3. Start in **test mode** for now (we'll lock it down in step 4)
4. Note the URL — looks like `https://xpizza-delivery-default-rtdb.firebaseio.com`. This goes into the config as `databaseURL` (Firebase doesn't always include it automatically — add it manually if missing).

### 3. Enable Authentication (3 min)

1. Left sidebar → **Build → Authentication → Get started**
2. **Sign-in method** tab → enable **Email/Password**
3. **Users** tab → **Add user** for each:
   - Your email + a password (this is the dispatcher account)
   - `hermez@xpizza.local` + password (driver 1) — fake email is fine, no verification needed
   - `xavier-driver@xpizza.local` + password (driver 2)
4. Note each user's **UID** (long string) — you'll need them

### 4. Bootstrap the dispatcher role (5 min)

The security rules require dispatchers to already exist before they can grant dispatcher rights. Bootstrap problem solved by manual seed:

1. **Realtime Database → Data tab**
2. Click the `+` next to the database root and add:
   ```
   dispatchers/
     {your_uid}: true
   ```
   Replace `{your_uid}` with your dispatcher UID from step 3
3. **Then** go to **Rules tab** and paste the contents of `database.rules.json`
4. **Publish**

From now on, only dispatchers can grant dispatcher rights or write to most nodes.

### 5. Test the plumbing (10 min)

1. Drop `xpizza-delivery.js` and `test-harness.html` in the same folder, serve them via any local server (Netlify CLI, `python3 -m http.server`, or just deploy to Netlify under e.g. `xpizzadeliverytest.netlify.app`)
2. Open the test harness
3. Paste your `firebaseConfig` JSON, hit **Connect**
4. Sign in with your dispatcher account → log shows `role: DISPATCHER`
5. Click **Create test order** → see it appear in tasks + orders lists
6. Open another browser (or incognito), sign in as a driver
7. Driver clicks **Start shift** → enter name first time → status flips green
8. Click **At restaurant** preset → driver pin "arrives"
9. In dispatcher tab: click **Assign to me** on a pending task
10. Back in driver tab: task shows up with **Accept** button → tap → **Mark delivered**
11. Watch the geofence transitions auto-fire when you toggle between presets

If all that works, the backend is done.

---

## Driver shift workflow (how it'll work in production)

1. Driver opens the driver PWA on their phone, screen-wake-lock acquired, phone goes in handlebar mount
2. Logs in → taps **Start shift**
3. App calls `navigator.geolocation.watchPosition` → streams location every ~10s
4. Tasks appear in queue when dispatcher assigns them
5. Driver taps **Accept** → **Picked up** → **Delivered**
6. Geofence auto-detects arrival at restaurant — no need to tap "I'm back"
7. End of night: **End shift**

---

## Make.com migration plan (next session)

The current pipeline writes orders to Google Sheets and creates two Onfleet tasks. New pipeline keeps Sheets (kitchen display still reads from it) but **replaces Onfleet HTTP calls with Firebase writes**:

```
Webhook → JSON Parse → Google Sheets (unchanged) → Ultramsg WhatsApp (unchanged) → Router
                                                                                   ├── Delivery filter (order_type = delivery)
                                                                                   │   → HTTP POST to Firebase REST API
                                                                                   │     PATCH https://xpizza-delivery-default-rtdb.firebaseio.com/.json
                                                                                   │     body: { orders/{id}: {...}, tasks/{id}_pickup: {...}, tasks/{id}_delivery: {...} }
                                                                                   └── Pickup fallback (no tasks created)
```

Auth for the Make.com → Firebase write: create a **Firebase service account** (Project Settings → Service Accounts → Generate new private key) and use its JWT to sign requests. Or, simpler: temporarily allow writes from a specific server-side secret, embed it in the rules. We'll wire this up next session.

The kitchen display can stay reading from Sheets unchanged — orders flow into both Sheets (for kitchen) and Firebase (for delivery dispatch). When Firebase has proven stable, we can migrate the kitchen display to read from Firebase too and retire the Sheet as the source of truth.

---

## Cost reality check

Firebase Spark (free) plan limits:
- Realtime DB: 100 simultaneous connections, 1 GB stored, 10 GB/month transferred
- Auth: 50,000 monthly active users

Your usage estimate:
- 2 drivers + 1 dispatcher = 3 concurrent connections
- ~10 GPS pings/sec/driver × 8 hours/day × 30 days × 2 drivers = ~17M pings/month
- Each ping ~100 bytes = ~1.7 GB/month transferred

You'll likely cross the free tier on bandwidth eventually. **Blaze plan (pay-as-you-go) for Realtime DB is ~$1/GB transferred**, so realistic monthly cost: $5–15. Still a fraction of Onfleet.

One easy lever if it gets tight: drop ping frequency from 10s to 15s during the return trip (lower priority for dispatcher visibility). Cuts bandwidth by ~30%.

---

## Next session deliverables

1. **Driver PWA** (`xpizzadriver.netlify.app`) — login, shift toggle, GPS streaming with wake lock, task queue, status buttons
2. **Dispatcher view** — live map (Google Maps API), driver pins, task assignment, geofence visualization
3. **Make.com pipeline modification** — Firebase REST writes replace Onfleet HTTP calls
4. **Customer tracking page** (optional, low priority) — public link with last-known driver position

Recommended order: Driver PWA → Dispatcher view → Make.com migration → cutover. Driver PWA first because it generates the live state everything else consumes.
