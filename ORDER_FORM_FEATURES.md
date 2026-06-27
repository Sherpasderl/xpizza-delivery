# Order-form features to port to La Musa

New features added to the **X. Pizza order form** (`xpizza-orders/index.html`) during the
factura integration. This is the front-end port guide for replicating them in the **La Musa
order form**. Snippets are copied verbatim from the live X. Pizza form (commit `e4e2581`).

> ⚠️ These are the **front-end** pieces. The factura *generation* is backend (shared Cloud
> Functions) and needs per-restaurant setup — see **§5 Backend dependencies** before assuming
> the fields alone produce La Musa facturas.

---

## 1. RTN capture ("Necesito factura con RTN")

Checkbox that reveals two fields; on a factura, `razón social` replaces `CLIENTE` and the RTN
prints. Place it in the "Tus datos" section (after the email field is a good spot).

**Markup:**
```html
<div class="field-group field-divider">
  <label class="field-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:400">
    <input type="checkbox" id="rtn-toggle" onchange="toggleRtn()" style="width:auto;margin:0"/>
    Necesito factura con RTN
  </label>
  <div id="rtn-fields" style="display:none;margin-top:10px">
    <input type="text" id="razon-social" placeholder="Razón social (nombre en la factura)" style="margin-bottom:8px" maxlength="120"/>
    <input type="text" id="rtn-cliente" inputmode="numeric" maxlength="14" placeholder="RTN (14 dígitos)"/>
    <div id="rtn-error" style="display:none;color:var(--red,#C8321A);font-size:.8rem;margin-top:4px">El RTN debe tener exactamente 14 dígitos.</div>
  </div>
</div>
```

**JS:**
```js
function toggleRtn(){
  const on=document.getElementById('rtn-toggle').checked;
  document.getElementById('rtn-fields').style.display=on?'block':'none';
  if(!on){ document.getElementById('razon-social').value=''; document.getElementById('rtn-cliente').value=''; document.getElementById('rtn-error').style.display='none'; }
}
function rtnIsValid(){
  if(!document.getElementById('rtn-toggle')?.checked) return true; // not requested = ok
  return /^\d{14}$/.test(document.getElementById('rtn-cliente').value.trim());
}
```

**Validation** — call `rtnIsValid()` at the top of the submit handler, before building the order:
```js
if(!rtnIsValid()){
  document.getElementById('rtn-error').style.display='block';
  document.getElementById('rtn-cliente').focus();
  return;
}
```

**Payload** (in `buildOrder`/`currentOrder`):
```js
const rtnOn=document.getElementById('rtn-toggle')?.checked;
currentOrder.razon_social = rtnOn ? document.getElementById('razon-social').value.trim() : '';
currentOrder.rtn_cliente  = rtnOn ? document.getElementById('rtn-cliente').value.trim() : '';
```
Server re-validates RTN as `/^\d{14}$/` (never trust the client); `razon_social` is sanitized.

