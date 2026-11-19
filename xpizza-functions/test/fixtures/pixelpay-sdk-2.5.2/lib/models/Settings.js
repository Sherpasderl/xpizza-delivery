"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const Environment_1 = __importDefault(require("../resources/Environment"));
class Settings {
    constructor() {
        this.auth_key = undefined;
        this.auth_hash = undefined;
        this.auth_user = undefined;
        this.endpoint = undefined;
        this.environment = undefined;
        this.lang = undefined;
        this.sdk = undefined;
        this.sdk_version = undefined;
        this.headers = undefined;
        this.public_key = undefined;
        this.endpoint = 'https://pixelpay.app';
    }
    setupEndpoint(endpoint) {
        this.endpoint = endpoint;
    }
    setupCredentials(key, hash) {
        this.auth_key = key;
        this.auth_hash = hash;
    }
    setupPlatformUser(hash) {
        this.auth_user = hash;
    }
    setupEnvironment(env) {
        this.environment = env;
    }
    setupSandbox() {
        this.endpoint = 'https://pixelpay.dev';
        this.auth_key = '1234567890';
        this.auth_hash = Helpers_1.default.hash('MD5', '@s4ndb0x-abcd-1234-n1l4-p1x3l');
        this.environment = Environment_1.default.SANDBOX;
    }
    setupLanguage(lang) {
        this.lang = lang;
    }
    setupHeaders(headers) {
        this.headers = headers;
    }
}
exports.default = Settings;
//# sourceMappingURL=Settings.js.map