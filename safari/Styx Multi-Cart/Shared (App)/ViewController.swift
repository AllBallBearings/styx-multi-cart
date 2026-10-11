//
//  ViewController.swift
//  Shared (App)
//
//  Created by Jared Goolsby on 5/18/26.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "com.jaredgoolsby.styx.multicart.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = false
#endif

        self.webView.configuration.userContentController.add(self, name: "controller")

        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        if #available(macOS 12.0, *) {
            Task {
                let json = await StoreManager.shared.productInfoJSON()
                await MainActor.run {
                    webView.evaluateJavaScript("showProducts(\(json))")
                }
            }
        }

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        guard let body = message.body as? String else { return }

        switch body {
        case "open-preferences":
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
                guard error == nil else {
                    // Insert code to inform the user that something went wrong.
                    return
                }
                DispatchQueue.main.async {
                    NSApp.terminate(self)
                }
            }

        case "buy-annual", "buy-lifetime":
            // App Store In-App Purchase for the premium unlock. The system
            // purchase sheet (with localized pricing) presents over this window.
            if #available(macOS 12.0, *) {
                let plan = (body == "buy-lifetime") ? "lifetime" : "annual"
                Task { await StoreManager.shared.purchase(planNickname: plan) }
            }

        case "open-privacy":
            NSWorkspace.shared.open(URL(string: "https://allballbearings.github.io/styx-multi-cart/privacy.html")!)

        case "open-terms":
            NSWorkspace.shared.open(URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)

        case "restore":
            if #available(macOS 12.0, *) {
                Task { await StoreManager.shared.restore() }
            }

        default:
            return
        }
#endif
    }

}
