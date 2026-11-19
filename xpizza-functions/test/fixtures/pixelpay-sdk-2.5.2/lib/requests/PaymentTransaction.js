"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const tweetnacl_util_1 = __importDefault(require("tweetnacl-util"));
const Helpers_1 = __importDefault(require("../base/Helpers"));
const RequestBehaviour_1 = __importDefault(require("../base/RequestBehaviour"));
const FailedEncryptionException_1 = __importDefault(require("../exceptions/FailedEncryptionException"));
class PaymentTransaction extends RequestBehaviour_1.default {
    constructor() {
        super(...arguments);
        this.payment_uuid = undefined;
        this.card_token = undefined;
        this.card_number = undefined;
        this.card_cvv = undefined;
        this.card_expire = undefined;
        this.card_holder = undefined;
        this.billing_address = undefined;
        this.billing_country = undefined;
        this.billing_state = undefined;
        this.billing_city = undefined;
        this.billing_zip = undefined;
        this.billing_phone = undefined;
        this.customer_name = undefined;
        this.customer_email = undefined;
        this.customer_fingerprint = undefined;
        this.order_id = undefined;
        this.order_currency = undefined;
        this.order_amount = undefined;
        this.order_tax_amount = undefined;
        this.order_shipping_amount = undefined;
        this.order_content = [];
        this.order_extras = {};
        this.order_note = undefined;
        this.order_callback = undefined;
        this.authentication_request = false;
        this.authentication_identifier = undefined;
        this.secure_payload = undefined;
        this.apple_pay = undefined;
        this.google_pay = undefined;
        this.click_to_pay = undefined;
        this.source = undefined;
        this.tap_to_pay_device = undefined;
        this.tap_to_pay_request = false;
        this.before_execute = undefined;
    }
    setCard(card) {
        this.card_number = Helpers_1.default.cleanString(card.number);
        this.card_cvv = card.cvv2;
        this.card_expire = card.getExpireFormat();
        this.card_holder = Helpers_1.default.trimValue(card.cardholder);
    }
    setCardToken(token = null) {
        this.card_token = token;
    }
    setBilling(billing) {
        this.billing_address = Helpers_1.default.trimValue(billing.address);
        this.billing_country = billing.country;
        this.billing_state = billing.state;
        this.billing_city = Helpers_1.default.trimValue(billing.city);
        this.billing_zip = billing.zip;
        this.billing_phone = billing.phone;
    }
    setOrder(order) {
        this.order_id = order.id;
        this.order_currency = order.currency;
        this.order_amount = Helpers_1.default.parseAmount(order.amount);
        this.order_tax_amount = Helpers_1.default.parseAmount(order.tax_amount);
        this.order_shipping_amount = Helpers_1.default.parseAmount(order.shipping_amount);
        this.order_content = order.content;
        this.order_extras = order.extras;
        this.order_note = Helpers_1.default.trimValue(order.note);
        this.order_callback = order.callback_url;
        this.customer_name = Helpers_1.default.trimValue(order.customer_name);
        this.customer_email = order.customer_email;
    }
    withAuthenticationRequest() {
        this.authentication_request = true;
    }
    withTap2Pay(device) {
        this.tap_to_pay_request = true;
        if (device) {
            this.tap_to_pay_device = device;
        }
    }
    setBeforeExecute(callback) {
        this.before_execute = callback;
    }
    async doBeforeExecute() {
        if (this.before_execute) {
            await this.before_execute();
        }
    }
    isEncryptable() {
        return Boolean(this.card_number || this.card_cvv || this.card_expire || this.card_holder || this.card_expire);
    }
    withEncryption(publicKey) {
        if (!publicKey) {
            throw new FailedEncryptionException_1.default('Could not process transaction without merchant public key.');
        }
        try {
            const keyPair = this.sdk_key_pair ?? Helpers_1.default.getKeyPair();
            if (this.card_number)
                this.card_number = Helpers_1.default.encrypt(this.card_number, publicKey, keyPair);
            if (this.card_expire)
                this.card_expire = Helpers_1.default.encrypt(this.card_expire, publicKey, keyPair);
            if (this.card_cvv)
                this.card_cvv = Helpers_1.default.encrypt(this.card_cvv, publicKey, keyPair);
            if (this.card_holder)
                this.card_holder = Helpers_1.default.encrypt(this.card_holder, publicKey, keyPair);
            if (this.customer_email)
                this.customer_email = Helpers_1.default.encrypt(this.customer_email, publicKey, keyPair);
            const sdk_public_key = tweetnacl_util_1.default.encodeBase64(keyPair.publicKey);
            this.sdk_key_pair = keyPair;
            return sdk_public_key;
        }
        catch (error) {
            throw new FailedEncryptionException_1.default('Encryption process encountered an unexpected error.');
        }
    }
}
exports.default = PaymentTransaction;
//# sourceMappingURL=PaymentTransaction.js.map