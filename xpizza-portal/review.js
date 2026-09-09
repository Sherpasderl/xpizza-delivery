// Portal 2b-2b Task 5 — THE REVIEW SCREEN.
//
// 🔴🔴 MONEY. The last thing a merchant reads before their prices become what customers pay. Three
// ways it can lie, all of them silent:
//
//   WAS/NOW SWAPPED — it says 900→349 when the change is 349→900, and the merchant approves a rise
//   they read as a cut.
//   WRONG ROW — right numbers, wrong dish. Every value on screen is correct and the sentence is false.
//   BIG FLAG DERIVED HERE — the highlight and the acknowledgement set disagree, so the screen
//   emphasises one set of changes while the server demands confirmation of another.
//
// The defence against all three is the same: THIS FILE COMPUTES NOTHING ABOUT THE DIFF. It reads the
// server's `changed`, `added`, `removed` and `largeChangeSet` and arranges them. There is no local
// >50% rule, no re-derivation from the draft, no second opinion — the screen shows what the server
// decided, because that is what the token is bound to and what publishEdited will re-check.

// The acknowledgement set: the server's OWN objects, untouched.
//
// Not mapped, not filtered, not reshaped to {key,surface}. `ackMatches` compares membership in both
// directions and sentinel-collapses anything that is not an object with string key and surface, so a
// rebuilt list can only ever match by luck — and reshaping is precisely the client-side re-derivation
// this screen exists to avoid. Always an ARRAY: ackMatches refuses a non-array outright, so an empty
// set that collapsed to undefined would turn a valid modest publish into a 400.
export function ackSetFrom(diff) {
  const set = diff && diff.largeChangeSet;
  return Array.isArray(set) ? set : [];
}

const idOf = (x) => `${x && x.surface}::${x && x.key}`;

// The view model. Every row's `was`/`now` come from the server's `old`/`new` by name, and `big` is
// MEMBERSHIP in largeChangeSet keyed by surface AND key — an item and an extra can legitimately share
// a key, and flagging by key alone would light the wrong row.
export function reviewModel(diff) {
  const d = diff || {};
  const changed = Array.isArray(d.changed) ? d.changed : [];
  const added = Array.isArray(d.added) ? d.added : [];
  const removed = Array.isArray(d.removed) ? d.removed : [];
  const renamed = Array.isArray(d.renamed) ? d.renamed : [];
  const flagged = new Set(ackSetFrom(d).map(idOf));

  const rows = changed.map((c) => ({
    surface: c.surface,
    key: c.key,
    field: c.field,
    isPrice: c.field === 'price',
    was: c.old,
    now: c.new,
    big: flagged.has(idOf(c)),
    // direction is a statement about the two numbers, made once, so the screen never re-derives it
    direction: (typeof c.old === 'number' && typeof c.new === 'number')
      ? (c.new > c.old ? 'up' : (c.new < c.old ? 'down' : 'same'))
      : null,
    // The percentage is ARITHMETIC ON TWO SERVER NUMBERS, not a second opinion about the diff. It
    // presents old and new; it never decides whether a change is big. That decision stays with
    // `big`, which is membership in the server's own largeChangeSet.
    pct: (typeof c.old === 'number' && typeof c.new === 'number' && c.old > 0)
      ? Math.round(((c.new - c.old) / c.old) * 100)
      : null,
  }));

  return {
    rows,
    added,
    removed,
    renamed,
    // everything that will publish, so the header cannot understate it
    total: rows.length + added.length + removed.length + renamed.length,
  };
}

// ── DOM ────────────────────────────────────────────────────────────────────────────────────────
// createElement + textContent throughout. A dish name arrives from a merchant-editable document and
// reaches this screen unchanged; it is data, and this is the one screen a menu editor must not
// execute its own input on. There is no innerHTML in this file — asserted by the portal-wide sink
// guard, and again here by the review's own tests.
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const shown = (v) => (Number.isInteger(v) && v > 0 ? `L${v}` : (v === null || v === undefined ? '—' : String(v)));

