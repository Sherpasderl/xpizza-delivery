"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const Media = __importStar(require("../assets/media.json"));
const style = '.pixelpay-loading { margin: 0px; padding: 16px; display: flex; position: fixed; justify-content: center; flex-direction: column; align-items: center; z-index: 999998; background-color: rgba(0, 0, 0, 0.85); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); top: 0; right: 0; left: 0; bottom: 0; width: 100%; max-width: 100vw; transition: 0.3s opacity; visibility: hidden; opacity: 0; cursor: progress; }  .pixelpay-loading * { margin: 0px; padding: 0px; }  .pixelpay-loading>div { display: flex; width: 220px; max-width: 220px; justify-content: space-between; }  .pixelpay-loading>div>img { opacity: 0; transition-delay: 0.2s; transition-duration: 0.3s; }  .pixelpay-loading.show-loading>div>img:first-child { opacity: 1; }  .pixelpay-loading>div>img:last-child { transform: translateX(-32px); }  .pixelpay-loading.show-loading>div>img:last-child { opacity: 1; transform: translateX(0px); }  .pixelpay-loading>p { margin-top: 10px; width: 220px; height: 4px; border-radius: 2px; background-color: rgba(255, 255, 255, 0.2); box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.1); overflow: hidden; position: relative; }  .pixelpay-loading>p>span { display: block; position: absolute; content: ""; left: -200px; width: 200px; height: 4px; background-color: rgba(255, 255, 255, 0.95); animation: loadingBarSDK 1s linear infinite; -moz-animation: loadingBarSDK 1s linear infinite; -webkit-animation: loadingBarSDK 1s linear infinite; border-radius: 0.5rem; }  .pixelpay-loading.show-loading { visibility: visible; opacity: 1; }  .pixelpay-loading.show-loading.closing-loading { cursor: default; opacity: 0 !important; }  @keyframes loadingBarSDK { from { left: -200px; width: 30%; }  50% { width: 30%; }  70% { width: 70%; }  80% { left: 50%; }  95% { left: 120%; }  to { left: 100%; } }';
const Loading = {
    _container: () => {
        let container = document.querySelector('.pixelpay-loading');
        if (container) {
            return container;
        }
        container = document.createElement('div');
        container.classList.add('pixelpay-loading');
        container.innerHTML = `<div>
			<img alt="Powered by PixelPay®" src="${Media.logo}" width="120" height="40" />
			<img alt="Credit/Debit card" src="${Media.icon}" width="32" height="32" />
		</div>
		<p><span></span></p>`;
        document.querySelector('body')?.appendChild(container);
        Helpers_1.default.addStylesById('loading', style);
        return container;
    },
    show: () => {
        if (Helpers_1.default.checkIsBrowser()) {
            document.dispatchEvent(new Event('pxshowloading'));
            if (document.querySelector('[without-sdk-loading]')) {
                return;
            }
            Loading._container();
            setTimeout(() => {
                Loading._container().classList.add('show-loading');
            }, 100);
        }
    },
    hide: () => {
        if (Helpers_1.default.checkIsBrowser()) {
            document.dispatchEvent(new Event('pxhideloading'));
            if (document.querySelector('[without-sdk-loading]')) {
                return;
            }
            Loading._container().classList.add('closing-loading');
            setTimeout(() => {
                Loading._container().classList.remove('show-loading', 'closing-loading');
            }, 300);
        }
    },
};
exports.default = Loading;
//# sourceMappingURL=PixelPayLoading.js.map