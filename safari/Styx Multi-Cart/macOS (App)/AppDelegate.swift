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
    // styxmulticart://purchase (a custom URL scheme registered in Info.plist).
    // macOS routes that here and we only bring the app window forward. The
    // purchase itself starts when the user taps a plan button, so the plan
    // title, length, price and the Privacy Policy / Terms of Use links stay
    // readable instead of being covered by the system purchase sheet at once
    // (App Store Guideline 3.1.2(c)).
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "styxmulticart" && url.host == "purchase" {
            NSApp.unhide(nil)
            NSApp.activate(ignoringOtherApps: true)
            if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                if window.isMiniaturized { window.deminiaturize(nil) }
                window.makeKeyAndOrderFront(nil)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

}
