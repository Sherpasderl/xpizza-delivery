# International Phone Input (country-code dropdown) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let customers enter a non-Honduras phone number by replacing the +504-hardwired field with a country-code dropdown (default +504) + local-number input, on **both** order forms.

**Architecture:** Client-side only. A shared inline component (config `PHONE_COUNTRIES`, a `.cc-btn`/`.cc-menu` dropdown, a rewritten local-only formatter, per-country validation, full-number `customer_phone`) applied identically to `xpizza-orders/index.html` and `la-musa-orders/index.html`. The server's `normalizePhone()` already accepts full international numbers — **no functions change**.

**Tech Stack:** Vanilla inline JS/HTML/CSS. **No test harness → manual browser verification.**

**Spec:** `docs/superpowers/specs/2026-07-24-intl-phone-input-design.md`

**Rule:** no emoji in the control ([[no-cheap-emoji-in-form-chrome]]).

---

## Section A — The phone control (IDENTICAL code for both forms)

The following code is inserted/edited at each form's anchors (Tasks 1 & 2). It is byte-identical across the two files; only the insertion line numbers differ.

**A1 · CSS** (add to the `<style>` block, right after the shared `input[type=tel]…` rule):
```css
.phone-row{display:flex;gap:8px;position:relative}
.cc-btn{flex:none;display:flex;align-items:center;gap:6px;border:1.5px solid var(--border2);background:var(--cream);border-radius:8px;padding:0 12px;min-height:48px;font-family:inherit;font-size:17px;font-weight:600;color:var(--charcoal);cursor:pointer;white-space:nowrap}
.cc-btn .caret{color:#8C7B6E;font-size:12px}
.cc-menu{position:absolute;top:54px;left:0;z-index:30;background:#fff;border:1.5px solid var(--border2);border-radius:10px;box-shadow:0 14px 40px -14px rgba(20,15,10,.3);padding:6px;min-width:240px;max-height:260px;overflow:auto;display:none}
.cc-menu.open{display:block}
.cc-opt{display:flex;justify-content:space-between;gap:12px;padding:11px 12px;border-radius:7px;cursor:pointer;font-size:15px;color:var(--charcoal)}
.cc-opt:hover{background:var(--cream)}
.cc-opt .code{color:#8C7B6E;font-variant-numeric:tabular-nums}
.cc-opt.sel{background:var(--cream);font-weight:700}
```

**A2 · Markup** — replaces the single `<input id="cphone" …>` line:
```html
        <div class="phone-row">
          <button type="button" class="cc-btn" id="cc-btn" aria-label="Código de país">+504 <span class="caret">▾</span></button>
          <input type="tel" id="cphone" inputmode="numeric" placeholder="9999-9999" autocomplete="tel"/>
          <div class="cc-menu" id="cc-menu" role="listbox"></div>
        </div>
```

