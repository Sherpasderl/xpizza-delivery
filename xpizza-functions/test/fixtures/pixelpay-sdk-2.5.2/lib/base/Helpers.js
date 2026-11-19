"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const tweetnacl_util_1 = __importDefault(require("tweetnacl-util"));
const crypto_js_1 = require("crypto-js");
exports.default = {
    objectToJson(value, ignore = []) {
        const filtered = { ...value };
        for (var propName in filtered) {
            if (filtered[propName] === null || filtered[propName] === undefined || ignore.includes(propName)) {
                delete filtered[propName];
            }
        }
        return JSON.stringify(filtered);
    },
    hash(algorithm, value) {
        switch (algorithm) {
            case 'MD5':
                return (0, crypto_js_1.MD5)(value).toString();
            case 'SHA-512':
                return (0, crypto_js_1.SHA512)(value).toString();
            default:
                return '';
        }
    },
    trimValue(value) {
        if (value) {
            return value.trim();
        }
        return null;
    },
    cleanString(value) {
        if (value) {
            return value.replace(/\s/g, '');
        }
        return null;
    },
    parseAmount(amount) {
        if (typeof amount == 'number' && amount > 0) {
            return String(amount);
        }
        return null;
    },
    getKeyPair() {
        return tweetnacl_1.default.box.keyPair();
    },
    encrypt(message, publicKey, keyPair) {
        if (!message || !publicKey) {
            return null;
        }
        if (message.includes('|')) {
            return message;
        }
        const nonce = tweetnacl_1.default.randomBytes(24);
        const merchantPublicKey = tweetnacl_util_1.default.decodeBase64(publicKey);
        const sharedKey = tweetnacl_1.default.box.before(merchantPublicKey, keyPair.secretKey);
        const box = tweetnacl_1.default.box.after(tweetnacl_util_1.default.decodeUTF8(message), nonce, sharedKey);
        const boxb64 = tweetnacl_util_1.default.encodeBase64(box);
        const nonceb64 = tweetnacl_util_1.default.encodeBase64(nonce);
        return `${boxb64}|${nonceb64}`;
    },
    checkIsBrowser() {
        return typeof window !== 'undefined' && typeof window.document !== 'undefined';
    },
    serialize(data) {
        const properties = Object.getOwnPropertyNames(data ?? {});
        return JSON.parse(JSON.stringify(data, properties));
    },
    safeParse(data) {
        if (typeof data === 'object') {
            return data;
        }
        try {
            return JSON.parse(data);
        }
        catch (error) {
            return null;
        }
    },
    addScriptToWebsite(src) {
        return new Promise((resolve, reject) => {
            const id = (0, crypto_js_1.MD5)(src).toString();
            const script = document.createElement('script');
            if (!document.querySelector(`script[id="${id}"]`)) {
                script.id = id;
                script.src = src;
                script.type = 'text/javascript';
                script.onload = resolve;
                script.onerror = reject;
                document.body.appendChild(script);
            }
            else {
                resolve(true);
            }
        });
    },
    addStylesById(id, css) {
        const el = document.getElementById(`styles-${id}`);
        if (el) {
            return;
        }
        const wrap = document.createElement('style');
        wrap.id = `styles-${id}`;
        wrap.innerHTML = css;
        document.head.appendChild(wrap);
    },
    addSecureForm(jwt, url) {
        const iframe = document.createElement('iframe');
        iframe.id = 'cardinal_collection_iframe';
        iframe.name = 'collectionIframe';
        iframe.height = '10';
        iframe.width = '10';
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        const form = document.createElement('form');
        form.id = 'cardinal_collection_form';
        form.method = 'POST';
        form.target = 'collectionIframe';
        form.action = url;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'JWT';
        input.value = jwt;
        form.appendChild(input);
        document.body.appendChild(form);
        return form;
    },
    removeElementById(id) {
        const element = document.getElementById(id);
        if (element) {
            element.remove();
        }
    },
    convertWindowSizeToDimensions(windowSize) {
        const dimensions = {
            '01': { width: '250', height: '400' },
            '02': { width: '390', height: '400' },
            '03': { width: '500', height: '600' },
            '04': { width: '600', height: '400' },
            '05': { width: '100%', height: '100%' },
        };
        return dimensions[windowSize || '02'] || { width: '390', height: '400' };
    },
};
//# sourceMappingURL=Helpers.js.map