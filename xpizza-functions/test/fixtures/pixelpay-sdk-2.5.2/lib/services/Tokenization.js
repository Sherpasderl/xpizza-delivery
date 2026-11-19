"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const RequestBehaviour_1 = __importDefault(require("../base/RequestBehaviour"));
const ServiceBehaviour_1 = __importDefault(require("../base/ServiceBehaviour"));
const PayloadResponse_1 = __importDefault(require("../responses/PayloadResponse"));
const SuccessResponse_1 = __importDefault(require("../responses/SuccessResponse"));
const PixelPayLoading_1 = __importDefault(require("../libraries/PixelPayLoading"));
const CardinalManager_1 = __importDefault(require("../libraries/CardinalManager"));
const InvalidTransactionTypeException_1 = __importDefault(require("../exceptions/InvalidTransactionTypeException"));
const BASE_CARD_PATH = 'api/v2/tokenization/card';
class Tokenization extends ServiceBehaviour_1.default {
    async vaultCard(card) {
        PixelPayLoading_1.default.show();
        const response = await this.post(BASE_CARD_PATH, card);
        PixelPayLoading_1.default.hide();
        return response;
    }
    async authCard(authentication) {
        if (!Helpers_1.default.checkIsBrowser()) {
            throw new InvalidTransactionTypeException_1.default("This platform not support 3DS transactions");
        }
        try {
            PixelPayLoading_1.default.show();
            const response = await this.post(BASE_CARD_PATH + '/auth', authentication);
            if (response instanceof SuccessResponse_1.default && response.data.authentication_identifier) {
                return response;
            }
            if (response instanceof PayloadResponse_1.default && response.data.transaction_type == 'songbird') {
                return await (new CardinalManager_1.default(this.settings, authentication)).init(response.data.payload, response.data.collection_url);
            }
            CardinalManager_1.default.clearAllEvents();
            return response;
        }
        catch (err) {
            CardinalManager_1.default.clearAllEvents();
            throw err;
        }
        finally {
            PixelPayLoading_1.default.hide();
        }
    }
    async updateCard(token, card) {
        PixelPayLoading_1.default.show();
        const response = await this.put(BASE_CARD_PATH + '/' + token, card);
        PixelPayLoading_1.default.hide();
        return response;
    }
    showCard(token) {
        return this.get(BASE_CARD_PATH + '/' + token, new RequestBehaviour_1.default());
    }
    showCards(tokens) {
        let str = tokens.join(':');
        return this.get(BASE_CARD_PATH + '/' + str.split(' ').join(''), new RequestBehaviour_1.default());
    }
    async deleteCard(token) {
        PixelPayLoading_1.default.show();
        const response = await this.delete(BASE_CARD_PATH + '/' + token, new RequestBehaviour_1.default());
        PixelPayLoading_1.default.hide();
        return response;
    }
}
exports.default = Tokenization;
//# sourceMappingURL=Tokenization.js.map