import AppKit
import WebKit
import UserNotifications

// Compiled with the production notification sources by test-notifications-integration.py.
@MainActor
final class NotificationFixture: NSObject, NSApplicationDelegate {
    let origin = URL(string: CommandLine.arguments[1])!
    let reportURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let center = UNUserNotificationCenter.current()
    var window: NSWindow!
    var webView: WKWebView!
    var notifications: DesktopNotifications!

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationDidFinishLaunching(_ notification: Notification) {
        try? Data(String(ProcessInfo.processInfo.processIdentifier).utf8).write(to: reportURL.appendingPathExtension("pid"))
        Task { do { try await run(); finish(nil) } catch { finish(String(describing: error)) } }
    }
    func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "NotificationFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    func wait(_ predicate: () async throws -> Bool) async throws {
        for _ in 0..<360 {
            if try await predicate() { return }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        try require(false, "Timed out waiting for native notification state")
    }
    func control(_ path: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: origin.appendingPathComponent(path))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
    func run() async throws {
        try require(origin.host == "127.0.0.1" && origin.scheme == "http", "Only a loopback fixture is allowed")
        UserDefaults.standard.removeObject(forKey: "desktopNotificationsEnabled")
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 500, height: 220),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Kizuna notification integration fixture"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: origin))
        try await wait { self.webView.url == self.origin && !self.webView.isLoading }
        let cookie = HTTPCookie(properties: [.name: "pagent_session", .value: "local-notification-fixture",
                                            .domain: "127.0.0.1", .path: "/"])!
        await configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
        notifications = DesktopNotifications(webView: webView, origin: origin)
        print("AUTHORIZATION_REQUEST_READY: allow Kizuna Notification Test"); fflush(stdout)
        try require(try await center.requestAuthorization(options: [.alert, .sound]),
                    "Notification permission was denied; no delivery proof")
        notifications.start()
        try await wait { (try await self.control("fixture/state"))["pages"] as? Int ?? 0 >= 1 }
        try await Task.sleep(nanoseconds: 500_000_000)
        try require(await center.deliveredNotifications().isEmpty, "Historical notification was replayed")
        window.close()
        try require(!window.isVisible && NSApp.isRunning, "Closing the window terminated the fixture")
        _ = try await control("fixture/fresh")
        notifications.refresh()
        try await wait { await self.center.deliveredNotifications().contains { $0.request.identifier == "kizuna-fixture-fresh" } }
        let delivered = await center.deliveredNotifications()
        try require(delivered.count == 1 && delivered[0].request.content.body == "Local integration check — no action needed.",
                    "Unexpected delivered notification identifier, count or body")
        print("DELIVERED: kizuna-fixture-fresh, window closed, production polling path"); fflush(stdout)
        // Leave the benign banner visible briefly so the supervised run can inspect it.
        try await Task.sleep(nanoseconds: 8_000_000_000)
        center.removeAllDeliveredNotifications()
        try await wait { await self.center.deliveredNotifications().isEmpty }
        let pages = (try await control("fixture/state"))["pages"] as! Int
        notifications.refresh()
        try await wait { (try await self.control("fixture/state"))["pages"] as? Int ?? 0 > pages }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        try require(await center.deliveredNotifications().isEmpty, "Fresh notification repeated on the next poll")
    }
    func finish(_ error: String?) {
        notifications?.stop()
        center.removeAllDeliveredNotifications()
        let report: [String: Any] = ["passed": error == nil, "error": error ?? "",
                                    "checks": ["WKWebView session cookie", "historical baseline", "closed-window delivery", "deduplication"]]
        try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]).write(to: reportURL)
        print(error.map { "FAIL: \($0)" } ?? "PASS: native notification integration"); fflush(stdout)
        NSApp.terminate(nil)
    }
}

@main
enum NotificationIntegration {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let fixture = NotificationFixture()
        app.delegate = fixture
        withExtendedLifetime(fixture) { app.run() }
    }
}
