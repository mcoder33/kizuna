import Foundation

// A failed OS enqueue must remain eligible on the next poll. Account changes
// replace this ledger, so an old in-flight delivery cannot mark a new account.
@MainActor
final class DesktopNotificationDelivery {
    private var seen = Set<String>()
    private var pending = Set<String>()
    private var baselined = false

    func baseline(_ ids: Set<String>) -> Bool {
        guard !baselined else { return false }
        seen.formUnion(ids)
        baselined = true
        return true
    }

    func ignore(_ id: String) { seen.insert(id) }

    func deliver(_ id: String, enqueue: () async throws -> Void) async throws {
        guard !seen.contains(id), pending.insert(id).inserted else { return }
        defer { pending.remove(id) }
        try await enqueue()
        seen.insert(id)
    }
}
