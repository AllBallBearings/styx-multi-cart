//
//  StoreManager.swift
//  Shared (App)
//
//  StoreKit 2 purchase + entitlement bridge for the App Store (Safari) build.
//
//  Apple guideline 3.1.1 requires digital unlocks to use In-App Purchase, so
//  the premium tier on Safari is bought here in the native host app (StoreKit
//  cannot run inside the web extension or its popup). After every purchase or
//  Transaction.update we recompute the entitlement and write it into the shared
//  App Group, where SafariWebExtensionHandler reads it back for the extension's
//  service worker (see lib/native-sync.js for the JS-side mapper).
//
//  Product IDs and the App Group id below MUST match App Store Connect and the
//  App Groups capability configured on both the app and extension targets.
//  See docs/internal/IAP-SETUP.md.
//

import Foundation
import StoreKit

@available(macOS 12.0, iOS 15.0, *)
final class StoreManager {

    static let shared = StoreManager()

    // Keep these in sync with App Store Connect product identifiers.
    static let annualID = "com.jaredgoolsby.styx.multicart.pro.annual"
    static let lifetimeID = "com.jaredgoolsby.styx.multicart.pro.lifetime"
    static let productIDs = [annualID, lifetimeID]

    // Shared App Group — also set as the suite name in
    // SafariWebExtensionHandler. Keep both in sync with the capability.
    static let appGroupID = "group.com.jaredgoolsby.styx.multicart"
    static let entitlementKey = "entitlement"

    private(set) var products: [Product] = []
    private var updatesTask: Task<Void, Never>?

    private init() {}

    /// Call once at app launch. Starts the transaction listener and does an
    /// initial entitlement refresh so the App Group is populated even if the
    /// user never opens the purchase UI this session.
    func start() {
        if updatesTask == nil {
            updatesTask = listenForTransactions()
        }
        Task {
            await loadProducts()
            await refreshEntitlement()
        }
    }

    func loadProducts() async {
        do {
            products = try await Product.products(for: Self.productIDs)
        } catch {
            NSLog("[Styx Multi-Cart] loadProducts failed: \(error)")
        }
    }

    /// Begin a purchase for the given plan nickname ("annual" | "lifetime").
    /// Drives the system purchase sheet; on success we finish the transaction
    /// and refresh the shared entitlement.
    func purchase(planNickname: String) async {
        let id = (planNickname == "lifetime") ? Self.lifetimeID : Self.annualID

        var product = products.first(where: { $0.id == id })
        if product == nil {
            product = try? await Product.products(for: [id]).first
        }
        guard let product else {
            NSLog("[Styx Multi-Cart] purchase: product \(id) not found")
            return
        }

        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                if case .verified(let transaction) = verification {
                    await transaction.finish()
                    await refreshEntitlement()
                }
            case .userCancelled, .pending:
                break
            @unknown default:
                break
            }
        } catch {
            NSLog("[Styx Multi-Cart] purchase failed: \(error)")
        }
    }

    /// Restore purchases (App Review requires an explicit restore path for
    /// non-consumables). Syncs with the App Store then refreshes entitlement.
    func restore() async {
        try? await AppStore.sync()
        await refreshEntitlement()
    }

    private func listenForTransactions() -> Task<Void, Never> {
        Task.detached { [weak self] in
            for await update in Transaction.updates {
                if case .verified(let transaction) = update {
                    await transaction.finish()
                    await self?.refreshEntitlement()
                }
            }
        }
    }

    /// Walk the user's current entitlements, distill to a single record, and
    /// write it to the shared App Group. Lifetime beats subscription if both
    /// are somehow present.
    func refreshEntitlement() async {
        var hasLifetime = false
        var subActive = false
        var subExpiresMs: Double = 0

        for await result in Transaction.currentEntitlements {
            guard case .verified(let t) = result, t.revocationDate == nil else { continue }
            switch t.productID {
            case Self.lifetimeID:
                hasLifetime = true
            case Self.annualID:
                if let exp = t.expirationDate {
                    if exp > Date() {
                        subActive = true
                        subExpiresMs = exp.timeIntervalSince1970 * 1000
                    }
                } else {
                    subActive = true
                }
            default:
                break
            }
        }

        let entitled = hasLifetime || subActive
        let productType = hasLifetime ? "lifetime" : (subActive ? "subscription" : "")
        let expiresAt = hasLifetime ? 0 : subExpiresMs

        var willAutoRenew = false
        if !hasLifetime && subActive {
            willAutoRenew = await annualWillAutoRenew()
        }

        let productId = hasLifetime ? Self.lifetimeID : (subActive ? Self.annualID : "")

        writeEntitlement(
            entitled: entitled,
            productType: productType,
            expiresAt: expiresAt,
            willAutoRenew: willAutoRenew,
            productId: productId
        )
    }

    private func annualWillAutoRenew() async -> Bool {
        var product = products.first(where: { $0.id == Self.annualID })
        if product == nil {
            product = try? await Product.products(for: [Self.annualID]).first
        }
        guard let statuses = try? await product?.subscription?.status else { return false }
        for status in statuses ?? [] {
            if case .verified(let renewalInfo) = status.renewalInfo {
                return renewalInfo.willAutoRenew
            }
        }
        return false
    }

    private func writeEntitlement(
        entitled: Bool,
        productType: String,
        expiresAt: Double,
        willAutoRenew: Bool,
        productId: String
    ) {
        guard let defaults = UserDefaults(suiteName: Self.appGroupID) else {
            NSLog("[Styx Multi-Cart] App Group \(Self.appGroupID) unavailable — entitlement not shared")
            return
        }
        let payload: [String: Any] = [
            "entitled": entitled,
            "productType": productType,
            "expiresAt": expiresAt,
            "willAutoRenew": willAutoRenew,
            "productId": productId,
            "updatedAt": Date().timeIntervalSince1970 * 1000,
        ]
        defaults.set(payload, forKey: Self.entitlementKey)
    }
}
