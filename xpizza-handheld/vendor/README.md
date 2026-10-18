# Vendored Firebase Web SDK 10.13.2 (PLAN-H1b ruling O-3)

Source: https://www.gstatic.com/firebasejs/10.13.2/{firebase-app,firebase-auth,firebase-database,firebase-functions}.js,
the same version and CDN the driver app imports in production. Fetched 2026-10-18.

ONE edit for offline loading (firebase-app.js is byte-exact upstream; its two in-file mentions of its own URL are a version name and a logger label, not imports): in firebase-auth.js, firebase-database.js and firebase-functions.js the absolute import
`https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js` is rewritten to `./firebase-app.js`. Nothing else changed.

Upstream SHA-256 (before the edit):
    7689323827fc416edc653dd06f6bd93314312ff5f71b1077a936e6803d7578d6  firebase-app.js
    09211458a3bd82b48e2f58f95c90008c9db715302c408c774118b934b4fa830e  firebase-auth.js
    0357cbb3419007a0e797d8e197e1b0c8eb64a375bef086a524337604dd348c24  firebase-database.js
    898a6119245b48c858f01f9b9b4ae61df6e200e86da426c02dc712dea2932072  firebase-functions.js

`SHA256SUMS` holds the vendored files' hashes; `npm --prefix xpizza-handheld test` verifies them (a mismatch is red).