**A3 · Component JS** — add at module scope, immediately **before** `function initCardFormatting(){`:
```js
// ── International phone: country-code selector + local number (default Honduras +504) ──
const PHONE_COUNTRIES = [
  { code:'504', name:'Honduras', len:8 },
  { code:'1',   name:'Estados Unidos', len:10 },
  { code:'502', name:'Guatemala', len:8 },
  { code:'503', name:'El Salvador', len:8 },
  { code:'505', name:'Nicaragua', len:8 },
  { code:'506', name:'Costa Rica', len:8 },
  { code:'52',  name:'México', len:10 },
  { code:'34',  name:'España', len:9 },
];
let phoneCC = '504';
function phoneCountry(){ return PHONE_COUNTRIES.find(c => c.code === phoneCC) || PHONE_COUNTRIES[0]; }
function fmtPhoneLocal(code, d){
  if(code === '1'){ if(d.length>6) return '('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6); if(d.length>3) return '('+d.slice(0,3)+') '+d.slice(3); return d; }
  if(phoneCountry().len === 8){ return d.length>4 ? d.slice(0,4)+'-'+d.slice(4) : d; }
  return d.replace(/(\d{2,3})(?=\d)/g, '$1 ').trim();
}
function fullPhone(){ const d=(document.getElementById('cphone')?.value||'').replace(/\D/g,''); return d ? '+'+phoneCC+' '+fmtPhoneLocal(phoneCC,d) : ''; }
function initPhoneControl(){
  const inp=document.getElementById('cphone'), btn=document.getElementById('cc-btn'), menu=document.getElementById('cc-menu');
  if(!inp||!btn||!menu) return;
  menu.innerHTML = PHONE_COUNTRIES.map(c => '<div class="cc-opt'+(c.code===phoneCC?' sel':'')+'" data-code="'+c.code+'"><span class="nm">'+c.name+'</span><span class="code">+'+c.code+'</span></div>').join('');
  function setCountry(code){
    phoneCC = code; const c = phoneCountry();
    btn.innerHTML = '+'+code+' <span class="caret">▾</span>';
    inp.placeholder = code==='504' ? '9999-9999' : (code==='1' ? '(555) 123-4567' : 'número local');
    inp.value = '';
    menu.querySelectorAll('.cc-opt').forEach(o => o.classList.toggle('sel', o.getAttribute('data-code')===code));
  }
  inp.addEventListener('input', function(){ const d=this.value.replace(/\D/g,'').slice(0, phoneCountry().len); this.value = fmtPhoneLocal(phoneCC, d); });
  btn.addEventListener('click', function(e){ e.stopPropagation(); menu.classList.toggle('open'); });
  menu.addEventListener('click', function(e){ const o=e.target.closest('.cc-opt'); if(!o) return; setCountry(o.getAttribute('data-code')); menu.classList.remove('open'); inp.focus(); });
  document.addEventListener('click', function(){ menu.classList.remove('open'); });
  window.__setPhoneCC = setCountry;   // used by draft restore
}
```

**A4 · Replace the old formatter body** — inside `initCardFormatting()`, replace the whole `// ── Phone number …` block (the `const phoneInput=…` through its `input` + `focus` listeners) with a single call:
```js
  initPhoneControl();
```

**A5 · Validation** — replace the phone check in the Paso-1 gate:
```js
  const phoneDigits=phone.replace(/[^\d]/g,'');
  const needLen=phoneCountry().len;
  if(!name || phoneDigits.length!==needLen){
    err.style.display='block';
    err.textContent=!name?'Por favor ingresá tu nombre.':('Número de WhatsApp inválido. Ingresá los '+needLen+' dígitos de tu número.');
    return;
  }
```

**A6 · Submit** — `customer_phone` now = the full international number:
```js
    customer_phone: fullPhone(),
```

**A7 · Draft snapshot save** — add `cphoneCC` to the `fields` object:
```js
    fields: { cname:v('cname'), cphone:v('cphone'), cphoneCC:phoneCC, cemail:v('cemail'), notes:v('notes'),
              addressDetected:v('address-detected'), addressDetails:v('address-details') }
```

**A8 · Draft snapshot restore** — re-select the country before restoring the local number:
```js
    setV('cname',snap.fields.cname);
    if(snap.fields.cphoneCC && typeof window.__setPhoneCC==='function') window.__setPhoneCC(snap.fields.cphoneCC);
    setV('cphone',snap.fields.cphone); setV('cemail',snap.fields.cemail);
```

---

### Task 1: X. Pizza form (`xpizza-orders/index.html`)

- [ ] **Step 1 — CSS (A1).** Insert the A1 block right after the shared input rule (`input[type=text],input[type=tel],…{…min-height:48px}`, ~line 588).

- [ ] **Step 2 — Markup (A2).** Replace this line (~1073):
```html
        <input type="tel" id="cphone" inputmode="numeric" placeholder="+504 9999-9999" maxlength="14" autocomplete="tel"/>
```
with the **A2** block.

- [ ] **Step 3 — Component JS (A3).** Insert the **A3** block immediately before `function initCardFormatting(){` (~line 3226).

