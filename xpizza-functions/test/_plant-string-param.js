'use strict';
// deploy-params.guard.test.js's sensitivity plant: one non-secret param, preloaded into the census child only.
require('firebase-functions/params').defineString('TB_PLANTED_PARAM', { default: '' });
