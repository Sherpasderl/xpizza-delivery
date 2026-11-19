"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("./Helpers"));
const version_1 = __importDefault(require("../version"));
class RequestBehaviour {
    constructor() {
        this.env = undefined;
        this.lang = undefined;
        this.from = undefined;
        this.sdk_version = undefined;
        this.sdk_key_pair = undefined;
        this.lang = Intl.DateTimeFormat().resolvedOptions().locale;
        this.from = 'sdk-javascript';
        this.sdk_version = version_1.default;
        if (this.lang != 'es' && this.lang != 'en') {
            this.lang = 'es';
        }
    }
    getSDKKeyPair() {
        return this.sdk_key_pair;
    }
    isEncryptable() {
        return false;
    }
    withEncryption(publicKey) {
        return null;
    }
    toJson() {
        return Helpers_1.default.objectToJson(this, ['sdk_key_pair']);
    }
}
exports.default = RequestBehaviour;
//# sourceMappingURL=RequestBehaviour.js.map