import Foundation

// Loaded from the same catalog as web/server, generated at build time.
enum DesktopLocale {
    static let supported = ["ru", "en", "es", "pt-BR", "de", "fr", "ja"]
    static var requested = "system"
    static var detected: String?
    static var current: String { resolve(requested, preferred: Locale.preferredLanguages, detected: detected) }
    static let catalogs: [String: [String: Any]] = {
        guard let url = Bundle.main.url(forResource: "i18n-catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
        return result
    }()
    static func normalize(_ value: String) -> String? {
        let language = value.replacingOccurrences(of: "_", with: "-").lowercased().split(separator: "-").first.map(String.init) ?? ""
        return language == "pt" ? "pt-BR" : supported.first { $0 == language }
    }
    static func resolve(_ requested: String, preferred: [String], detected: String? = nil) -> String {
        if requested != "system", let language = normalize(requested) { return language }
        return preferred.compactMap(normalize).first ?? detected.flatMap(normalize) ?? "ru"
    }
    static func translate(_ source: String, params: [String: String] = [:]) -> String {
        var result = catalogs[current]?[source] as? String ?? source
        for (name, value) in params { result = result.replacingOccurrences(of: "{\(name)}", with: value) }
        return result
    }
    static func selfTest() {
        precondition(normalize("pt-PT") == "pt-BR")
        precondition(resolve("de", preferred: ["ja"]) == "de")
        precondition(resolve("system", preferred: ["zz"]) == "ru")
        print("PASS: native locale policy (3 checks)")
    }
}
func L(_ source: String, _ params: [String: String] = [:]) -> String { DesktopLocale.translate(source, params: params) }

// JavaScript is code. Only the fallback message crosses the localization boundary.
enum DesktopRestartScript {
    static func prepare(fallbackMessage: String) -> String? {
        guard let data = try? JSONEncoder().encode(fallbackMessage),
              let literal = String(data: data, encoding: .utf8) else { return nil }
        return "JSON.stringify({ reason: window.KizunaUpdateGuard ? window.KizunaUpdateGuard.prepare() : \(literal) })"
    }
}
