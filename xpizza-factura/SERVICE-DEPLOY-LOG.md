# Factura Print Agent — Windows Service Deployment Log

**Date:** 2026-06-26
**Machine:** XPIZZA (Surface Pro, Windows 11 Pro 10.0.26100)
**Result:** ✅ Live. Service running, auto-start enabled, real test factura **000-001-01-00000003** printed perfectly on the Epson TM-T20IV.

This is a record of what was actually done on the Surface so the other (decision/code) session has ground truth. No code or factura logic was changed here — only deployment/runtime config.

---

## Outcome (verified)

- `Get-Service XPizzaFacturaAgent` → **Status: Running, StartType: Automatic**
- `agent.log` tail:
  ```
  [agent] watching /facturas/x_pizza as XPizza:13424
  [print] 000-001-01-00000003 (PRUEBA-1782532823367) OK
  ```
- Physical paper: **confirmed printed** (FACTURA DE PRUEBA, total L520.00, EFECTIVO, cambio L80.00).
- Service runs as **LocalSystem (Session 0)** and reaches the USB printer fine — so the "run as `.\sherp` user" fallback (step 6 in the task brief) was **NOT needed**.

---

## What was changed

### 1. `.env` — absolute creds path
Services are cwd-sensitive, so the relative path was made absolute:
```
GOOGLE_APPLICATION_CREDENTIALS=C:\Users\sherp\xpizza-delivery\xpizza-factura\serviceAccount.json
```
(Other `.env` values unchanged: `USB_VID=0x04B8`, `USB_PID=0x0E39`, `RESTAURANT_ID=x_pizza`, `FB_DATABASE_URL=…firebaseio.com`.)

### 2. Power settings (elevated)
```
powercfg /change standby-timeout-ac 0
powercfg /hibernate off
```

### 3. NSSM service (elevated)
Service name: **`XPizzaFacturaAgent`**

| Parameter      | Value |
|----------------|-------|
| Application    | `C:\Program Files\nodejs\node.exe` |
| AppParameters  | `C:\Users\sherp\xpizza-delivery\xpizza-factura\print_agent.js` |
| AppDirectory   | `C:\Users\sherp\xpizza-delivery\xpizza-factura` |
| AppStdout      | `C:\Users\sherp\xpizza-delivery\xpizza-factura\agent.log` |
| AppStderr      | `C:\Users\sherp\xpizza-delivery\xpizza-factura\agent.log` |
| Start          | `SERVICE_AUTO_START` |
| Account        | LocalSystem |

---

## ⚠️ Deviations from the task brief (important)

1. **NSSM location is different.** The brief said `C:\Users\sherp\Downloads\nssm-2.24\win64\nssm.exe` — **that path does not exist on this machine.** NSSM was installed earlier via `winget install NSSM.NSSM`, and the actual binary used is:
   ```
   C:\Users\sherp\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe
   ```
   `nssm` is also on PATH for **newly opened** shells. The service's binPath points at this winget nssm.

2. **The service already existed** before this run (Stopped, partially configured, binPath already = winget nssm — created in a prior elevated step). It was **reconfigured in place** (all params re-set) rather than removed/reinstalled.

3. **Elevation:** the Claude session shell is non-admin and non-interactive, so all elevated steps (powercfg + nssm) were run as a single script launched with a UAC prompt that Xavier approved.

---

## How to manage the service later

`nssm` is on PATH in a new shell; otherwise use the full winget path above. Service ops need an **elevated** PowerShell.

```powershell
Get-Service XPizzaFacturaAgent                 # status
nssm restart XPizzaFacturaAgent                # restart (e.g. after a code pull)
nssm stop XPizzaFacturaAgent                   # stop
Get-Content "C:\Users\sherp\xpizza-delivery\xpizza-factura\agent.log" -Tail 30   # logs
```

Reprint test (normal, non-admin shell):
```powershell
cd C:\Users\sherp\xpizza-delivery\xpizza-factura
npm run test-order
```

> Note: the agent logs both stdout and stderr to the single `agent.log` file. Each test-order increments the sequence (next will be 000-001-01-00000004).

---

## Still open / unchanged

- Still in **temp CAI** mode (`is_temp:true`, `cai_code:TEMP-CAI-PENDIENTE-SAR`, range 000-001-01-00000001 … 00008000, fecha_limite 31/12/2026). CAI go-live swap is unchanged and remains the other session's call (see `SETUP.md` §7 / handoff §10).
- The live auto-fire wiring (createOrder trigger, order-form RTN fields, `/facturas` deny rules) is a separate concern owned by the other session — untouched here.
