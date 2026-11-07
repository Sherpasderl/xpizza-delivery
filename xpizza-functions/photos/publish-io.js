'use strict';
// DISH PHOTOS A2 step 10 — the photos dependency of publishEdited (and requestPublish, which uses readActive only):
//   readActive (photos/edit-io) + prepare / hook / markPublished (photos/publish-photos) over the GCS copy adapter (photos/gcs-copy),
//   the public bucket from photos/buckets.js publicBucketName ('' / null = not configured → new pids fail closed).
// Local requires are STATIC (the portal import graph is pinned at import AND after a request — portal-split); firebase-admin stays lazy.
const { makePhotoEditIo } = require('./edit-io');
const { makePublishPhotos } = require('./publish-photos');
const { makeGcsCopy } = require('./gcs-copy');
const { publicBucketName, privateBucketName } = require('./buckets');   // codex r1 P1-1: the ONE bucket source

function makePublishIo({ fs, storage, publicBucket, privateBucket, now = Date.now }) {
  const edit = makePhotoEditIo({ fs, enabled: async () => false });
  const pub = makePublishPhotos({ fs, store: makeGcsCopy(storage, privateBucket), publicBucket, now });
  return { readActive: (rid, vid) => edit.readActive(rid, vid), prepare: pub.prepare, hook: pub.hook, markPublished: pub.markPublished };
}

function photoPublishIoForEdit() {
  const { getFirestore } = require('firebase-admin/firestore');
  const { getStorage } = require('firebase-admin/storage');
  return makePublishIo({ fs: getFirestore(), storage: getStorage(), publicBucket: () => publicBucketName(), privateBucket: privateBucketName() });
}

module.exports = { makePublishIo, photoPublishIoForEdit };
