import AppKit
import WebKit

@main enum CapturePanelTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: configuration)
        let capture = DesktopQuickCapture(webView: web, origin: URL(string: "http://127.0.0.1:8898")!)
        let raw: [String: Any] = ["dark": true, "surface": "rgb(41, 39, 37)", "surfaceEnd": "rgb(36, 35, 34)",
            "border": "#49403b", "focus": "#ab7873", "ink": "rgb(237, 230, 223)", "caret": "#f2a99c",
            "placeholderColor": "rgb(178, 166, 158)", "muted": "rgb(164, 153, 145)", "button": "#e94a69",
            "buttonHover": "#f05b77", "buttonInk": "rgb(32, 32, 30)", "radius": 23.0, "padding": 24.0,
            "fontSize": 17.0, "lineHeight": 24.65, "font": "sans", "placeholder": "О чём думаете?"]
        capture.syncAppearance(raw)
        // Inspect the actual production panel without opening a user window.
        let members = Dictionary(uniqueKeysWithValues: Mirror(reflecting: capture).children.map { ($0.label!, $0.value) })
        let panel = members["panel"] as! NSPanel, editor = members["editor"] as! NSTextView
        let submit = members["submitButton"] as! NSButton
        precondition(panel.frame.width == 800 && panel.frame.height == 165)
        precondition(editor.font!.pointSize == 17 && editor.textColor == CaptureAppearance.color("#ede6df"))
        precondition(submit.frame.size == NSSize(width: 38, height: 38) && !submit.isHidden)
        editor.string = "Первая строка"
        panel.makeFirstResponder(editor)
        let enter = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: panel.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
        editor.keyDown(with: enter)
        precondition(editor.string.contains("\n") && capture.preventsRestart, "Enter must retain a multiline draft")
        editor.string = String(repeating: "Строка черновика\n", count: 8)
        capture.textDidChange(Notification(name: NSText.didChangeNotification))
        precondition(panel.frame.height > 165 && panel.frame.height < 500)
        let draft = editor.string
        var light = raw; light["dark"] = false; light["surface"] = "rgb(255, 255, 255)"; light["surfaceEnd"] = "rgb(255, 255, 255)"; light["font"] = "mono"; light["fontSize"] = 13.5
        capture.syncAppearance(light)
        precondition(editor.string == draft && editor.font!.pointSize == 13.5 && panel.appearance!.name == .aqua)
        capture.syncAppearance(raw)
        editor.string = "Одинаковый графит в вебе и Mac\nEnter — новая строка, ⌘+Enter — сохранить"
        capture.textDidChange(Notification(name: NSText.didChangeNotification))
        let view = panel.contentView!, bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "/private/tmp/kizuna-native-capture-panel.png"))
        print("PASS: production capture layout, Enter newline, draft retention, growing field and theme/font changes")
        UserDefaults.standard.removeObject(forKey: "KizunaCaptureAppearance")
    }
}
