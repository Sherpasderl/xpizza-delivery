// Portal 2b-2a — Firebase web init.
//
// The config is copied verbatim from xpizza-kitchen/index.html, the source of truth for every staff
// app: same project, same auth domain, so a merchant account is the same identity everywhere.
//
// The apiKey is NOT a secret — it identifies the project. Real access is gated by Firebase Auth plus,
// for everything this portal reads, a server-side owner check (authorizeCatalogEdit) and RTDB rules.
// A stolen apiKey buys nothing: without a token whose uid sits in restaurants/{rid}/owners, every read
// this portal makes returns 403.
//
// NO databaseURL, deliberately. The staff apps carry one because they talk to the Realtime Database
// directly; the portal never does — ownership and the catalog are both read server-side, through
// functions that check who is asking. Omitting it means getDatabase() cannot even be called without
// someone adding the capability back on purpose, and it keeps the CSP's connect-src honest: the portal
// is allowed to reach exactly the two auth hosts and our functions, and nothing else.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDWFYrzHvaNnRZERbN8jIuAzkY85daFJXU',
  authDomain: 'xpizza-delivery.firebaseapp.com',
  projectId: 'xpizza-delivery',
  messagingSenderId: '185867271616',
  appId: '1:185867271616:web:84bb37552b40c1d517dc25',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