export function renderReview(root, model) {
  root.replaceChildren();

  if (model.total === 0) {
    // An empty panel reads as a broken one. Say plainly that there is nothing to publish.
    root.append(el('div', 'empty', 'No hay cambios sin publicar.'));
    return root;
  }

  const groupHead = (label, count) => {
    const l = el('div', 'mglabel');
    l.append(el('span', null, label));
    l.append(el('span', 'mgn', String(count)));
    return l;
  };

  if (model.rows.length) {
    const g = el('div', 'mgroup');
    g.append(groupHead('Precios', model.rows.length));
    for (const r of model.rows) {
      const row = el('div', `prow${r.big ? ' big' : ''}`);
      row.dataset.k = `${r.surface}::${r.key}`;

      const main = el('div', 'pmain');
      main.append(el('div', 'pname', String(r.key)));      // textContent: a dish name is data
      // a non-price change still gets a row; the sub line names the field, so nothing publishes unseen
      if (!r.isPrice) main.append(el('div', 'psub', String(r.field)));
      if (r.pct !== null) {
        // AMBER for anything needing attention — a rise, or ANY change the server flagged, in either
        // direction. Green is reserved for a modest decrease. That is the mock's own rule
        // (`big || dpct >= 0 ? 'up' : 'dn'`) and it is the right way round: a price going up costs a
        // customer money, and a big drop costs the merchant.
        const tone = (r.big || r.pct >= 0) ? 'up' : 'dn';
        main.append(el('span', `pdelta ${tone}`, `${r.pct >= 0 ? '+' : ''}${r.pct}%`));
      }
      row.append(main);

      // WAS then NOW as separate nodes, so the order is structural rather than an assembled string
      // that could be built backwards.
      const val = el('div', 'pval');
      val.append(el('span', 'was', shown(r.was)));
      val.append(el('span', 'arr', '\u2192'));
      val.append(el('span', 'now', shown(r.now)));
      row.append(val);

      if (r.big) {
        // The server flagged it. The wording states what the merchant must DO; why the arithmetic
        // tripped is the server's business, the confirmation is theirs.
        const f = el('div', 'pflag');
        f.append(el('span', null, 'Cambio grande \u2014 confirmalo antes de publicar'));
        row.append(f);
      }
      g.append(row);
    }
    root.append(g);
  }

  for (const [list, label, chip, cls] of [
    [model.added, 'Nuevos', 'Nuevo', 'add'],
    [model.removed, 'Se eliminan', 'Elimina', 'rem'],
  ]) {
    if (!list.length) continue;
    const g = el('div', 'mgroup');
    g.append(groupHead(label, list.length));
    for (const x of list) {
      const r = el('div', `brow${cls === 'rem' ? ' rem' : ''}`);
      r.dataset.k = `${x.surface}::${x.key}`;
      r.append(el('span', `bchip ${cls}`, chip));
      r.append(el('span', 'bnm', String(x.key)));
      r.append(el('span', 'bval', shown(x.price)));
      g.append(r);
    }
    root.append(g);
  }

  if (model.renamed.length) {
    const g = el('div', 'mgroup');
    g.append(groupHead('Renombrados', model.renamed.length));
    for (const r of model.renamed) {
      const row = el('div', 'brow');
      row.append(el('span', 'bnm', String(r.from)));
      row.append(el('span', 'bval', `\u2192 ${r.to}`));
      g.append(row);
    }
    root.append(g);
  }
  return root;
}

// ── Task 6 — THE SAR ATTESTATION ─────────────────────────────────────────────────────────────────
// 🔴🔴 A merchant's signature that a change to a legal tax document is theirs. Three things are
// constantly conflated here, and each conflation is its own defect:
//
//   THE SEAL'S ROWS       every fiscal price change, from diff.changed where field === 'price'.
//   THE ACK SET           diff.largeChangeSet, verbatim, and frequently []. A 299→310 edit is a 3.7%
//                         swing: the seal lists it, the ack set is empty, and the publish carries
//                         fiscalAck:true WITH acknowledgedChanges: [].
//   WHETHER IT IS NEEDED  neither of the above.
//
// That last one is not a judgement call. publishEditedCore's fiscal gate reads usesPlatformFactura(rid)
// and NOTHING else — not the diff, not largeChangeSet, not `changed`. So a fiscal merchant needs
// fiscalAck for ANY publish, including one that changes no price at all.
//
// The plan says to show the seal "iff usesPlatformFactura AND ≥1 fiscal price change". That is one
// step too clever: the diff is against the LIVE version, so a draft can differ only in a description
// (an older draft, another editor), and requiring a price change would leave that publish facing a
// 403 the screen offers no way to clear. The seal is shown whenever the merchant is fiscal; when
// there are no price rows it says so.

