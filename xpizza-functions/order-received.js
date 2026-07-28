'use strict';

// Pure decision core for the order-received WhatsApp (sendOrderStatusNotifications). TRUE only for the
// live-transition ('new') of an ONLINE order that carries a phone: cash/pickup already got the message
// inline from createOrder (payment_method !== 'online' → no double-send), and non-'new' statuses
// (preparing/ready/out_for_delivery/delivered/cancelled/…) must NOT re-notify. Null/absent order → false.
function shouldSendOrderReceived(order, after) {
  return after === 'new'
    && !!order
    && order.payment_method === 'online'
    && !!order.customer_phone;
}

module.exports = { shouldSendOrderReceived };
