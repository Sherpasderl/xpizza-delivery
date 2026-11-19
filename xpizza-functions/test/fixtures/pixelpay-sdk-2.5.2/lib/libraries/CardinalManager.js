"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const AuthTokenization_1 = __importDefault(require("../requests/AuthTokenization"));
const LookupContinueTransaction_1 = __importDefault(require("../requests/LookupContinueTransaction"));
const LookupTransaction_1 = __importDefault(require("../requests/LookupTransaction"));
const Environment_1 = __importDefault(require("../resources/Environment"));
const FailureResponse_1 = __importDefault(require("../responses/FailureResponse"));
const CardinalAuthentication_1 = __importDefault(require("../services/CardinalAuthentication"));
const PixelPayLoading_1 = __importDefault(require("./PixelPayLoading"));
const PixelPayModal_1 = __importDefault(require("./PixelPayModal"));
class CardinalManager {
    constructor(settings, request) {
        this.direct_api = false;
        this.settings = settings;
        this.transaction = request;
        this.service = new CardinalAuthentication_1.default(this.settings);
    }
    static clearAllEvents() {
        if (Helpers_1.default.checkIsBrowser()) {
            PixelPayLoading_1.default.hide();
            if (typeof window.Cardinal != 'undefined') {
                window.Cardinal.off('payments.setupComplete');
                window.Cardinal.off('payments.validated');
                window.Cardinal.onSetupCompleteBusy = false;
                window.Cardinal.onValidatedBusy = false;
            }
        }
    }
    async init(jwt, url) {
        if (url) {
            this.direct_api = true;
            this.collection_url = url;
            const secure_form = Helpers_1.default.addSecureForm(jwt, url);
            const result = await this.startCardinalDirectApiTransaction(secure_form).finally(() => {
                if (this.listen_direct_message) {
                    window.removeEventListener('message', this.listen_direct_message);
                }
                Helpers_1.default.removeElementById('step-up-form');
                Helpers_1.default.removeElementById('cardinal_collection_iframe');
                Helpers_1.default.removeElementById('cardinal_collection_form');
                PixelPayModal_1.default.hide();
                PixelPayLoading_1.default.hide();
            });
            return result;
        }
        const testing = this.settings.environment === Environment_1.default.SANDBOX || this.settings.environment === Environment_1.default.STAGING;
        const songbirdEnv = testing ? 'stag' : '';
        await Helpers_1.default.addScriptToWebsite(`https://songbird${songbirdEnv}.cardinalcommerce.com/edge/v1/songbird.js`);
        window.Cardinal.configure({
            payment: {
                framework: 'inline'
            },
            logging: {
                level: testing ? 'on' : 'off'
            },
        });
        window.Cardinal.onSetupCompleteBusy = false;
        window.Cardinal.onValidatedBusy = false;
        return await this.startCardinalTransaction(jwt, this);
    }
    startCardinalTransaction(jwt_setup, manager) {
        return new Promise((resolve, reject) => {
            try {
                window.Cardinal.on('payments.setupComplete', async (setupCompleteData) => {
                    if (window.Cardinal.onSetupCompleteBusy) {
                        return console.warn('Cardinal event "payments.setupComplete" is currently busy.');
                    }
                    window.Cardinal.onSetupCompleteBusy = true;
                    if (typeof setupCompleteData.sessionId == 'undefined'
                        || (typeof setupCompleteData.sessionId != 'undefined'
                            && (!setupCompleteData.sessionId || setupCompleteData.sessionId == ''))) {
                        throw new Error('Cardinal initial setup error.');
                    }
                    const lookup = new LookupTransaction_1.default();
                    lookup.fromPaymentTransaction(manager.transaction);
                    lookup.setRequiredEMVFields();
                    lookup.reference = setupCompleteData.sessionId;
                    const lookup_response = await manager.service.authenticationLookup(lookup);
                    manager.identifier = lookup_response?.data?.identifier;
                    manager.validationLookupResponse(lookup_response, resolve);
                    window.Cardinal.onSetupCompleteBusy = false;
                });
                window.Cardinal.on('payments.validated', async (data, jwt) => {
                    if (data?.ActionCode !== 'ERROR' && window.Cardinal.onValidatedBusy) {
                        return console.warn('Cardinal event "payments.validated" is currently busy.');
                    }
                    window.Cardinal.onValidatedBusy = true;
                    if (typeof jwt != 'undefined' && jwt && jwt != '') {
                        const lookup_continue = new LookupContinueTransaction_1.default();
                        lookup_continue.payload = jwt;
                        lookup_continue.identifier = manager.identifier;
                        lookup_continue.card_token = manager.transaction.card_token;
                        lookup_continue.authenticate_token = manager.transaction instanceof AuthTokenization_1.default;
                        const continue_response = await manager.service.authenticationContinue(lookup_continue);
                        if (lookup_continue.authenticate_token) {
                            CardinalManager.clearAllEvents();
                            return resolve(continue_response);
                        }
                        const result = await manager.service.retryTransaction(manager.transaction);
                        CardinalManager.clearAllEvents();
                        resolve(result);
                    }
                    else if (data.ActionCode == 'NOACTION') {
                        const result = await manager.service.retryTransaction(manager.transaction);
                        CardinalManager.clearAllEvents();
                        resolve(result);
                    }
                    else {
                        const failure = new FailureResponse_1.default();
                        failure.setStatus(520);
                        failure.message = `Cardinal validation failed. ${data.ErrorDescription} (${data.ErrorNumber})`;
                        failure.data = {};
                        CardinalManager.clearAllEvents();
                        resolve(failure);
                    }
                    window.Cardinal.onValidatedBusy = false;
                });
                window.Cardinal.on('ui.close', () => {
                    PixelPayModal_1.default.hide();
                });
                window.Cardinal.on('ui.inline.setup', (htmlTemplate, details, resolve, reject) => {
                    try {
                        let container;
                        if (htmlTemplate !== undefined && details !== undefined) {
                            switch (details.paymentType) {
                                case 'CCA':
                                    switch (details.data.mode) {
                                        case 'static':
                                            PixelPayModal_1.default.show();
                                            let el = document.querySelector('.pixelpay-modal');
                                            if (document.querySelector('[without-sdk-modal]')) {
                                                el = document.querySelector('[without-sdk-modal]');
                                            }
                                            container = el?.querySelector('.pixelpay-modal-container') || el;
                                            el?.setAttribute('data-size', details.data.challengeWindowSizeId);
                                            break;
                                        case 'suppress':
                                            PixelPayModal_1.default.hide();
                                            container = document.querySelector('.pixelpay-modal-container');
                                            break;
                                        default:
                                            throw new Error('Unsupported inline mode found [' + details.data.mode + ']');
                                    }
                                    break;
                                default:
                                    throw new Error('Unsupported inline payment type found [' + details.paymentType + ']');
                            }
                            if (container) {
                                container.innerHTML = htmlTemplate;
                            }
                            resolve();
                        }
                        else {
                            throw new Error('Unable to process request due to invalid arguments');
                        }
                    }
                    catch (error) {
                        reject(error);
                    }
                });
                window.Cardinal.setup('init', { jwt: jwt_setup });
            }
            catch (err) {
                CardinalManager.clearAllEvents();
                reject(err);
            }
        });
    }
    startCardinalDirectApiTransaction(secure_form) {
        return new Promise((resolve, reject) => {
            this.direct_api_resolve = resolve;
            this.direct_api_reject = reject;
            this.listen_direct_message = async (event) => {
                try {
                    if (event?.origin === this.settings.endpoint && event.data?.name === 'pixelpay_continue') {
                        return await this.handleDirectApiContinue(event);
                    }
                    if (event.origin !== new URL(this.collection_url).origin) {
                        return;
                    }
                    const event_data = Helpers_1.default.safeParse(event.data);
                    console.log('Received message from Cardinal Direct API:', event_data);
                    if (event_data?.MessageType === 'profile.completed') {
                        const checkMethod = async (startTime = Date.now()) => {
                            const methodUrl = event_data?.Payload?.DataSources?.MethodUrl;
                            const completed = event_data?.Status ?? methodUrl?.Completed;
                            const elapsed = Date.now() - startTime;
                            const delay = Math.min(500, (10000 - elapsed));
                            if (elapsed > 10000 || completed !== false) {
                                return await this.handleDirectApiLookup(event_data);
                            }
                            setTimeout(() => checkMethod(startTime), delay);
                        };
                        checkMethod();
                    }
                }
                catch (error) {
                    const failure = new FailureResponse_1.default();
                    failure.setStatus(520);
                    failure.message = 'No se pudo procesar la transacción, intenta de nuevo con otro dispositivo o navegador (1000)';
                    failure.data = Helpers_1.default.serialize(error);
                    reject(failure);
                }
            };
            window.addEventListener('message', this.listen_direct_message, false);
            secure_form.submit();
        });
    }
    async handleDirectApiContinue(event) {
        const error = event.data?.error;
        if (error) {
            const failure = new FailureResponse_1.default();
            failure.setStatus(520);
            failure.message = 'No se pudo procesar la transacción, intenta de nuevo con otro dispositivo o navegador (1001)';
            failure.data = Helpers_1.default.serialize(error);
            return this.direct_api_reject(failure);
        }
        const identifier = event.data?.identifier;
        if (!identifier) {
            const failure = new FailureResponse_1.default();
            failure.setStatus(520);
            failure.message = 'Identifier not found in the response.';
            failure.data = {};
            return this.direct_api_reject(failure);
        }
        this.identifier = identifier;
        PixelPayModal_1.default.hide();
        const result = await this.service.retryTransaction(this.transaction);
        return this.direct_api_resolve(result);
    }
    async handleDirectApiLookup(event_data) {
        const sessionId = event_data?.SessionId || event_data?.Payload?.SessionId;
        if (!sessionId) {
            const failure = new FailureResponse_1.default();
            failure.setStatus(520);
            failure.message = 'SessionId not found in the response.';
            failure.data = {};
            return this.direct_api_reject(failure);
        }
        const lookup = new LookupTransaction_1.default();
        lookup.fromPaymentTransaction(this.transaction);
        lookup.setRequiredEMVFields();
        lookup.card_cvv = this.transaction.card_cvv;
        lookup.reference = sessionId;
        const lookup_response = await this.service.authenticationLookup(lookup);
        this.identifier = lookup_response?.data?.identifier;
        await this.validationLookupResponse(lookup_response, this.direct_api_resolve);
        if (lookup_response.action === 'continue') {
            const { continue_url, continue_payload, window_size } = lookup_response.data;
            this.submitChallengeForm(continue_url, continue_payload, window_size, this.settings.auth_key);
        }
    }
    async validationLookupResponse(response, resolve) {
        this.transaction.authentication_identifier = this.identifier;
        if (!response.success || ['token_auth_success', 'token_auth_failed'].includes(response.action)) {
            CardinalManager.clearAllEvents();
            return resolve(response);
        }
        if (response.action != 'continue') {
            const result = await this.service.retryTransaction(this.transaction);
            CardinalManager.clearAllEvents();
            return resolve(result);
        }
        if (!this.direct_api) {
            window.Cardinal.continue('cca', {
                AcsUrl: response.data.continue_url,
                Payload: response.data.continue_payload,
            }, {
                OrderDetails: {
                    TransactionId: response.data.transaction_id,
                    OrderNumber: this.transaction.order_id,
                    CurrencyCode: this.transaction.order_currency,
                },
            });
        }
    }
    submitChallengeForm(continue_url, jwt, window_size, custom_data) {
        PixelPayModal_1.default.show();
        window_size = window_size ?? '02';
        const { width, height } = Helpers_1.default.convertWindowSizeToDimensions(window_size);
        let iframe = document.querySelector('iframe[name="step-up-iframe"]');
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.name = 'step-up-iframe';
        }
        iframe.width = width;
        iframe.height = height;
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
        let el = document.querySelector('.pixelpay-modal');
        if (document.querySelector('[without-sdk-modal]')) {
            el = document.querySelector('[without-sdk-modal]');
        }
        const container = el?.querySelector('.pixelpay-modal-container') || el;
        el?.setAttribute('data-size', window_size);
        if (!container) {
            return;
        }
        container.appendChild(iframe);
        const form = document.createElement('form');
        form.id = 'step-up-form';
        form.target = iframe.name;
        form.method = 'POST';
        form.action = continue_url;
        const jwtInput = document.createElement('input');
        jwtInput.type = 'hidden';
        jwtInput.name = 'JWT';
        jwtInput.value = jwt;
        form.appendChild(jwtInput);
        if (custom_data) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'MD';
            input.value = custom_data;
            form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
    }
}
exports.default = CardinalManager;
//# sourceMappingURL=CardinalManager.js.map