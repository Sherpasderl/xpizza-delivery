// Test double for xpizza-delivery.js used ONLY by the perf gate harness (dispatch-maps-perf.mjs) to boot the
// real index.html headless with no backend: authorizes a dispatcher and streams one seeded order/task/driver.
const RESTAURANT = { name: 'X Pizza', lat: 15.5, lng: -88.0, geofence_radius_m: 300 };
let authGuard = null; let authUser = { uid: 'disp1', email: 'disp@x.com' };
export function initDelivery(){}
export function onAuth(cb){ setTimeout(() => cb(authUser), 0); }
export async function isDispatcher(){ return true; }
export function getAuthInstance(){ return { get currentUser(){ return authUser; }, app: {} }; }
export function setAuthedRequestGuard(fn){ authGuard = fn; }
export async function signOutUser(){ authUser = null; }
export function getDb(){ return {}; }
const order = { order_id: 'o1', customer_name: 'Cli', total: 100, lat: 15.5, lng: -88.0, created_at: Date.now(), address_detected: 'x', payment_status: 'paid' };
const tasks = { o1_delivery: { order_id:'o1', type:'delivery', status:'pending', assigned_driver_id:null, created_at: Date.now() }, o1_pickup: { order_id:'o1', type:'pickup', status:'pending', assigned_driver_id:null, created_at: Date.now() } };
const drivers = { drv1: { active:true, name:'Ana', status:'available', lat:15.5, lng:-88.0, last_ping: Date.now() } };
export function subscribeToOrders(cb){ setTimeout(()=>cb({ o1: order }),0); return ()=>{}; }
export function subscribeToTasks(cb){ setTimeout(()=>cb(tasks),0); return ()=>{}; }
export function subscribeToDrivers(cb){ setTimeout(()=>cb(drivers),0); return ()=>{}; }
export function subscribeToScheduledOrders(cb){ cb({}); return ()=>{}; }
export function subscribeToManualReconciliation(cb){ cb({}); return ()=>{}; }
export function subscribeToDriverCash(cb){ cb({}); return ()=>{}; }
export function subscribeToOrderControl(cb){ cb({}); return ()=>{}; }
export function subscribeToServerTimeOffset(cb){ cb(0); return ()=>{}; }
export function subscribeToDispatcherAlerts(cb){ cb({}); return ()=>{}; }
export function subscribeToIncomingMessages(cb){ cb({}); return ()=>{}; }
export function subscribeToAutoAssignEnabled(cb){ cb(false); return ()=>{}; }
export async function setAutoAssignEnabled(){}
export async function fetchRestaurantName(){ return 'X Pizza'; }
export async function fetchOrderById(){ return { ok:false }; }
export function isStalePing(){ return false; }
export function formatStaleness(){ return ''; }
export function formatStatus(){ return ''; }
export function formatStatusShort(){ return ''; }
export async function dismissDispatcherAlert(){}
export const MAP_UNAVAILABLE_MSG = 'Mapa no disponible — reintentá. El tablero sigue en vivo.';
export { RESTAURANT };
export const DRIVER_STATUS = { OFF_SHIFT:'off_shift', AVAILABLE:'available', AT_RESTAURANT:'at_restaurant', EN_ROUTE_DELIVERY:'en_route_delivery', RETURNING:'returning', ASSIGNED:'assigned' };
export const ORDER_STATUS = { PENDING_PAYMENT:'pending_payment' };
export const TASK_STATUS = { PENDING:'pending', ACCEPTED:'accepted', COMPLETED:'completed', CANCELLED:'cancelled' };
export const TASK_TYPE = { PICKUP:'pickup', DELIVERY:'delivery' };
export const PAYMENT_STATUS = {};
export const PAYMENT_ATTEMPT_STATUS = {};
export const NON_LIVE_ORDER_STATUSES = new Set(['pending_payment','scheduled','releasing']);
export const ACCEPT_TIMEOUT_MS = 60000;
