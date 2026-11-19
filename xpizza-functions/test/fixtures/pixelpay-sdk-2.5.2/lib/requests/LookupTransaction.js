"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const tweetnacl_util_1 = __importDefault(require("tweetnacl-util"));
const Helpers_1 = __importDefault(require("../base/Helpers"));
const RequestBehaviour_1 = __importDefault(require("../base/RequestBehaviour"));
const FailedEncryptionException_1 = __importDefault(require("../exceptions/FailedEncryptionException"));
const AuthTokenization_1 = __importDefault(require("./AuthTokenization"));
const SaleTransaction_1 = __importDefault(require("./SaleTransaction"));
class LookupTransaction extends RequestBehaviour_1.default {
    constructor() {
        super(...arguments);
        this.card_token = undefined;
        this.card_number = undefined;
        this.card_cvv = undefined;
        this.card_expire = undefined;
        this.billing_address = undefined;
        this.billing_country = undefined;
        this.billing_state = undefined;
        this.billing_city = undefined;
        this.billing_zip = undefined;
        this.billing_phone = undefined;
        this.customer_name = undefined;
        this.customer_email = undefined;
        this.order_id = undefined;
        this.order_currency = undefined;
        this.order_amount = undefined;
        this.installment = undefined;
        this.secure_payload = undefined;
        this.apple_pay = undefined;
        this.google_pay = undefined;
        this.click_to_pay = undefined;
        this.reference = undefined;
        this.browser_java_enabled = 'false';
        this.browser_header = undefined;
        this.browser_language = undefined;
        this.browser_color_depth = undefined;
        this.browser_screen_height = undefined;
        this.browser_screen_width = undefined;
        this.browser_time_zone = undefined;
        this.user_agent = undefined;
        this.ip_address = undefined;
        this.device_channel = 'Browser';
        this.browser_javascript_enabled = 'true';
        this.authenticate_token = false;
    }
    fromPaymentTransaction(request) {
        this.card_token = request.card_token;
        this.card_number = request.card_number;
        this.card_expire = request.card_expire;
        this.billing_address = request.billing_address;
        this.billing_country = request.billing_country;
        this.billing_state = request.billing_state;
        this.billing_city = request.billing_city;
        this.billing_zip = request.billing_zip;
        this.billing_phone = request.billing_phone;
        this.customer_name = request.customer_name;
        this.customer_email = request.customer_email;
        this.order_id = request.order_id;
        this.order_currency = request.order_currency;
        this.order_amount = request.order_amount;
        this.secure_payload = request.secure_payload;
        this.apple_pay = request.apple_pay;
        this.google_pay = request.google_pay;
        this.click_to_pay = request.click_to_pay;
        this.authenticate_token = request instanceof AuthTokenization_1.default;
        if (request instanceof SaleTransaction_1.default) {
            this.installment = request.installment_months;
        }
        this.sdk_key_pair = request.getSDKKeyPair();
    }
    setRequiredEMVFields() {
        if (!this.browser_java_enabled) {
            this.browser_java_enabled = typeof navigator.javaEnabled === "function"
                ? navigator.javaEnabled().toString()
                : 'false';
        }
        if (!this.browser_language) {
            this.browser_language = navigator.language;
        }
        if (!this.browser_color_depth) {
            this.browser_color_depth = screen.colorDepth.toString();
        }
        if (!this.browser_screen_height) {
            this.browser_screen_height = screen.height.toString() || window.innerHeight.toString();
        }
        if (!this.browser_screen_width) {
            this.browser_screen_width = screen.width.toString() || window.innerWidth.toString();
        }
        if (!this.browser_time_zone) {
            this.browser_time_zone = (new Date()).getTimezoneOffset().toString();
        }
        if (!this.user_agent) {
            this.user_agent = navigator.userAgent;
        }
    }
    isEncryptable() {
        return Boolean(this.card_number || this.card_expire || this.card_cvv || this.customer_email);
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
exports.default = LookupTransaction;
//# sourceMappingURL=LookupTransaction.js.map