import Foundation

@main
@MainActor
enum UpdateReminderTests {
    final class Clock { var date: Date; init(_ date: Date) { self.date = date } }
    final class Scheduler {
        final class Entry {
            let delay: TimeInterval
            let fire: @MainActor () -> Void
            var cancelled = false
            init(_ delay: TimeInterval, _ fire: @escaping @MainActor () -> Void) { self.delay = delay; self.fire = fire }
        }
        var entries: [Entry] = []
        func schedule(_ delay: TimeInterval, _ fire: @escaping @MainActor () -> Void) -> (() -> Void) {
            let entry = Entry(delay, fire); entries.append(entry)
            return { entry.cancelled = true }
        }
        var active: [Entry] { entries.filter { !$0.cancelled } }
    }
    static var checks = 0
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
        checks += 1
    }
    static func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
    static func main() {
        let suite = "space.agenthub.kizuna.reminder-test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let clock = Clock(date("2026-10-02T10:30:00Z"))
        var local = Calendar(identifier: .gregorian); local.timeZone = TimeZone(identifier: "Europe/Samara")!
        let policy = UpdateReminderPolicy(defaults: defaults, clock: { clock.date }, calendar: { local })
        policy.postpone(version: "5", by: .hour)
        expect(policy.pending?.deadline == clock.date.addingTimeInterval(3600), "Hour must be exactly 3600 seconds")
        expect(!policy.shouldOffer(version: "5", userInitiated: false), "Automatic hour reminder must stay hidden")
        expect(policy.shouldOffer(version: "5", userInitiated: true), "Manual check must bypass hour reminder")
        let unchanged = policy.pending
        expect(policy.shouldOffer(version: "6", userInitiated: false), "New build must bypass older reminder")
        expect(policy.pending == unchanged, "Checking eligibility must not move the deadline")

        let relaunched = UpdateReminderPolicy(defaults: UserDefaults(suiteName: suite)!, clock: { clock.date }, calendar: { local })
        expect(relaunched.pending == unchanged, "Reminder must survive relaunch")
        relaunched.observeEligibleVersion("6")
        expect(policy.pending == nil, "Showing a newer version must clear the obsolete reminder")
        policy.ignore(version: "5")
        expect(!relaunched.shouldOffer(version: "5", userInitiated: false), "Ignore must persist for this build")
        expect(relaunched.shouldOffer(version: "5", userInitiated: true), "Manual check must bypass ignore")
        expect(relaunched.shouldOffer(version: "6", userInitiated: false), "Ignore must not hide future builds")
        policy.beginInstallation(version: "5")
        expect(policy.shouldOffer(version: "5", userInitiated: false), "Installing must clear ignored build")

        policy.postpone(version: "5", by: .tomorrow)
        expect(policy.pending?.deadline == date("2026-10-02T20:00:00Z"), "Close must end at next local midnight")
        local.timeZone = TimeZone(identifier: "America/New_York")!
        clock.date = date("2026-03-08T05:30:00Z")
        policy.postpone(version: "5", by: .tomorrow)
        expect(policy.pending?.deadline == date("2026-03-09T04:00:00Z"), "Spring DST uses next calendar day, not 24 hours")
        clock.date = date("2026-11-01T04:30:00Z")
        policy.postpone(version: "5", by: .tomorrow)
        expect(policy.pending?.deadline == date("2026-11-02T05:00:00Z"), "Fall DST uses next calendar day, not 24 hours")
        policy.ignore(version: "5")
        expect(policy.pending == nil, "Ignore must cancel this build's pending reminder")

        let scheduler = Scheduler()
        var canCheck = false, performed = 0
        policy.postpone(version: "6", by: .hour)
        let controller = UpdateReminderController(policy: policy, canCheck: { canCheck },
            check: { performed += 1 }, schedule: scheduler.schedule)
        controller.refresh()
        expect(scheduler.entries.last?.delay == 3600, "Restoring a reminder must schedule the remaining hour")
        let first = scheduler.entries.last!
        clock.date = clock.date.addingTimeInterval(3600)
        first.fire()
        expect(performed == 0 && policy.pending != nil, "Busy updater must preserve due reminder")
        expect(scheduler.entries.last?.delay == 15, "Busy updater retries after 15 seconds")
        let retry = scheduler.entries.last!
        canCheck = true; clock.date = clock.date.addingTimeInterval(15)
        retry.fire()
        expect(performed == 1 && policy.pending == nil, "Due reminder must check and consume once")
        retry.fire(); first.fire()
        expect(performed == 1, "Expired callbacks must not check again")

        policy.postpone(version: "7", by: .hour); controller.refresh()
        let cancelled = scheduler.entries.last!
        policy.ignore(version: "7"); controller.refresh()
        expect(cancelled.cancelled, "Ignore must invalidate the existing timer")
        clock.date = clock.date.addingTimeInterval(3600); cancelled.fire()
        expect(performed == 1, "Cancelled callback must not resurrect an ignored update")

        let anotherScheduler = Scheduler()
        policy.postpone(version: "8", by: .hour)
        let another = UpdateReminderController(policy: policy, canCheck: { true }, check: {
            policy.postpone(version: "8", by: .hour)
        }, schedule: anotherScheduler.schedule)
        another.refresh(); clock.date = clock.date.addingTimeInterval(3600)
        anotherScheduler.entries.last!.fire()
        expect(policy.pending?.deadline == clock.date.addingTimeInterval(3600), "A new decision during the check must survive consumption")
        expect(anotherScheduler.entries.last?.delay == 3600, "New decision keeps one new timer")
        print("PASS: \(checks) reminder policy/scheduler checks (calendar DST, relaunch, version, manual, busy retry, stale callbacks)")
    }
}