**Retry-restore:** if the form has the "Volver a intentar" snapshot (snapshotForm/restoreOrderForm),
capture/restore `rtn-toggle`(checked) + `razon-social` + `rtn-cliente` and call `toggleRtn()` on
restore. (X. Pizza's retry-restore already does this guarded — mirror it.)

---

## 2. Cash-change capture ("¿Con cuánto vas a pagar?" → CAMBIO)

Shown **only when "Efectivo" is selected**. Customer picks how much they'll pay with, so the
driver carries exact change. Feeds `cash_tendered` → factura `CAMBIO`.

**Markup** (place right after the payment options, before the online-payment panel):
```html
<div id="cash-change-panel" style="display:none;margin-top:14px">
  <label class="field-label">¿Con cuánto vas a pagar? <span style="font-weight:400;color:#999">(para llevarte el cambio exacto)</span></label>
  <div id="change-chips" style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0"></div>
  <input type="text" id="cash-tendered" inputmode="numeric" placeholder="Otro monto (L)" oninput="onCashTenderedInput()"/>
  <div id="change-hint" style="font-size:.82rem;color:#666;margin-top:6px"></div>
</div>
```

**CSS** (the red pill chips, with hover + selected state):
```css
.change-chip{display:inline-flex;align-items:center;justify-content:center;padding:11px 18px;min-height:44px;border:1.5px solid var(--red,#C8321A);background:#fff;color:var(--red,#C8321A);border-radius:999px;font-size:15px;font-weight:600;font-family:var(--body);cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.change-chip:hover{box-shadow:0 1px 6px rgba(0,0,0,.08)}
.change-chip.active{background:var(--red,#C8321A);color:#fff}
```

**Toggle visibility** inside your `selectPay(type)`:
```js
const cashPanel=document.getElementById('cash-change-panel');
if(cashPanel){ cashPanel.style.display=(type==='cash')?'block':'none'; if(type==='cash') renderChangeChips(); }
```

**JS** — chips = "Pago exacto" + **one** realistic round-up. Key rule: Honduras' largest
banknote is **L500** (no L1,000 note), so the customer hands over the *fewest 500-bills that
exceed the total* and no more (a <L1,000 order needs at most two 500s = L1,000):
```js
function renderChangeChips(){
  const total=calcTotal();
  const box=document.getElementById('change-chips'); if(!box) return;
  let base=Math.ceil(total/500)*500; if(base<=total) base+=500;
  const amounts=[base]; // single round-up: L579->1000, L1200->1500, L1995->2000, L120->500
  const chips=[{label:'Pago exacto',val:total}, ...amounts.map(a=>({label:'L'+a.toLocaleString('en-US'),val:a}))];
  box.innerHTML=chips.map(c=>`<button type="button" class="change-chip" data-amt="${c.val}" onclick="setCashTendered(${c.val})">${c.label}</button>`).join('');
}
function setCashTendered(v){ document.getElementById('cash-tendered').value=v; onCashTenderedInput(); }
function onCashTenderedInput(){
  const total=calcTotal();
  const v=parseFloat(document.getElementById('cash-tendered').value);
  const hint=document.getElementById('change-hint');
  document.querySelectorAll('#change-chips .change-chip').forEach(b=>b.classList.toggle('active', Number(b.dataset.amt)===v));
  if(!isFinite(v)||v<=0){ hint.textContent=''; return; }
  if(v<total){ hint.style.color='var(--red,#C8321A)'; hint.textContent='El monto debe ser mayor o igual al total (L'+total.toFixed(2)+').'; }
  else { hint.style.color='#666'; hint.textContent='Tu cambio: L'+(v-total).toFixed(2); }
}
```

**Payload** (cash only; only send if ≥ total — server defaults to exact otherwise):
```js
if(selectedPayment==='cash'){
  const ct=parseFloat(document.getElementById('cash-tendered')?.value);
  if(isFinite(ct) && ct>=total) currentOrder.cash_tendered = ct;
}
```
Server stores `cash_tendered_cents` (integer centavos), validates `>= total_cents`.

---

## 3. Styling gotchas (these bit us on X. Pizza — fix in La Musa too)

- **Input type must be in the field selector.** The platform field style only targets
  `input[type=text], input[type=tel], input[type=email], textarea`. Any other type renders as
  the tiny default box. So:
  - the cash input uses **`type="text" inputmode="numeric"`** (not `type=number`) to inherit
    the style + drop the number-spinner;
  - the **email field** (`tu correo`, `type=email`) must be in the selector — we had to add
    `input[type=email]`. Make sure La Musa's selector includes it:
    ```css
    input[type=text],input[type=tel],input[type=email],textarea{ /* field style */ }
    ```
- **Use `--red`, not `--brand-red`.** `--brand-red` is **undefined** platform-wide — anything
  using it (incl. the required-field `*` asterisk) silently renders unstyled. Use `var(--red,#C8321A)`.

---

## 4. `tu correo` (email) — what it actually does

Pre-existing field; behavior worth knowing before relying on its "para tu recibo" label:
- **Online (PixelPay) orders:** passed to the PixelPay hosted checkout (payer email); falls
  back to `pedidos@xpizza.hn` if blank/invalid. Used at charge time, not stored.
- **Cash orders:** collected but **unused** server-side.
- **No email is ever sent by the platform** (no mail service; updates go via WhatsApp, the
  receipt is the paper factura). So "para tu recibo" is only indirectly true (PixelPay's own
  receipt) for online orders. For La Musa, set `from`/fallback email to a La Musa address.

---

## 5. Backend dependencies (IMPORTANT — fields alone ≠ working facturas)

The factura pipeline is **shared backend** (`xpizza-functions`), keyed by `restaurant_id`:
- Every order must be stamped with the correct **`restaurant_id`** (`la_musa`) and the order
  record must carry the server-priced **`items[]`**, `total_cents/subtotal_cents/tax_cents`,
  `cash_tendered_cents`, `factura_status:'not_due'` — see how `createOrder` builds these.
- A **`/restaurants/la_musa/factura_config`** must be seeded (own CAI / range / counter /
  emisor identity) — La Musa needs its **own** SAR CAI + range, separate from X. Pizza's.
- The `allocateFacturaOnSale` trigger fires per order state and reads that restaurant's config.
- **La Musa is multi-rate (food 15% / alcohol 18%).** The current pricing computes a **flat
  15%** breakdown; the renderer *prints* the 18% lines but the numbers aren't split yet.
  Per-item tax for La Musa is **out of scope of the X. Pizza work** — it must be built for
  La Musa's facturas to be fiscally correct. See `FACTURA_PLAN.md` (Out of scope) +
  `CONTEXT.md` (ISV) + the La Musa integration plan.

See `FACTURA_PLAN.md`, `docs/adr/0003`–`0004`, and `xpizza-factura/SETUP.md` for the full
factura system. The print agent (Surface + Epson) is per-Hub; La Musa runs its own POS today,
so coordinate whether La Musa facturas go through this platform or stay on Soft Restaurant V11.
