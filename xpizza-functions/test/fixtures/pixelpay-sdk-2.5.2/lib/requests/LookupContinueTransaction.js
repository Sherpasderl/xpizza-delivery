"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const RequestBehaviour_1 = __importDefault(require("../base/RequestBehaviour"));
class LookupContinueTransaction extends RequestBehaviour_1.default {
    constructor() {
        super(...arguments);
        this.identifier = undefined;
        this.payload = undefined;
        this.card_token = undefined;
        this.authenticate_token = false;
    }
}
exports.default = LookupContinueTransaction;
//# sourceMappingURL=LookupContinueTransaction.js.map