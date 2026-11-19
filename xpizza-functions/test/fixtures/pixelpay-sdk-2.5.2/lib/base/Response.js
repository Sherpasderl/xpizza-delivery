"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("./Helpers"));
class Response {
    constructor() {
        this.action = undefined;
        this.success = false;
        this.message = undefined;
        this.data = undefined;
        this.errors = undefined;
    }
    setStatus(status) {
        this.status = status;
    }
    getStatus() {
        return this.status;
    }
    inputHasError(key) {
        if (!this.errors) {
            return false;
        }
        return this.errors.hasOwnProperty(key);
    }
    getData(key) {
        if (!this.data) {
            return null;
        }
        if (!this.data.hasOwnProperty(key)) {
            return null;
        }
        return this.data[key] || null;
    }
    toJson() {
        return Helpers_1.default.objectToJson(this);
    }
}
exports.default = Response;
//# sourceMappingURL=Response.js.map