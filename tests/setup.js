// Vitest setup — installs a sinon-chrome stub on globalThis so modules that
// reach for chrome.storage.local etc. don't explode when imported under Node.
//
// Each test file that exercises chrome APIs should call `chrome.flush()` (or
// `chrome.storage.local.get.resetHistory()`) in beforeEach to avoid leaking
// state across tests. vitest.config sets restoreMocks/clearMocks for vi spies,
// but sinon-chrome has its own bookkeeping.

import chromeStub from "sinon-chrome";

globalThis.chrome = chromeStub;
