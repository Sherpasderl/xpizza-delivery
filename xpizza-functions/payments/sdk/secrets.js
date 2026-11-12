'use strict';
// The SDK payment configuration (PLAN-sdk-d4-r4 S0): ONE JSON secret — the repo forbids non-secret params
// (deploy-params.guard). The value is set by the owner (placeholder {"mode":"off"} ⇒ unconfigured); every function that can
// reach the SDK provider declares it (row 16).
const { defineSecret } = require('firebase-functions/params');
const SDK_PP_CONFIG = defineSecret('SDK_PP_CONFIG');
module.exports = { SDK_PP_CONFIG };
