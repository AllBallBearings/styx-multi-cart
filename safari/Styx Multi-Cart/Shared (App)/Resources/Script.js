function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('platform-mac state-on')[0].innerText = "Styx Multi-Cart’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac state-off')[0].innerText = "Styx Multi-Cart’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac state-unknown')[0].innerText = "You can turn on Styx Multi-Cart’s extension in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac open-preferences')[0].innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);

// Premium In-App Purchase buttons (macOS host app). Each posts an action to
// the native ViewController, which drives StoreKit; the system purchase sheet
// shows localized pricing. See StoreManager.swift.
function sendController(action) {
    webkit.messageHandlers.controller.postMessage(action);
}

document.querySelector("button.buy-annual")?.addEventListener("click", function () {
    sendController("buy-annual");
});
document.querySelector("button.buy-lifetime")?.addEventListener("click", function () {
    sendController("buy-lifetime");
});
document.querySelector("button.restore")?.addEventListener("click", function () {
    sendController("restore");
});
