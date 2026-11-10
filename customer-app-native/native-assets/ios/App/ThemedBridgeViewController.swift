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
}
