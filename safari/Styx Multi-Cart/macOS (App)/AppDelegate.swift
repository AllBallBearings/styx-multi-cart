//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Jared Goolsby on 5/18/26.
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Boot the StoreKit listener + populate the shared entitlement so the
        // extension sees any existing purchase even if the user never opens the
        // buy UI this session.
        if #available(macOS 12.0, *) {
            StoreManager.shared.start()
        }
    }

    // The extension popup hands off premium purchases by opening
    // styxmulticart://purchase?plan=annual|lifetime (a custom URL scheme
    // registered in Info.plist). macOS routes that here, bringing the app
    // forward; we kick off the matching StoreKit purchase.
    func application(_ application: NSApplication, open urls: [URL]) {
        guard #available(macOS 12.0, *) else { return }
        for url in urls where url.scheme == "styxmulticart" {
            guard url.host == "purchase" else { continue }
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let plan = comps?.queryItems?.first(where: { $0.name == "plan" })?.value ?? "annual"
            NSApp.activate(ignoringOtherApps: true)
            Task { await StoreManager.shared.purchase(planNickname: plan) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

}
