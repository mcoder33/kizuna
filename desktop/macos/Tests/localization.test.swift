import Foundation
@main enum LocalizationTests {
    static func main() {
        DesktopLocale.selfTest()
        for value in ["ru", "en-US", "es-MX", "pt-PT", "de-DE", "fr-CA", "ja-JP"] { precondition(DesktopLocale.normalize(value) != nil) }
        precondition(DesktopLocale.normalize("xx") == nil)
        precondition(DesktopLocale.translate("Untranslated {name}", params:["name":"山田"]) == "Untranslated 山田")
        precondition(DesktopLocale.resolve("system", preferred:["nl-NL"], detected:"en") == "en")
        precondition(DesktopLocale.resolve("system", preferred:["ja-JP"], detected:"en") == "ja")
        precondition(DesktopLocale.resolve("fr", preferred:["ja-JP"], detected:"en") == "fr")
        precondition(DesktopLocale.resolve("system", preferred:["nl-NL"], detected:"xx") == "ru")
        print("PASS: native locale variants and raw named parameters")
    }
}
