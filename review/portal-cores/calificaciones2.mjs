// REVIEW ONLY — the «Calificaciones» STEP 2 SBS backend (advisor 11-15). Every call the page makes is answered by REAL cores, loaded by the
// lane's own calificaciones2-harness.mjs FROM THE WORKTREE UNDER REVIEW (3a reviews v2 at the lane's pinned REF; 5f's getMyBranchesCore,
// the owner by the REAL roster writer). The world is written by the REAL writers only (intake, status mirror, fulfilment stamp,
// rateOrderCore, setMyName, the ratings config writer, the bucket builder, the public_stats producer). The page runs on the harness clock
// (`clock` = NOW = Sun 15 Nov 2026 18:00 HN — the mockup's «today»).
// Scenarios: list (tab 1/2/3/6) · below (tab 4: 6 named in the window) · notlive (tab 5: no config write) · loading (tab 7: the reviews
// and the earlier comments held) · error (tab 8: public_stats unreadable ⇒ the real core's 503; the earlier comments still answer).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NAMES = [['Ana', 'Pérez'], ['Luis', 'Reyes'], ['Karla', 'Suazo'], ['Jorge', 'Valle'], ['Marvin', 'Ortiz'], ['Daniela', 'Castro'], ['Roberto', 'Aguilar'],
  ['Sofía', 'López'], ['Óscar', 'Torres'], ['María', 'Juárez'], ['Guadalupe', 'Mejía'], ['Pedro', 'Ramos']];
const COMMENTS = ['Llegó caliente y rápido. Todo bien.', 'Muy rica la pizza, solo tardó un poquito más de lo que decía la app.', null,
  'La lasaña estaba buenísima. Vamos a volver a pedir.', 'Llegó fría y le faltó la salsa extra que pedí.',
  'Pedimos para la oficina y llegó todo completo y a tiempo. La margarita estaba muy rica y el pan de ajo también. Lo único es que las bebidas venían tibias; tal vez podrían mandarlas aparte, con hielo o en una bolsa fría. De todos modos, buen servicio y seguro volvemos a pedir la próxima semana.',
  'Buena comida, pero la caja venía un poco aplastada.', null, 'Se equivocaron de pedido y nadie contestó el teléfono.', 'Todo perfecto, gracias.', 'Rico, pero un poco salado el calzone.', 'La mejor pizza de la zona.'];
const STARS = [5, 4, 5, 5, 2, 4, 3, 5, 1, 5, 4, 5];
const EARLIER = [[5, 'Siempre bien. El postre es un 10.'], [4, 'Buena pizza, llegó a tiempo.'], [2, 'Pedí sin cebolla y venía con cebolla.'], [5, 'Excelente atención y la comida llegó bien empacada.']];

export async function backend(root) {
  const H = await import(pathToFileURL(path.join(root, 'xpizza-portal', 'calificaciones2-harness.mjs')).href);
  const { NOW, CUT, DAY, UIDS, RW } = H;
  let W = null;
  async function earlier(db) { for (let i = 0; i < EARLIER.length; i += 1) await H.rated(db, UIDS[20 + i], `XPZ-e${i}`, { at: CUT - (30 + i) * DAY, store: EARLIER[i][0], comment: EARLIER[i][1], disclosure: undefined }); }
  async function named(db, n) {
    const w = RW.windowOf(4, NOW);
    for (let i = 0; i < 12; i += 1) await H.named(db, UIDS[i], NAMES[i][0], NAMES[i][1]);
    for (let i = 0; i < n; i += 1) {
      const c = COMMENTS[i % COMMENTS.length];
      await H.rated(db, UIDS[i], `XPZ-n${String(i).padStart(2, '0')}`, { at: (i < 3 ? NOW - (1 + i) * DAY : w.start + (2 + i * 2) * DAY), store: STARS[i % 12], comment: c === null ? undefined : c });
    }
  }
  async function reset(scn) {
    const live = scn !== 'notlive';
    const db = await H.world({ live: false });
    await earlier(db);   // the earlier (v1) comments: written BEFORE the owner's config write (r6.2: no clock trust)
    if (live) {
      await H.goLive(db);
      if (scn === 'below') { await named(db, 6); for (let i = 0; i < 8; i += 1) await H.rated(db, UIDS[12 + i], `XPZ-o${i}`, { at: NOW - (60 + i) * DAY, store: 5 }); }
      else await named(db, 14);
    }
    await H.buildBuckets(db); await H.publishStats(db); await H.publishStats(db, 'xp_sur');
    if (scn === 'error') { const real = db.ref.bind(db); db.ref = (p = '') => (String(p).startsWith('public_stats') ? { ...real(p), once: async () => { throw new Error('injected outage'); }, get: async () => { throw new Error('injected outage'); } } : real(p)); }
    const e1 = await H.discovery({ branches: { x_pizza: 'Centro', xp_sur: 'Los Próceres' } });
    W = { scn, srv: H.server(db, { e1, now: NOW }) };
  }
  async function call({ fn, method, query }) {
    if (!['getMerchantReviews', 'getMerchantRatingComments', 'getMyBranches'].includes(fn)) return null;   // a gap (logged), never a canned answer
    if (W.scn === 'loading' && fn !== 'getMyBranches') await new Promise(() => {});
    const qs = new URLSearchParams(query || {}).toString();
    const r = await W.srv.fetch(`https://us-central1-xpizza-delivery.cloudfunctions.net/${fn}${qs ? `?${qs}` : ''}`, { method: method || 'GET', headers: { Authorization: 'Bearer ownerX' } });
    return { status: r.status, body: await r.json() };
  }
  return { reset, call, clock: NOW };
}
