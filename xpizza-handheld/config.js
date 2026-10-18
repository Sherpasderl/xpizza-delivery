// H1b — the Firebase web client config for the handheld: the SAME project and public client config the driver app ships
// (xpizza-driver/index.html: "apiKey is NOT a secret — it identifies the project"; access is gated by Auth + RTDB rules).
// MAPS_KEY: the Google Maps JS key for the driver ETA (eta.js). EMPTY until the owner adds this site's origin to a key's HTTP
// referrer allowlist (deploy step); while empty, the ETA is null → the name only, never a guessed time.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDWFYrzHvaNnRZERbN8jIuAzkY85daFJXU",
  authDomain: "xpizza-delivery.firebaseapp.com",
  databaseURL: "https://xpizza-delivery-default-rtdb.firebaseio.com",
  projectId: "xpizza-delivery",
  messagingSenderId: "185867271616",
  appId: "1:185867271616:web:84bb37552b40c1d517dc25"
};
export const FUNCTIONS_REGION = 'us-central1';
export const MAPS_KEY = '';