// The rows the seal LISTS: price changes on either surface, from the server's own `changed`.
// Deliberately NOT largeChangeSet, which holds only >50%/new/zero and is empty for a modest edit.
export function fiscalPriceChanges(diff) {
  const changed = (diff && Array.isArray(diff.changed)) ? diff.changed : [];
  return changed.filter((c) => c && c.field === 'price').map((c) => ({
    surface: c.surface, key: c.key, was: c.old, now: c.new,
  }));
}

// `usesPlatformFactura` comes from the getEditableCatalog response (Task 2b). NEVER from the rid: a
// `rid === 'x_pizza'` literal is accidentally correct for every restaurant that exists today, which is
// exactly what makes it survive review — and wrong the day a third merchant joins the platform
// factura. Strictly `=== true`, so an absent or non-boolean flag is not read as a capability.
export function attestationModel(diff, ctx = {}) {
  const isFiscal = ctx.usesPlatformFactura === true;
  const sealRows = fiscalPriceChanges(diff);
  const ackSet = ackSetFrom(diff);
  // A price we cannot vouch for blocks the publish outright, ahead of any acknowledgement — the server
  // would refuse it anyway, and no signature should be collected for something that cannot go live.
  const hasZero = sealRows.some((r) => !(Number.isInteger(r.now) && r.now > 0));

  return {
    isFiscal,
    needsSeal: isFiscal,
    needsPlainAck: !isFiscal && ackSet.length > 0,
    needsAck: isFiscal || ackSet.length > 0,
    sealRows,
    ackSet,
    hasZero,
    // What the publish will send. Two separate fields for two separate facts: the attestation, and
    // the exact set of large changes the server flagged.
    fiscalAck: isFiscal,
  };
}

// Never with a zero price, and never before the confirmation it asked for.
export const canPublish = (model, acknowledged) => !model.hasZero && (!model.needsAck || acknowledged === true);

export function renderAttestation(root, model, onToggle) {
  root.replaceChildren();
  const checkbox = (cls, build) => {
    const label = el('label', cls);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => onToggle(cb.checked === true));
    label.append(cb);
    label.append(build());
    return label;
  };

  if (model.needsSeal) {
    const seal = el('div', 'seal');
    const h = el('div', 'sealh');
    h.append(el('div', 'sealbadge'));
    const ht = el('div');
    ht.append(el('b', null, 'Autorización fiscal · SAR'));
    // NO BRAND NAME. The seal is rendered for whichever merchant the server flagged, and hard-coding
    // one would be the same literal the capability flag exists to remove.
    ht.append(el('span', null, 'Estos precios se imprimen en tu factura fiscal'));
    h.append(ht);
    seal.append(h);

    const body = el('div', 'sealbody');
    body.append(el('p', null,
      'Como propietario, autorizás que estos precios se cobren en el documento tributario. La factura describe cada línea con el precio que publiques.'));
    for (const r of model.sealRows) {
      const c = el('div', 'seachg');
      c.append(el('span', 'sn', String(r.key)));          // textContent: a dish name is data
      const v = el('span', 'sv');
      v.append(el('span', 'was', shown(r.was)));
      v.append(el('span', 'arr', '→'));
      v.append(el('span', 'now', shown(r.now)));
      c.append(v);
      body.append(c);
    }
    if (!model.sealRows.length) {
      // Honest, and clearable: the merchant is fiscal, so the server will demand the attestation even
      // though this particular edit moves no price.
      body.append(el('p', 'seachg', 'Esta edición no cambia ningún precio, pero afecta el documento fiscal.'));
    }
    seal.append(body);

    // ONE checkbox. It is the fiscal attestation AND, when the server flagged large changes, their
    // confirmation — one signature over one reviewed set, rather than two boxes for one decision.
    seal.append(checkbox('attest', () => {
      const t = el('span', 'at');
      t.append(el('b', null, 'Autorizo'));
      const n = model.sealRows.length;
      t.append(n === 1
        ? ' este cambio de precio en la factura fiscal.'
        : (n === 0 ? ' esta edición en la factura fiscal.' : ` estos ${n} cambios de precio en la factura fiscal.`));
      return t;
    }));
    root.append(seal);
    return root;
  }

  if (model.needsPlainAck) {
    root.append(checkbox('ack', () => {
      const t = el('span', 'ackt');
      t.append(el('b', null, 'Confirmá los cambios grandes.'));
      // Real pluralisation rather than "cambio(s)": it reads better, and the parenthesised form parses
      // as a function call to the wiring guard that checks every call is defined or imported.
      const n = model.ackSet.length;
      t.append(` ${n} ${n === 1 ? 'cambio importante' : 'cambios importantes'}: ${model.ackSet.map((a) => a.key).join(', ')}`);
      return t;
    }));
  }
  return root;
}

