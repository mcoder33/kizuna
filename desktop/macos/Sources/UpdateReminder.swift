import Foundation

/// Own reminder decisions never become Sparkle's skipped-version state.
final class UpdateReminderPolicy {
    struct Pending: Equatable {
        let version: String
        let deadline: Date
    }
    enum Delay { case hour, tomorrow }
    private let defaults: UserDefaults
    private let clock: () -> Date
    private let calendar: () -> Calendar
    private let pendingKey = "kizuna.updateReminder.pending"
    private let ignoredKey = "kizuna.updateReminder.ignoredVersion"

    init(defaults: UserDefaults = .standard, clock: @escaping () -> Date = Date.init,
         calendar: @escaping () -> Calendar = { .current }) {
        self.defaults = defaults; self.clock = clock; self.calendar = calendar
    }
    var now: Date { clock() }
    var pending: Pending? {
        guard let value = defaults.dictionary(forKey: pendingKey),
              let version = value["version"] as? String,
              let timestamp = value["deadline"] as? Double, timestamp.isFinite else { return nil }
        return Pending(version: version, deadline: Date(timeIntervalSince1970: timestamp))
    }
    func shouldOffer(version: String, userInitiated: Bool) -> Bool {
        if userInitiated { return true }
        if defaults.string(forKey: ignoredKey) == version { return false }
        guard let pending, pending.version == version else { return true }
        return pending.deadline <= now
    }
    func postpone(version: String, by delay: Delay) {
        let deadline: Date
        switch delay {
        case .hour: deadline = now.addingTimeInterval(3600)
        case .tomorrow:
            let local = calendar()
            guard let nextDay = local.date(byAdding: .day, value: 1, to: local.startOfDay(for: now)) else { return }
            deadline = nextDay
        }
        defaults.set(["version": version, "deadline": deadline.timeIntervalSince1970], forKey: pendingKey)
        if defaults.string(forKey: ignoredKey) == version { defaults.removeObject(forKey: ignoredKey) }
    }
    func ignore(version: String) {
        defaults.set(version, forKey: ignoredKey)
        clearPending(version: version)
    }
    func observeEligibleVersion(_ version: String) {
        if let pending, pending.version != version { defaults.removeObject(forKey: pendingKey) }
    }
    func beginInstallation(version: String) {
        clearPending(version: version)
        if defaults.string(forKey: ignoredKey) == version { defaults.removeObject(forKey: ignoredKey) }
    }
    func consume(_ reminder: Pending) {
        if pending == reminder, reminder.deadline <= now { defaults.removeObject(forKey: pendingKey) }
    }
    private func clearPending(version: String) {
        if pending?.version == version { defaults.removeObject(forKey: pendingKey) }
    }
}

/// One timer survives updater busy periods without consuming the reminder early.
@MainActor
final class UpdateReminderController {
    typealias Schedule = (TimeInterval, @escaping @MainActor () -> Void) -> (() -> Void)
    private let policy: UpdateReminderPolicy
    private let canCheck: () -> Bool
    private let check: () -> Void
    private let schedule: Schedule
    private var cancelTimer: (() -> Void)?
    private var generation = 0

    init(policy: UpdateReminderPolicy, canCheck: @escaping () -> Bool,
         check: @escaping () -> Void, schedule: @escaping Schedule = scheduleTimer) {
        self.policy = policy; self.canCheck = canCheck; self.check = check; self.schedule = schedule
    }
    nonisolated static func scheduleTimer(delay: TimeInterval, fire: @escaping @MainActor () -> Void) -> (() -> Void) {
        let timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            Task { @MainActor in fire() }
        }
        return { timer.invalidate() }
    }
    func refresh() { scheduleNext() }
    private func scheduleNext(retryDelay: TimeInterval? = nil) {
        cancelTimer?(); cancelTimer = nil; generation += 1
        guard let pending = policy.pending else { return }
        let current = generation
        let delay = retryDelay ?? max(0.1, pending.deadline.timeIntervalSince(policy.now))
        cancelTimer = schedule(delay) { [weak self] in
            guard let self, self.generation == current else { return }
            self.cancelTimer = nil
            self.timerFired()
        }
    }
    private func timerFired() {
        guard let pending = policy.pending else { return }
        if pending.deadline > policy.now { scheduleNext(); return }
        guard canCheck() else { scheduleNext(retryDelay: 15); return }
        check()
        policy.consume(pending)
        scheduleNext()
    }
    deinit { cancelTimer?() }
}
