'use strict';
// The SDK payment configuration (PLAN-sdk-d4-r4 S0): ONE JSON secret — the repo forbids non-secret params
// (deploy-params.guard). The value is set by the owner (placeholder {"mode":"off"} ⇒ unconfigured); every function that can
// reach the SDK provider declares it (row 16).
const { defineSecret } = require('firebase-functions/params');
const SDK_PP_CONFIG = defineSecret('SDK_PP_CONFIG');
// S5 (r3 #9): the guest-recovery WhatsApp sender, { instance_id, token } — bound ONLY to recoverOrderAccess (placeholder ⇒ 503)
const SDK_OTP_SENDER = defineSecret('SDK_OTP_SENDER');
module.exports = { SDK_PP_CONFIG, SDK_OTP_SENDER };
