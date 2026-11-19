"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const PaymentTransaction_1 = __importDefault(require("./PaymentTransaction"));
class AuthTokenization extends PaymentTransaction_1.default {
    setOrder(order) {
        this.order_id = order.id;
        this.order_currency = order.currency;
        this.order_amount = Helpers_1.default.parseAmount(order.amount);
    }
}
exports.default = AuthTokenization;
//# sourceMappingURL=AuthTokenization.js.map