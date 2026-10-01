import Foundation

@main
struct NotificationPolicyTests {
    static func main() {
        let origin = URL(string: "https://kizuna.example")!
        assert(DesktopNotificationPolicy.sameOrigin(URL(string: "https://kizuna.example:443/#today")!, origin))
        for text in ["https://kizuna.example.evil/", "http://kizuna.example/", "https://kizuna.example:444/", "https://user@kizuna.example/"] {
            assert(!DesktopNotificationPolicy.sameOrigin(URL(string: text)!, origin))
        }
        let formatter = ISO8601DateFormatter()
        func date(_ time: String) -> Date { formatter.date(from: "2026-10-01T\(time):00Z")! }
        assert(DesktopNotificationPolicy.isQuiet("22:00-08:00", at: date("22:00"), timeZone: "UTC"))
        assert(DesktopNotificationPolicy.isQuiet("22:00-08:00", at: date("07:59"), timeZone: "UTC"))
        assert(!DesktopNotificationPolicy.isQuiet("22:00-08:00", at: date("08:00"), timeZone: "UTC"))
        assert(!DesktopNotificationPolicy.isQuiet("22:00-08:00", at: date("21:59"), timeZone: "UTC"))
        assert(DesktopNotificationPolicy.isQuiet("22:00-08:00", at: date("18:00"), timeZone: "Europe/Samara"))
        assert(!DesktopNotificationPolicy.isQuiet("off", at: date("23:00"), timeZone: "UTC"))
        assert(!DesktopNotificationPolicy.isQuiet("08:00-08:00", at: date("08:00"), timeZone: "UTC"))
        assert(DesktopNotificationPolicy.isQuiet("bad", at: date("12:00"), timeZone: "UTC"))
        assert(DesktopNotificationPolicy.isQuiet("22:00-08:00", at: date("12:00"), timeZone: "invalid"))
        var item: [String: Any] = ["kind": "reminder", "read": false, "resolved": false]
        let defaults = ["reminder": "phone"]
        func deliver(_ prefs: [String: String] = [:], quiet: Bool = false) -> Bool {
            DesktopNotificationPolicy.shouldDeliver(item: item, preferences: prefs, defaults: defaults, quiet: quiet)
        }
        assert(deliver())
        assert(!deliver(["reminder": "bell"]))
        assert(!deliver(["reminder": "off"]))
        assert(!deliver(quiet: true))
        item["read"] = true
        assert(!deliver())
        item["read"] = false; item["resolved"] = true
        assert(!deliver())
        item["resolved"] = false; item["dismissed"] = true
        assert(!deliver())
        item = ["kind": "unknown", "read": false, "resolved": false]
        assert(!deliver())
        print("Notification policy: origin, preferences, unread state and quiet-hours checks passed")
    }
}