- [ ] **Step 4 — Formatter call (A4).** Inside `initCardFormatting()` (~3227-3247), replace the entire phone block:
```js
  // ── Phone number: +504 XXXX-XXXX (max 14 chars incl. formatting) ──
  const phoneInput=document.getElementById('cphone');
  if(phoneInput){
    phoneInput.addEventListener('input',function(e){
      let raw=this.value.replace(/[^\d]/g,'');
      if(!raw.startsWith('504')) raw='504'+raw.replace(/^504/,'');
      raw=raw.substring(0,11);
      let formatted='+'+raw;
      if(raw.length>3) formatted='+'+raw.substring(0,3)+' '+raw.substring(3);
      if(raw.length>7) formatted='+'+raw.substring(0,3)+' '+raw.substring(3,7)+'-'+raw.substring(7);
      this.value=formatted;
    });
    phoneInput.addEventListener('focus',function(){
      if(!this.value) this.value='+504 ';
    });
  }
```
with the **A4** one-liner `initPhoneControl();`. _(Match the block including its comments exactly; if the whitespace differs, replace from `const phoneInput` through the closing `}` of the `if(phoneInput){…}`.)_

- [ ] **Step 5 — Validation (A5).** Replace the phone check (~1937-1942):
```js
  const phoneDigits=phone.replace(/[^\d]/g,'');
  if(!name||phoneDigits.length!==11){ 
    err.style.display='block'; 
    err.textContent=!name?'Por favor ingresá tu nombre.':'Número de WhatsApp inválido. Debe ser +504 seguido de 8 dígitos.'; 
    return; 
  }
```
with the **A5** block.

- [ ] **Step 6 — Submit (A6).** Replace (~2309):
```js
    customer_phone: document.getElementById('cphone').value.trim(),
```
with **A6** `customer_phone: fullPhone(),`.

- [ ] **Step 7 — Snapshot save (A7).** Replace the `fields: { … }` object (~2490) with the **A7** version (adds `cphoneCC:phoneCC`).

- [ ] **Step 8 — Snapshot restore (A8).** Replace (~2504):
```js
    setV('cname',snap.fields.cname); setV('cphone',snap.fields.cphone); setV('cemail',snap.fields.cemail);
```
with the **A8** block.

- [ ] **Step 9 — Manual verify (X. Pizza).** Open the form: the WhatsApp field shows `[+504 ▾] [9999-9999]`. Type 8 digits → `9999-9999`; submit-attempt with a wrong count → the N-digit error; correct → proceeds. Open the dropdown → pick **Estados Unidos +1** → placeholder `(555) 123-4567`, field clears; type 10 digits → US format. In devtools, `fullPhone()` returns `+1 (555) 123-4567`. No emoji in the control.

- [ ] **Step 10 — Commit**
```bash
git add xpizza-orders/index.html
git commit -m "feat(xpizza): country-code dropdown phone input (default +504, intl-capable)"
```

---

### Task 2: La Musa form (`la-musa-orders/index.html`)

Apply the **same Section-A code** at La Musa's anchors. The inserted code is byte-identical to Task 1 (the A-blocks); only the old-strings/lines differ. La Musa's `#cphone` currently has **no** `inputmode` — the A2 markup adds it (fine).

- [ ] **Step 1 — CSS (A1).** Insert the A1 block after the shared input rule (~line 617).

- [ ] **Step 2 — Markup (A2).** Replace (~1251):
```html
        <input type="tel" id="cphone" placeholder="+504 9999-9999" maxlength="14" autocomplete="tel"/>
```
with the **A2** block.

- [ ] **Step 3 — Component JS (A3).** Insert the **A3** block immediately before `function initCardFormatting(){` (~line 3800).

- [ ] **Step 4 — Formatter call (A4).** Inside `initCardFormatting()` (~3801-3822), replace the same phone block shown in Task 1 Step 4 (identical text) with `initPhoneControl();`.

