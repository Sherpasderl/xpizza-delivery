"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const InvalidCredentialsException_1 = __importDefault(require("../exceptions/InvalidCredentialsException"));
const FailedEncryptionException_1 = __importDefault(require("../exceptions/FailedEncryptionException"));
const RequestBehaviour_1 = __importDefault(require("./RequestBehaviour"));
const Response_1 = __importDefault(require("./Response"));
const ErrorResponse_1 = __importDefault(require("../responses/ErrorResponse"));
const FailureResponse_1 = __importDefault(require("../responses/FailureResponse"));
const InputErrorResponse_1 = __importDefault(require("../responses/InputErrorResponse"));
const NetworkFailureResponse_1 = __importDefault(require("../responses/NetworkFailureResponse"));
const NoAccessResponse_1 = __importDefault(require("../responses/NoAccessResponse"));
const NotFoundResponse_1 = __importDefault(require("../responses/NotFoundResponse"));
const PayloadResponse_1 = __importDefault(require("../responses/PayloadResponse"));
const PaymentDeclinedResponse_1 = __importDefault(require("../responses/PaymentDeclinedResponse"));
const PreconditionalResponse_1 = __importDefault(require("../responses/PreconditionalResponse"));
const SuccessResponse_1 = __importDefault(require("../responses/SuccessResponse"));
const TimeoutResponse_1 = __importDefault(require("../responses/TimeoutResponse"));
const PUBLIC_KEY_PATH = 'api/v2/merchant/public_key';
class ServiceBehaviour {
    constructor(settings) {
        this.settings = settings;
    }
    buildRequest(url, transaction) {
        if (!this.settings.auth_key || !this.settings.auth_hash) {
            throw new InvalidCredentialsException_1.default('The merchant credentials are not definied (key/hash).');
        }
        if (this.settings.environment != null) {
            transaction.env = this.settings.environment;
        }
        if (this.settings.lang != null) {
            transaction.lang = this.settings.lang;
        }
        if (this.settings.sdk != null) {
            transaction.from = this.settings.sdk;
        }
        if (this.settings.sdk_version != null) {
            transaction.sdk_version = this.settings.sdk_version;
        }
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'x-auth-key': this.settings.auth_key,
            'x-auth-hash': this.settings.auth_hash,
        };
        if (this.settings.auth_user) {
            headers['x-auth-user'] = this.settings.auth_user;
        }
        if (this.sdk_public_key) {
            headers['x-auth-secure'] = this.sdk_public_key;
        }
        if (this.settings.headers) {
            for (const header in this.settings.headers) {
                headers[header] = this.settings.headers[header];
            }
        }
        return axios_1.default.create({
            baseURL: this.settings.endpoint,
            timeout: 1000 * 60,
            headers,
            validateStatus: () => true,
        });
    }
    parseResponse(data, status) {
        let bag = new Response_1.default();
        switch (status) {
            case 200:
                bag = new SuccessResponse_1.default();
                break;
            case 202:
                bag = new PayloadResponse_1.default();
                break;
            case 400:
                bag = new ErrorResponse_1.default();
                break;
            case 401:
            case 403:
                bag = new NoAccessResponse_1.default();
                break;
            case 402:
                bag = new PaymentDeclinedResponse_1.default();
                break;
            case 404:
            case 405:
            case 406:
                bag = new NotFoundResponse_1.default();
                break;
            case 408:
                bag = new TimeoutResponse_1.default();
                break;
            case 412:
            case 418:
                bag = new PreconditionalResponse_1.default();
                break;
            case 422:
                bag = new InputErrorResponse_1.default();
                break;
            case 500:
                bag = new FailureResponse_1.default();
                break;
            default:
                if (status > 500) {
                    bag = new NetworkFailureResponse_1.default();
                }
                break;
        }
        bag.status = status;
        bag.action = data?.action || null;
        bag.success = data?.success || false;
        bag.message = data?.message || null;
        bag.data = data?.data || null;
        bag.errors = data?.errors || null;
        return bag;
    }
    exceptionResponse(e) {
        const response = new FailureResponse_1.default();
        response.status = 520;
        response.success = false;
        response.message = e.message;
        return response;
    }
    async validateEncryption(request) {
        if (!request.isEncryptable()) {
            return;
        }
        await this.validateMerchantPublicKey();
        this.validateSDKPublicKey(request);
    }
    async validateMerchantPublicKey() {
        let tries = 0;
        while (!this.settings.public_key && tries < 3) {
            this.settings.public_key = await this.fetchMerchantPublicKey();
            tries++;
        }
        if (this.settings.public_key == null) {
            throw new InvalidCredentialsException_1.default('Could not obtain necessary credentials for transaction.');
        }
    }
    validateSDKPublicKey(request) {
        let tries = 0;
        let lastError = null;
        while (!this.sdk_public_key && tries < 3 || tries === 0) {
            try {
                this.sdk_public_key = request.withEncryption(this.settings.public_key);
            }
            catch (err) {
                lastError = err;
            }
            finally {
                tries++;
            }
        }
        if (!this.sdk_public_key && lastError) {
            throw lastError;
        }
        if (!this.sdk_public_key) {
            throw new FailedEncryptionException_1.default('Could not process encryption, please try again.');
        }
    }
    async fetchMerchantPublicKey() {
        const response = await this.get(PUBLIC_KEY_PATH, new RequestBehaviour_1.default());
        if (response.success) {
            return response.getData('public_key');
        }
        return null;
    }
    getRoute(route) {
        return this.settings.endpoint + '/' + route;
    }
    async post(url, body) {
        try {
            await this.validateEncryption(body);
            const response = await this.buildRequest(url, body).post(url, JSON.parse(body.toJson()));
            return this.parseResponse(response.data, response.status);
        }
        catch (e) {
            return this.exceptionResponse(e);
        }
    }
    async put(url, body) {
        try {
            await this.validateEncryption(body);
            const response = await this.buildRequest(url, body).put(url, JSON.parse(body.toJson()));
            return this.parseResponse(response.data, response.status);
        }
        catch (e) {
            return this.exceptionResponse(e);
        }
    }
    async delete(url, body) {
        try {
            await this.validateEncryption(body);
            const response = await this.buildRequest(url, body).delete(url, {
                params: JSON.parse(body.toJson()),
            });
            return this.parseResponse(response.data, response.status);
        }
        catch (e) {
            return this.exceptionResponse(e);
        }
    }
    async get(url, body) {
        try {
            if (url !== PUBLIC_KEY_PATH) {
                await this.validateEncryption(body);
            }
            const response = await this.buildRequest(url, body).get(url, {
                params: JSON.parse(body.toJson()),
            });
            return this.parseResponse(response.data, response.status);
        }
        catch (e) {
            return this.exceptionResponse(e);
        }
    }
}
exports.default = ServiceBehaviour;
//# sourceMappingURL=ServiceBehaviour.js.map