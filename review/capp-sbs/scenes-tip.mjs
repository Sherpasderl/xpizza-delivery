// PLAN-capp-tip-step r6 — the tip step's side-by-sides vs MOCKUP-capp-tip-step-r2.html (owner-approved 11-09): frames 1 (L 20 preselected),
// 2 («Sin propina»), 3 («Otro monto» sheet), 3b («Otro · L 35»), 4 (a returning member's last tip, L 40). Frame 5 (cash) is superseded (owner 11-09: card-only tip). The mockup draws the
// INSTALLED app's v7 pay row in the step's footer, so these run like the S2 scenes: a bundle WITH the sdkPay flag, NATIVE runtime mode,
// the member seed (card on file), GEO for the pin. The member's last tip comes from the strict fixture leaf (fixtures.mjs s2Extra
// lastTip: u_ana's own path + the run's token only). Injections per scene as in CLASSIFICATION-S2.md (NATIVE + GEO; no STAND-IN).
import { MEMBER_SEED, memberExtra, s2Extra, chainExtra } from './fixtures.mjs';
import { s2frame, toCheckout, click, GEO, NATIVE } from './scenes-s2.mjs';
const TIP = 'MOCKUP-capp-tip-step-r2.html';
// the S2 frame clip + this mockup's own 44-px inset rule (.mk .screen>.topbar) at 0 — the app uses env(safe-area-inset-top), 0 in Chrome
// The frames sit in a horizontal strip whose scroll the clip mis-reads for the later figures (the SBS run 11-09: 3b / 4 / 5 clipped the
// neighbour) — so the device is lifted OUT of the strip: position:fixed at the viewport's top-left, then measured (no scrolling at all).
const tipFrame = (id) => (theme) => {
  const f = s2frame(TIP, id, 'tip-step r2')(theme);
  return { ...f,
    run: f.run.replace("document.head.appendChild(st); })()", "st.textContent += '.mk .screen>.topbar{height:56px!important;padding-top:0!important}'; document.head.appendChild(st); })()"),
    clip: `(() => { const f = document.getElementById(${JSON.stringify(id)}); if (!f) throw new Error('no frame ${id}');
  const d = f.querySelector('.device'), fr = f.querySelector('.device .frame'); if (!d || !fr) throw new Error('no device in ${id}');
  for (const e of [d, fr]) e.style.transition = 'none';
  Object.assign(d.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '99999', width: '410px', height: '864px', maxWidth: 'none', borderRadius: '0', boxShadow: 'none', margin: '0' });
  fr.style.borderRadius = '0'; f.querySelectorAll('.sbar').forEach((e) => { e.style.display = 'none'; });
  const r = fr.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` };
};
const toStep = [click('#cta'), { until: 'document.querySelector(".tipchips .chip[aria-pressed=true]")', ms: 10000 },
  { until: 'document.querySelector("[data-act=tip-place]:not([disabled])")', ms: 15000 }, { wait: 700 }];
const tip = (name, o) => ({ name, width: 390, height: 844, seed: MEMBER_SEED(), native: true, themes: ['light', 'dark'], geo: GEO, ...o,
  fixtures: { extra: chainExtra(memberExtra(), s2Extra({ lastTip: null, ...(o.s2 || {}) })) }, injections: [NATIVE, 'GEO'].join(' + ') });

export const TIP_SCENES = [
  tip('tip-1-default', { steps: [...toCheckout, ...toStep], mock: tipFrame('mk-1'), note: 'a member with no last tip ⇒ L 20 pressed' }),
  tip('tip-2-sin-propina', { steps: [...toCheckout, ...toStep, click('[data-act="tipc"][data-val="0"]'), { until: 'document.querySelector("[data-act=tip-place]:not([disabled])")', ms: 15000 }, { wait: 700 }], mock: tipFrame('mk-2') }),
  tip('tip-3-otro-sheet', { steps: [...toCheckout, ...toStep, click('[data-act="tipc"][data-val="other"]'), { until: 'document.querySelector("#layer [data-act=tk]")', ms: 8000 },
    click('#layer [data-act="tk"][data-val="3"]'), click('#layer [data-act="tk"][data-val="5"]'), { wait: 500 }], mock: tipFrame('mk-3') }),
  tip('tip-3b-otro-saved', { steps: [...toCheckout, ...toStep, click('[data-act="tipc"][data-val="other"]'), { until: 'document.querySelector("#layer [data-act=tk]")', ms: 8000 },
    click('#layer [data-act="tk"][data-val="3"]'), click('#layer [data-act="tk"][data-val="5"]'), click('#layer [data-act="tip-save"]'),
    { until: 'document.querySelector("[data-act=tip-place]:not([disabled])")', ms: 15000 }, { wait: 700 }], mock: tipFrame('mk-3b') }),
  tip('tip-4-member-last', { s2: { lastTip: 4000 }, steps: [...toCheckout, ...toStep], mock: tipFrame('mk-4'), note: 'the member\'s last tip (the fixture leaf: 4000) ⇒ L 40 pressed' }),
  // frame 5 (cash) is SUPERSEDED (OWNER 11-09, PLAN-capp-tip-step r7): the in-app tip is card-only — a cash delivery never reaches the step
];