// ── Task 6 Step 3b — THE PUBLISH PAYLOAD ─────────────────────────────────────────────────────────
// 🔴🔴 What actually leaves the browser to authorize a change to a legal tax document. Pure, so it is
// checked in node rather than only asserted about structurally: app.js hands it the review state and
// passes the result straight to publishEdited.
//
// TWO FIELDS, TWO QUESTIONS, and this is the pair that keeps being conflated:
//
//   acknowledgedChanges  the server's largeChangeSet, BY IDENTITY. Frequently []. Answers "which
//                        large changes did the merchant see?"
//   fiscalAck            true only when this merchant is fiscal AND the owner actually ticked
//                        Autorizo. Answers "did a legally responsible person sign?"
//
// A modest 299→310 on a fiscal merchant sends fiscalAck:true WITH acknowledgedChanges:[]. Neither
// field can be derived from the other.
export function publishPayload(review) {
  const att = (review && review.attestation) || {};
  return {
    rid: review && review.rid,
    editToken: review && review.editToken,
    // the server array itself — never a copy, a map or a rebuild
    acknowledgedChanges: Array.isArray(att.ackSet) ? att.ackSet : [],
    // STRICT on both halves. `isFiscal` is the server's capability flag; `acknowledged` is a literal
    // true or it is not a signature. The publish button being enabled is a UI state, not a guarantee —
    // it can be cleared from devtools — so the payload states what was actually signed rather than
    // what the screen looked like.
    fiscalAck: att.isFiscal === true && review.acknowledged === true,
  };
}

// ── Task 6 BLOCK — THE PUBLISHER, WITH A REAL IN-FLIGHT GUARD ────────────────────────────────────
// 🔴🔴 The double-publish race. The first version's only protection was `btn.disabled = true` — a UI
// STATE, which is exactly what the same code argues a gate must never be. `disabled` lives on the
// element: devtools clears it, a script never consults it, and a second dispatched click re-enters
// before the await resolves while the review state is still perfectly valid. The SAR publish goes
// twice.
//
// The lock is a closure value instead. It is taken BEFORE the await, so there is no window between
// deciding to send and sending; a second entry cannot get past it whatever the DOM says.
//
// It is released ONLY on failure. That asymmetry is the point: after a success the reviewed set is
// published and its token spent, so a second press must not re-send — the latch holds until a new
// review calls reset(). After a failure the merchant must be able to try again, and a permanent
// latch would strand them on an outage.
//
// Injected `publish` rather than importing publishEdited, so node can drive the whole path — real
// payload, real client, intercepted fetch — and assert the bytes that actually leave.
export function createPublisher({ publish }) {
  let inFlight = false;
  return {
    reset() { inFlight = false; },
    get busy() { return inFlight; },
    async run(review) {
      if (inFlight) return { skipped: 'in_flight' };
      // The same gate the button shows, re-asked here. The button being enabled is a UI state; this
      // is the decision. Fail closed on anything missing.
      if (!review || !review.attestation || !canPublish(review.attestation, review.acknowledged)) {
        return { skipped: 'not_ready' };
      }
      inFlight = true;
      try {
        const res = await publish(publishPayload(review));
        return { ok: true, res };            // stays LATCHED: the token is spent
      } catch (e) {
        inFlight = false;                    // released so a retry is possible
        throw e;
      }
    },
  };
}

