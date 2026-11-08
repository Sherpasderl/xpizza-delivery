'use strict';
// THE discriminator for SDK card orders (BRIEF r5 §2): every legacy money path refuses an order for which this is true,
// and routes its money to the SDK coordinator instead. payment_flow is written once by the server and is rules-immutable.
const SDK_FLOW = 'sdk_auth_v1';
const isSdkOrder = (order) => !!order && typeof order === 'object' && order.payment_flow === SDK_FLOW;
module.exports = { SDK_FLOW, isSdkOrder };
