// nav-view.js — pure HTML builders for the driver-app Cuenta + «App de navegación» screens (R7 nav preference).
// NO DOM, NO SDK, NO globals: every builder is a pure (inputs → string) function. index.html owns all wiring —
// the event listeners, showScreen routing, the drivers/{uid}/nav_app leaf write and the localStorage mirror.
// This mirrors the stacked-view.js / overview-map.js split so the screens are unit-testable and renderable in
// the capture harness exactly as they appear in the app.
//
// deps = { icons, esc } where `icons` carries the SVG strings { back, navi, chev, check, info, waze, gmaps }
// and `esc` is the host's HTML escaper. The builders never choose colours or fonts — those live in the app CSS
// (SLICE2:NAVPREF-CSS), keyed off the .set-* classes below.

// Cuenta (R7: MINIMAL — only the rows with a live effect): «App de navegación» → the picker, and «Cerrar sesión».
// `navLabel` is the human label of the current preference ('Waze' | 'Google Maps'), shown as the row's detail.
export function cuentaHtml(deps) {
  const { icons, esc, navLabel } = deps;
  return `
    <div class="set-top">
      <button class="set-back" id="cuenta-back" aria-label="Volver">${icons.back}</button>
      <div class="set-ttl">Cuenta</div>
      <span class="set-spacer"></span>
    </div>
    <div class="set-body">
      <div class="set-card">
        <div class="set-row" id="cuenta-navapp">
          <span class="set-ic">${icons.navi}</span>
          <div class="set-tx"><div class="set-t">App de navegación</div><div class="set-d">${esc(navLabel)} · turno a turno se abre afuera</div></div>
          <span class="set-chev">${icons.chev}</span>
        </div>
      </div>
      <div style="flex:1"></div>
      <button class="set-signout" id="cuenta-signout">Cerrar sesión</button>
    </div>`;
}

// «App de navegación» picker. ONE preference, default Waze. `sel` ('waze' | 'maps') marks the chosen option at
// build time; the host's paint() toggles `.sel` live on tap. «Guardar» commits (host writes nav_app + mirror).
export function navAppHtml(sel, deps) {
  const { icons } = deps;
  const wazeSel = sel === 'waze' ? ' sel' : '';
  const mapsSel = sel === 'maps' ? ' sel' : '';
  return `
    <div class="set-top">
      <button class="set-back" id="navapp-back" aria-label="Volver">${icons.back}</button>
      <div class="set-ttl">App de navegación</div>
      <span class="set-spacer"></span>
    </div>
    <div class="set-body">
      <p class="set-intro">El mapa del app es solo de referencia. Las indicaciones calle por calle se abren en la app que elijás, siempre hacia la parada actual.</p>
      <div class="set-opt${wazeSel}" id="navapp-waze">
        <span class="set-opt-logo">${icons.waze}</span>
        <span class="set-opt-tx">Waze<span class="set-opt-d">Mejor con tráfico en SPS</span></span>
        <span class="set-opt-ck">${icons.check}</span>
      </div>
      <div class="set-opt${mapsSel}" id="navapp-maps">
        <span class="set-opt-logo">${icons.gmaps}</span>
        <span class="set-opt-tx">Google Maps<span class="set-opt-d">Mejor para buscar referencias</span></span>
        <span class="set-opt-ck">${icons.check}</span>
      </div>
      <div class="set-flat" style="margin-top:2px">
        <div class="set-row" style="cursor:default">
          <span class="set-ic">${icons.info}</span>
          <div class="set-tx"><div class="set-t">Siempre podés abrir la otra</div><div class="set-d">Debajo de «Navegar» hay un enlace para la otra app, por si una falla</div></div>
        </div>
      </div>
      <div style="flex:1"></div>
    </div>
    <div class="set-foot"><button class="set-save" id="navapp-save">Guardar</button></div>`;
}