// ── Task 7 — THE PUBLISH STATE MACHINE ───────────────────────────────────────────────────────────
// Every way a publish can end has to land somewhere the merchant can act on. The failure this guards
// against is not a wrong panel — it is NO panel: an unhandled code falling through to a toast, or to
// nothing at all, on the screen that decides whether their prices changed.

// What a panel's button MEANS. The caller decides how to carry it out; the panel only says which.
export const PUBLISH_ACTIONS = {
  RELOAD: 'reload',       // the DRAFT moved — fetch it again and re-apply
  REREVIEW: 'rereview',   // the LIVE version moved — call editCatalog for a fresh diff + token
  BACK: 'back',           // something on the review was not confirmed — return and tick it
  RETRY: 'retry',         // nothing about the edit was wrong — send the same payload again
};

// The six first-class states, each with its own explanation and its own way forward. The copy says
// what happened, what it means for the merchant's data, and what to do — in that order, because the
// first question anyone has after a failed publish is "did I lose my changes?".
const PANELS = {
  stale_edit: {
    icon: 'warn',
    title: 'Tu borrador cambió',
    // No reassurance about the DRAFT here — the draft moving under the merchant is precisely what
    // happened. What CAN be said honestly is that nothing was published.
    detail: 'Se guardó otra edición sobre este menú mientras revisabas, así que no publicamos nada. Recargá para traer la última versión y volvé a aplicar tu cambio — así no pisás lo que se guardó.',
    action: { id: PUBLISH_ACTIONS.RELOAD, label: 'Recargar y reaplicar' },
  },
  edit_superseded: {
    icon: 'info',
    title: 'Se revisó contra una versión vieja',
    // 🔴 REREVIEW, never RETRY. The token is bound to a diff that no longer describes reality;
    // retrying the publish would either fail again or succeed against state nobody reviewed.
    detail: 'El menú en vivo cambió desde que abriste esta revisión. Por seguridad no publicamos: revisá de nuevo los cambios contra la versión actual antes de confirmar.',
    action: { id: PUBLISH_ACTIONS.REREVIEW, label: 'Revisar de nuevo' },
  },
  large_change_unconfirmed: {
    icon: 'warn',
    title: 'Falta confirmar los cambios grandes',
    detail: 'Hay cambios de precio importantes que necesitan tu confirmación explícita. Tus cambios siguen guardados como borrador — volvé a la revisión y confirmá exactamente los que aparecen marcados.',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Volver a la revisión' },
  },
  not_owner: {
    icon: 'warn',
    title: 'Solo el propietario puede publicar un cambio fiscal',
    detail: 'Esta edición afecta la factura fiscal, y ese documento lo autoriza el propietario del local. Tus cambios quedan guardados como borrador: pedile al propietario que ingrese y los publique.',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Entendido' },
  },
  fiscal_ack_required: {
    icon: 'warn',
    title: 'Falta la autorización fiscal',
    detail: 'Para publicar precios que se imprimen en la factura fiscal hay que autorizarlos explícitamente. Nada cambió en vivo — volvé a la revisión y marcá "Autorizo".',
    action: { id: PUBLISH_ACTIONS.BACK, label: 'Volver a autorizar' },
  },
  store_unavailable: {
    icon: 'warn',
    title: 'No se pudo publicar',
    // 🔴 NOT "nada cambió en vivo". The request left the browser; the server may have committed
    // before the connection dropped. Asserting the live menu is untouched is a confident false
    // statement about a merchant's prices, and the one they would act on by publishing again.
    detail: 'El servicio de catálogo no respondió a tiempo. Tu borrador está guardado, pero no pudimos confirmar si el cambio llegó a publicarse — verificá tu menú en vivo antes de reintentar.',
    action: { id: PUBLISH_ACTIONS.RETRY, label: 'Reintentar' },
  },
};

// THE DEFAULT BRANCH, and it is the point of this function. Every other server code, every untyped
// throw, every shape that is not an error at all — all of them land here rather than nowhere. A
// merchant who cannot tell whether their prices changed is worse off than one reading a plain error.
const GENERIC = {
  icon: 'warn',
  title: 'No se pudo publicar',
  // Same reasoning as store_unavailable: an unclassified failure is INDETERMINATE. Only refusals the
  // server makes on the way in (auth, acknowledgement, staleness) are known to be pre-commit.
  detail: 'Algo falló y no pudimos confirmar el resultado. Tu borrador está guardado, pero puede que el cambio se haya publicado — verificá tu menú en vivo antes de reintentar.',
  action: { id: PUBLISH_ACTIONS.RETRY, label: 'Reintentar' },
};

