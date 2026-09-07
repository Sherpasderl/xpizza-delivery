// Portal 2b-2a — auth. Thin wrappers over the Firebase SDK plus one piece of real logic: the error
// message map, which is the only place a login screen can leak something it should not.
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdToken,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import { auth } from './firebase.js';

import { authErrorMessage } from './auth-errors.js';
export { authErrorMessage };

export const login = (email, pass) => signInWithEmailAndPassword(auth, email, pass);
export const logout = () => signOut(auth);
export const watchAuth = (cb) => onAuthStateChanged(auth, cb);
// Never cached and never logged: an ID token is a bearer credential with a short life, and the SDK
// already refreshes it. Callers ask for one per request.
export const token = () => (auth.currentUser ? getIdToken(auth.currentUser) : Promise.resolve(null));
