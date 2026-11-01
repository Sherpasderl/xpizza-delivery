// REVIEW ONLY (review/portal-photos-b) — served in place of xpizza-portal/auth.js: a signed-in session, a fixed token.
export { authErrorMessage } from './auth-errors.js';
export const login = async () => {};
export const logout = async () => {};
export const watchAuth = (cb) => { setTimeout(() => cb({ uid: window.__shootUid || 'uShoot', email: 'dueno@ejemplo.test' }), 0); };
export const token = () => Promise.resolve('T');
