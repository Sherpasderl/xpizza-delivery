"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const PaymentTransaction_1 = __importDefault(require("./PaymentTransaction"));
class SaleTransaction extends PaymentTransaction_1.default {
    constructor() {
        super(...arguments);
        this.installment_type = undefined;
        this.installment_months = undefined;
        this.points_redeem_amount = undefined;
    }
    setInstallment(months, type) {
        this.installment_months = String(months);
        this.installment_type = type;
    }
    withPointsRedeemAmount(amount) {
        this.points_redeem_amount = Helpers_1.default.parseAmount(amount);
    }
}
exports.default = SaleTransaction;
//# sourceMappingURL=SaleTransaction.js.map