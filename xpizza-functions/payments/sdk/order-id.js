'use strict';
// The SDK order-id NAMESPACE (advisor ruling replacing gate 0; NOTE-sdk-d4-order-id-namespace.md) — THE one definition.
// An SDK card order is created ONLY under `sdk_` + the app's id grammar (placeSdkOrder admits nothing else), and EVERY other
// order creator refuses ANY id with the prefix — so a cash / hosted request can never write over an SDK order. No minter can
// produce it: the forms' and the app's genOrderId emit an UPPERCASE prefix (the directory validates /^[A-Z]{2,5}$/) followed by
// digits, '-' and UPPERCASE characters.
const SDK_ORDER_ID_RE = /^sdk_\d{6}-\d{6}-[0-9A-HJKMNP-TV-Z]{8}$/;   // the app's genOrderId grammar (charset without I L O U)
const isSdkOrderId = (id) => typeof id === 'string' && SDK_ORDER_ID_RE.test(id);   // placeSdkOrder: admitted
const inSdkNamespace = (id) => typeof id === 'string' && /^sdk_/.test(id);          // every other creator: refused
module.exports = { SDK_ORDER_ID_RE, isSdkOrderId, inSdkNamespace };
