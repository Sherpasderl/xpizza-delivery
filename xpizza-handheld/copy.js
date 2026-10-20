// H1b — strings that are NOT in the prototype / boards, each approved: C-1 / C-2 (advisor 2026-10-16) and the six T7 strings
// (OWNER APPROVED 2026-10-18, exactly as written; the PIN is asked twice). The T7 copy guard allows exactly these on top of the
// spec text. Every other user-visible string is the prototype's or a board's, verbatim.
export const COPY = Object.freeze({
  pairRefused: 'No se pudo vincular este equipo. Pedile al dueño de la marca que revise la sucursal.',
  pinLocked: 'Demasiados intentos. Esperá 1 min y probá de nuevo.',
  pinRepeat: 'Repetí el PIN',
  pinMismatch: 'Los PIN no coinciden. Probá de nuevo.',
  saveFailed: 'No se pudo guardar. Probá de nuevo.',
  offlineReject: 'Sin conexión no se puede rechazar. Probá cuando vuelva la conexión.',
  offlineControl: 'Sin conexión no se puede cambiar el estado de la sucursal.',
  reconnected: (n) => (n === 1 ? 'Conexión restablecida · 1 acción enviada' : `Conexión restablecida · ${n} acciones enviadas`),
});
// from the boards / prototype, used verbatim
export const BOARD = Object.freeze({
  loginWrong: 'Correo o contraseña incorrectos. Revisalos e intentá de nuevo.',
  orderChanged: 'Este pedido cambió',
});
// The advisor's H1b driver / pay-line rulings (2026-10-18: Q-A / Q-B / Q-C / Q-D) — nameless variants of approved lines + one pay line
export const ADVISOR = Object.freeze({
  driverAssignedNameless: 'Repartidor asignado',
  driverAssigned: 'asignado',
  driverHere: 'está en el local',
  driverNameless: 'El repartidor',
  cashDelivery: 'paga en efectivo al recibir',
});
// OWNER DECISION 2026-10-19 (kiosk, WhatsApp removed — option c): board F5's offline detail line minus its now-false
// «ni escribirle al cliente» clause; nothing else changed. Pending the advisor's confirmation of the trimmed wording.
export const KIOSK = Object.freeze({
  offlineDetail: 'Sin conexión no se puede pedir más tiempo. «Listo» se guarda y se envía al volver.',
});
