"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ServiceBehaviour_1 = __importDefault(require("../base/ServiceBehaviour"));
const SaleTransaction_1 = __importDefault(require("../requests/SaleTransaction"));
const AuthTransaction_1 = __importDefault(require("../requests/AuthTransaction"));
const InvalidTransactionTypeException_1 = __importDefault(require("../exceptions/InvalidTransactionTypeException"));
class CardinalAuthentication extends ServiceBehaviour_1.default {
    free() {
        CardinalAuthentication.runningTransaction = null;
    }
    authenticationLookup(transaction) {
        return this.post('api/v2/cardinal/authentication/lookup', transaction);
    }
    authenticationContinue(transaction) {
        return this.post('api/v2/cardinal/authentication/continue', transaction);
    }
    async retryTransaction(transaction) {
        await transaction.doBeforeExecute();
        if (CardinalAuthentication.runningTransaction) {
            return CardinalAuthentication.runningTransaction;
        }
        if (!(transaction instanceof SaleTransaction_1.default) && !(transaction instanceof AuthTransaction_1.default)) {
            this.free();
            throw new InvalidTransactionTypeException_1.default('The request payment type is invalid.');
        }
        const url = `api/v2/transaction/${transaction instanceof SaleTransaction_1.default ? 'sale' : 'auth'}`;
        CardinalAuthentication.runningTransaction = this.post(url, transaction).finally(this.free);
        return CardinalAuthentication.runningTransaction;
    }
}
CardinalAuthentication.runningTransaction = null;
exports.default = CardinalAuthentication;
//# sourceMappingURL=CardinalAuthentication.js.map