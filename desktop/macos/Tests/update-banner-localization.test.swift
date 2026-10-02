import AppKit
import Sparkle

@main enum UpdateBannerLocalizationTests {
    struct State: Equatable { let flags: [Bool]; let fraction: Double; let installing: Bool }
    @MainActor static func snapshot(_ updates: DesktopUpdates) -> State {
        let banner = updates.banner
        return State(flags:[banner.isHidden,banner.primary.isHidden,banner.primary.isEnabled,banner.secondary.isHidden,banner.secondary.isEnabled,banner.tertiary.isHidden,banner.tertiary.isEnabled,banner.close.isHidden,banner.close.isEnabled,banner.progress.isHidden,banner.progress.isIndeterminate],fraction:banner.progress.doubleValue,installing:updates.isInstalling)
    }
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        precondition(DesktopLocale.supported.allSatisfy { DesktopLocale.catalogs[$0] != nil })
        DesktopLocale.requested = "ru"
        let updates = DesktopUpdates()
        var cancelled = 0
        updates.showUserInitiatedUpdateCheck { cancelled += 1 }
        updates.showDownloadDidReceiveExpectedContentLength(100)
        updates.showDownloadDidReceiveData(ofLength:40)
        let checking = snapshot(updates)
        for locale in DesktopLocale.supported {
            DesktopLocale.requested = locale
            updates.refreshLocale()
            precondition(snapshot(updates) == checking)
            precondition(cancelled == 0)
            precondition(updates.banner.title.stringValue == DesktopLocale.catalogs[locale]?["Проверяем обновления…"] as? String)
            precondition(updates.banner.detail.stringValue == DesktopLocale.catalogs[locale]?["Это займёт несколько секунд."] as? String)
            precondition(updates.banner.secondary.title == DesktopLocale.catalogs[locale]?["Отмена"] as? String)
            precondition(updates.banner.close.toolTip == DesktopLocale.catalogs[locale]?["Закрыть до завтра"] as? String)
            precondition(updates.banner.close.accessibilityLabel() == updates.banner.close.toolTip)
        }
        updates.banner.secondary.performClick(nil)
        precondition(cancelled == 1)
        DesktopLocale.requested = "en"; updates.refreshLocale(); updates.banner.secondary.performClick(nil)
        precondition(cancelled == 1)

        var primaryCalls = 0
        updates.banner.present(L("Проверяем обновления…"),detail:"Opaque 山田 text",progress:0.75,primary:L("Отмена"),onPrimary:{primaryCalls += 1})
        updates.banner.disableActions()
        let disabled = snapshot(updates)
        for locale in DesktopLocale.supported {
            DesktopLocale.requested = locale; updates.refreshLocale()
            precondition(snapshot(updates) == disabled)
            precondition(updates.banner.detail.stringValue == "Opaque 山田 text")
            updates.banner.primary.performClick(nil)
            precondition(primaryCalls == 0)
        }
        var retryCalls = 0, closeCalls = 0
        updates.banner.setRetry { retryCalls += 1 }
        updates.banner.setClose { closeCalls += 1 }
        let retry = snapshot(updates)
        for locale in DesktopLocale.supported {
            DesktopLocale.requested = locale; updates.refreshLocale()
            precondition(snapshot(updates) == retry)
            precondition(updates.banner.primary.title == L("Перезапустить"))
            precondition(updates.banner.secondary.title == L("Закрыть"))
            precondition(retryCalls == 0 && closeCalls == 0)
        }
        updates.banner.primary.performClick(nil)
        precondition(retryCalls == 1 && closeCalls == 0)
        print("PASS: native banner RU→EN→JA preserves progress, readiness, actions and callbacks")
    }
}
