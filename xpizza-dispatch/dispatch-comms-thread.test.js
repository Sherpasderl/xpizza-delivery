// xpizza-dispatch/dispatch-comms-thread.test.js
import assert from 'node:assert';
import { assembleThread } from './dispatch-comms-thread.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  const t = assembleThread({
    inbound: [
      { body: '¿ya viene?', received_at: 200 },       // chat, ms
      { type: 'image', body: null, time: 1 },          // non-chat: time=1s → 1000ms, body null
    ],
    autoEvents: [{ label: 'Pedido recibido', at: 100 }],
  });
  assert.deepStrictEqual(t, [
    { kind: 'auto', text: 'Pedido recibido', ts: 100 },
    { kind: 'in', text: '¿ya viene?', ts: 200 },
    { kind: 'in', text: '(media)', ts: 1000 },         // time*1000, media fallback text
  ]);
  ok('merges chat(received_at) + non-chat(time*1000) + auto; media fallback');
}
{
  const t = assembleThread({ inbound: [{ body: 'x' }], autoEvents: [] });  // no received_at, no time
  assert.deepStrictEqual(t, []);
  ok('drops inbound with no orderable timestamp');
}
{
  assert.deepStrictEqual(assembleThread({}), []);
  ok('empty input → empty thread');
}

console.log(`\n${pass} passed`);
