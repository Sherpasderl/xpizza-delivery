// ONE source for the driver's clock format «7:16» (12h convention, no am/pm). es-HN + hour12:false yields the hour
// with no leading zero and a 2-digit minute, matching the prototype (and 24h for afternoon, e.g. «15:30»). Used by the
// cuadre receipt date line and the disponible «desde las {time}» header — flip the spec here and both follow.
export function fmtClockHM(ms) {
  return new Date(ms).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: false });
}
