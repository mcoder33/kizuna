import Foundation

@main
struct NotificationDeliveryTests {
    @MainActor static func main() async {
        let ledger = DesktopNotificationDelivery()
        assert(ledger.baseline(["old"]))
        assert(!ledger.baseline(["fresh"]))
        var sent = [String]()
        try! await ledger.deliver("old") { sent.append("old") }
        assert(sent.isEmpty, "Do not replay history on startup")
        enum Failure: Error { case unavailable }
        do {
            try await ledger.deliver("fresh") { throw Failure.unavailable }
            assertionFailure("The enqueue must fail")
        } catch {}
        try! await ledger.deliver("fresh") { sent.append("fresh") }
        try! await ledger.deliver("fresh") { sent.append("duplicate") }
        assert(sent == ["fresh"], "Retry failed deliveries; deduplicate successful ones")
        ledger.ignore("quiet")
        try! await ledger.deliver("quiet") { sent.append("quiet") }
        assert(sent == ["fresh"], "Quiet/disabled kinds must not replay later")
        let anotherAccount = DesktopNotificationDelivery()
        _ = anotherAccount.baseline([])
        try! await anotherAccount.deliver("fresh") { sent.append("other-account") }
        assert(sent == ["fresh", "other-account"])
        print("Notification delivery: baseline, failed enqueue retry, deduplication, quiet hours and account isolation passed")
    }
}
