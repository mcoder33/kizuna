import Foundation

enum DesktopTimeZone {
    static func script(identifier: String = TimeZone.current.identifier) -> String {
        let value = String(data: try! JSONEncoder().encode(identifier), encoding: .utf8)!
        return "window.KizunaSystemTimeZone = \(value); window.dispatchEvent(new CustomEvent('pagent:systemtimezonechange'));"
    }
}