// `op` is WHICH CALL FAILED — 'edit' (editCatalog) or 'publish' (publishEdited). It rides on the
// outcome so RETRY redoes the operation that actually failed. Both calls share most of their error
// surface, which is why routing them through the same panels is right; letting both RETRY buttons
// mean "publish" is not. A failed SAVE retried as a PUBLISH would push a reviewed-and-acknowledged
// set the merchant had already moved past.
export function outcomeFor(err, op = 'publish') {
  const code = (err && typeof err.code === 'string') ? err.code : null;
  const panel = (code && Object.prototype.hasOwnProperty.call(PANELS, code)) ? PANELS[code] : null;
  const base = { code, op, generic: !panel, ...(panel || GENERIC) };
  // An edit failure did not attempt a publish, so it must not describe one.
  if (op === 'edit' && base.title === 'No se pudo publicar') base.title = 'No se pudo guardar el borrador';
  return base;
}

// The receipt is built from the CAPTURED review, not the draft. On success the draft is discarded and
// the screen repaints — the publish IS the new baseline — so by the time this renders there is nothing
// pending left to read. Reading the draft would report zero changes on a successful publish.
export function receiptFor(res, captured) {
  const diff = (captured && captured.diff) || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const rows = arr(diff.changed);
  return {
    versionId: (res && typeof res.versionId === 'string' && res.versionId) ? res.versionId : null,
    // EVERY surface, not just `changed`. An added or removed item is genuinely a change, and a
    // receipt that counted only `changed` would read "estos 0 cambios" on a real publish the moment
    // an add/remove slice lands. Not reachable while the editor is price-only — which is exactly why
    // it would ship silently — so it is counted correctly now rather than left as a trap.
    count: rows.length + arr(diff.added).length + arr(diff.removed).length + arr(diff.renamed).length,
    rows,
  };
}

// SVG needs createElementNS — createElement would make an inert HTMLUnknownElement that draws nothing.
// The stylesheet animates `.rcheck svg` with a stroke-dasharray draw-in, so an absent icon is not just
// a missing tick: it is an empty circle where a confirmation should be.
function icon(paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths.split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  check: 'M20 6L9 17l-5-5',
  warn: 'M12 3l9 16H3z|M12 10v4|M12 17.5v.01',
  info: 'M21 12a9 9 0 11-6.2-8.5|M12 7v5l3 2',
};

export function renderReceipt(root, receipt) {
  root.replaceChildren();
  const r = el('div', 'receipt');
  const ck = el('div', 'rcheck');
  ck.append(icon(ICONS.check));
  r.append(ck);
  r.append(el('h3', null, 'Publicado'));
  r.append(el('p', null, receipt.count === 1
    ? 'Tu menú en vivo ya muestra este precio. Los clientes que ordenen ahora verán la nueva versión.'
    : `Tu menú en vivo ya muestra estos ${receipt.count} cambios. Los clientes que ordenen ahora verán la nueva versión.`));
  // The version id, when the server gave one. No "Ver en Historial" button: neither a Historial view
  // nor a rollback endpoint exists, and a control that does nothing is the failure this slice has been
  // guarding against since the 2b-2a switcher shipped display-only.
  if (receipt.versionId) {
    const vp = el('div', 'vpill');
    vp.append(el('span', null, 'Versión '));
    vp.append(el('b', null, receipt.versionId));
    r.append(vp);
  }
  root.append(r);
  return root;
}

export function renderOutcome(root, outcome, onAction) {
  root.replaceChildren();
  const box = el('div', 'conflict');
  const ic = el('div', `cicon ${outcome.icon}`);
  ic.append(icon(ICONS[outcome.icon] || ICONS.warn));
  box.append(ic);
  box.append(el('h3', null, outcome.title));      // textContent: even a hostile code is only ever text
  box.append(el('p', null, outcome.detail));
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn accent';
  b.textContent = outcome.action.label;
  b.addEventListener('click', () => onAction(outcome.action.id));
  box.append(b);
  root.append(box);
  return root;
}
