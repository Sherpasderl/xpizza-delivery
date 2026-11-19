"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Helpers_1 = __importDefault(require("../base/Helpers"));
const style = '.pixelpay-modal { font-family: -apple-system, BlinkMacSystemFont, avenir next, avenir, helvetica neue, helvetica, ubuntu, roboto, noto, segoe ui, arial, sans-serif; margin: 0px; padding: 16px; display: flex; position: fixed; justify-content: center; flex-direction: column; align-items: center; z-index: 999999; top: 0; right: 0; left: 0; bottom: 0; width: 100%; max-width: 100vw; transition: 0.3s opacity; visibility: hidden; opacity: 0; cursor: progress; border-radius: 3px; } .pixelpay-modal.open-modal { visibility: visible; opacity: 1; } .pixelpay-modal.open-modal .pixelpay-modal-container { transform: translateY(0); } .pixelpay-modal * { margin: 0px; padding: 0px; } .pixelpay-modal>p { width: 100%; min-width: 250px; max-width: 500px;  margin-top: 10px; height: 4px; border-radius: 2px; background-color: rgba(255, 255, 255, 0.2); box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.1); overflow: hidden; position: relative; } .pixelpay-modal>p>span { display: block; position: absolute; content: ""; left: -200px; width: 200px; height: 4px; background-color: rgba(255, 255, 255, 0.95); animation: loadingBarSDK 1s linear infinite; -moz-animation: loadingBarSDK 1s linear infinite; -webkit-animation: loadingBarSDK 1s linear infinite; border-radius: 0.5rem; } .pixelpay-modal .pixelpay-modal-container { display: block;  width: 100%; min-width: 250px; min-height: 400px; max-width: 500px; max-height: 600px;  margin: 0 auto; background-color: transparent; text-align: center; will-change: transform; transform: translateY(-15%); transition: 0.3s transform cubic-bezier(0, 0, 0.2, 1); border-radius: 3px; background-color: #fff; box-shadow: 0 6px 22px -3px #000; cursor: default; } .pixelpay-modal[data-size="01"] .pixelpay-modal-container { width: 250px; max-width: 250px; } .pixelpay-modal[data-size="02"] .pixelpay-modal-container { width: 390px; max-width: 390px; } .pixelpay-modal[data-size="03"] .pixelpay-modal-container { width: 500px; max-width: 500px; } .pixelpay-modal[data-size="04"] .pixelpay-modal-container { width: 600px; max-width: 600px; } .pixelpay-modal[data-size="05"] .pixelpay-modal-container { width: 100%; height: 100%; max-width: 100%; max-height: 100%; } .pixelpay-modal[data-size="01"]>p { width: 250px; } .pixelpay-modal[data-size="02"]>p { width: 390px; } .pixelpay-modal[data-size="03"]>p { width: 500px; } .pixelpay-modal[data-size="04"]>p { width: 600px; } .pixelpay-modal[data-size="05"]>p { width: 100%; } .pixelpay-modal .pixelpay-modal-container > iframe { display: block; } .pixelpay-modal-iframe { width: 100%; height: 100%; max-height: 100vh; background-color: #fff; opacity: 1; transition: opacity 0.3s ease; border-radius: 3px; } @keyframes rotating { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
const Modal = {
    is_open: false,
    el: null,
    _init: () => {
        Modal.is_open = false;
        Modal.el = document.querySelector('body .pixelpay-modal');
        if (!Modal.el) {
            Modal.el = Modal._createModalElement();
        }
        return Modal.el;
    },
    _createContainer: () => {
        const container = document.createElement('div');
        container.classList.add('pixelpay-modal-container');
        container.setAttribute('aria-modal', 'true');
        return container;
    },
    _createLoading: () => {
        const overlay = document.createElement('p');
        overlay.innerHTML = '<span></span>';
        return overlay;
    },
    _createModalElement: () => {
        const modal = document.createElement('div');
        modal.classList.add('pixelpay-modal');
        modal.setAttribute('aria-hidden', 'true');
        modal.appendChild(Modal._createContainer());
        modal.appendChild(Modal._createLoading());
        document.querySelector('body')?.appendChild(modal);
        Helpers_1.default.addStylesById('modal', style);
        return modal;
    },
    show: () => {
        if (Helpers_1.default.checkIsBrowser()) {
            document.dispatchEvent(new Event('pxshowmodal'));
            if (document.querySelector('[without-sdk-modal]')) {
                return;
            }
            Modal._init();
            setTimeout(() => {
                Modal.el.classList.add('open-modal');
                Modal.el.setAttribute('aria-hidden', 'true');
                Modal.is_open = true;
            }, 100);
        }
    },
    hide: () => {
        if (Helpers_1.default.checkIsBrowser()) {
            document.dispatchEvent(new Event('pxshowmodal'));
            if (document.querySelector('[without-sdk-modal]')) {
                return;
            }
            Modal._init();
            setTimeout(() => {
                Modal.el.classList.remove('pixelpay-modal-fullscreen');
                Modal.el.classList.remove('open-modal');
                Modal.el.setAttribute('aria-hidden', 'false');
                const frame = Modal.el.querySelector('.pixelpay-modal-iframe');
                if (frame) {
                    frame.parentNode.removeChild(frame);
                }
                Modal.is_open = false;
                Modal.el.dispatchEvent(new Event('onclose'));
            }, 300);
        }
    },
};
exports.default = Modal;
//# sourceMappingURL=PixelPayModal.js.map