- [ ] **Step 5 — Validation (A5).** Replace the phone check (~2412-2417, identical to Task 1 Step 5's old-string) with the **A5** block.

- [ ] **Step 6 — Submit (A6).** Replace (~2755) `customer_phone: document.getElementById('cphone').value.trim(),` with `customer_phone: fullPhone(),`.

- [ ] **Step 7 — Snapshot save (A7).** Replace the `fields: { … }` object (~2943) with the **A7** version.

- [ ] **Step 8 — Snapshot restore (A8).** Replace (~2956) `setV('cname',snap.fields.cname); setV('cphone',snap.fields.cphone); setV('cemail',snap.fields.cemail);` with the **A8** block.

- [ ] **Step 9 — Manual verify (La Musa).** Same checks as Task 1 Step 9, on the La Musa form.

- [ ] **Step 10 — Commit**
```bash
git add la-musa-orders/index.html
git commit -m "feat(lamusa): country-code dropdown phone input (default +504, intl-capable)"
```

---

### Task 3: Cross-form verification + push

- [ ] **Step 1 — JS syntax check both forms:**
```bash
node -e 'const fs=require("fs");for(const f of ["xpizza-orders","la-musa-orders"]){const h=fs.readFileSync(f+"/index.html","utf8");const re=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;let m,i=0,ok=1;while((m=re.exec(h))){i++;try{new Function(m[1])}catch(e){ok=0;console.log(f+" script#"+i+" FAIL: "+e.message)}}console.log(f+": "+(ok?("all "+i+" scripts parse OK"):"PARSE ERROR"))}'
```
Expected: both "parse OK".

- [ ] **Step 2 — E2E manual (both forms):** default Honduras 8-digit order submits with `customer_phone` starting `+504`; a US order (+1, 10 digits) submits with `customer_phone` starting `+1`; wrong-length blocks; dropdown open/close + outside-click; switching country clears the field; draft save → restore brings back the country + number; no emoji.

- [ ] **Step 3 — Push (do NOT merge/deploy):**
```bash
git push -u origin feature/intl-phone-input
```
Report the tip SHA to the advisor for the codex gate.

---

### Task 4: Gate + deploy (advisor + Xavier)

- [ ] **Advisor gate:** source-verify + **codex-on-diff** (standing discipline). Focus: the control always yields a valid full international `customer_phone`; Honduras flow unchanged; paste/backspace/country-switch/restore edges; no XSS in the dropdown render; both forms identical; `normalizePhone` compatibility.
- [ ] **Deploy (Xavier / advisor under go):** form-only, **both** sites — FF-merge → main → git-CD redeploys `orders.xpizza.hn` **and** `orders.lamusa.hn`. No functions deploy.
- [ ] **Post-deploy verify from source:** curl both origins; confirm the `cc-btn`/`cc-menu` markup + `PHONE_COUNTRIES` are live; on-device pass of a +504 and a +1 order.

---

## Self-review

- **Spec coverage:** dropdown control + config (A1-A3, T1/T2) ✓; local-only formatter, no force-prepend/cap (A3/A4) ✓; per-country validation (A5) ✓; full-number `customer_phone` (A6) ✓; snapshot save/restore the country (A7/A8) ✓; both forms (T1/T2) ✓; WhatsApp unchanged (noted) ✓; no emoji (A1/A2) ✓; codex gate + both-site deploy (T4) ✓.
- **Placeholder scan:** none — component code is fully specified in Section A; tasks give exact old-strings.
- **Name consistency:** `PHONE_COUNTRIES`, `phoneCC`, `phoneCountry`, `fmtPhoneLocal`, `fullPhone`, `initPhoneControl`, `window.__setPhoneCC`, `#cc-btn`, `#cc-menu`, `.cc-opt`, `cphoneCC` used consistently across A + T1 + T2. Reuses verified existing symbols: `initCardFormatting`, `#cphone`, `err`, `setV`, `v()`, `snap.fields`.
- **DRY note:** Section A is written once; Task 2 applies the identical code at La Musa's anchors (two 3400-line near-twin files) — the only per-form differences are the localStorage key (untouched) and La Musa gaining `inputmode` via A2.
```
