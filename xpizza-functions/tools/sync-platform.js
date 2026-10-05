'use strict';
// P-SELFUPDATE — copy the canonical platform manifest (<repo>/platform/{sites,compat}.json) into this functions folder
// (./platform/), byte-for-byte. Functions deploy only this folder. platform-sync.guard.test.js fails on drift.
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', '..', 'platform');
const DST = path.join(__dirname, '..', 'platform');
fs.mkdirSync(DST, { recursive: true });
for (const f of ['sites.json', 'compat.json']) fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
console.log('sync-platform: copied sites.json + compat.json');
