import UIKit
import Capacitor

// PLAN-capp-dark-mode §4: the view and the web view paint the THEME's page colour before the CSS — the "PageBackground" colour asset
// (Any = the light --page-bg, Dark = the dark one), so the hand-off from the launch screen never shows a white frame. Main.storyboard's
// bridge controller is this class (platform/native/apply-native-assets.js sets it).
class ThemedBridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let bg = UIColor(named: "PageBackground")
        view.backgroundColor = bg
        webView?.isOpaque = false
        webView?.backgroundColor = bg
        webView?.scrollView.backgroundColor = bg
    }

    // «Abrir Ajustes» (MOCKUP-capp-push r1 F2c; Codex r1 P2-9, advisor ruling (a)): the first-party plugin lives in this file (already in
    // the App target), registered as the bridge loads
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppSettingsPlugin())
    }
}

// THIS app's page in the phone's Settings (where its notification permission lives) — UIApplication.openSettingsURLString
@objc(AppSettingsPlugin)
public class AppSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppSettingsPlugin"
    public let jsName = "AppSettings"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)]

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { call.reject("settings_unavailable"); return }
            UIApplication.shared.open(url, options: [:]) { ok in ok ? call.resolve() : call.reject("settings_unavailable") }
        }
    }
}
