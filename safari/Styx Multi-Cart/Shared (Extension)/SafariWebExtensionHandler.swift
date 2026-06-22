//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Jared Goolsby on 5/18/26.
//
//  Bridges the web extension's service worker to the native App Store
//  entitlement. The host app (StoreManager) writes the entitlement into a
//  shared App Group after each StoreKit purchase; here we read it back when the
//  extension sends { action: "getEntitlement" } via browser.runtime
//  .sendNativeMessage. See lib/native-sync.js for the JS-side mapping.
//
//  The App Group id and key below MUST match StoreManager.appGroupID /
//  entitlementKey and the App Groups capability on both targets.
//

import SafariServices
import os.log

private let appGroupID = "group.com.jaredgoolsby.styx.multicart"
private let entitlementKey = "entitlement"

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        var responsePayload: [String: Any] = ["ok": false]

        if let dict = message as? [String: Any],
           let action = dict["action"] as? String,
           action == "getEntitlement" {
            responsePayload = readEntitlement()
            responsePayload["ok"] = true
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: responsePayload ]
        } else {
            response.userInfo = [ "message": responsePayload ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    /// Read the shared entitlement record. Returns a safe "free" default when
    /// nothing has been written yet (or the App Group is misconfigured) so the
    /// JS mapper always gets a well-formed object.
    private func readEntitlement() -> [String: Any] {
        guard let defaults = UserDefaults(suiteName: appGroupID),
              let stored = defaults.dictionary(forKey: entitlementKey) else {
            os_log(.default, "No shared entitlement found; defaulting to free.")
            return [
                "entitled": false,
                "productType": "",
                "expiresAt": 0,
                "willAutoRenew": false,
                "productId": "",
            ]
        }
        return stored
    }

}
