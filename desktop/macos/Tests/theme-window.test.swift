import AppKit
import WebKit

@MainActor final class ThemeFixture: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
    var web: WKWebView!
    var snapshots: [[String: Any]] = []
    var loaded = false
    override init() {
        super.init()
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "kizunaCaptureAppearance")
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        window.contentView!.addSubview(web); web.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let raw = message.body as! [String: Any], value = CaptureAppearance.read(raw)!
        snapshots.append(raw)
        window.appearance = value.windowAppearance
    }
    func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(10)
        while !condition() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        precondition(condition(), "Theme fixture timed out")
    }
    func evaluate(_ script: String) {
        var finished = false
        web.evaluateJavaScript(script) { _, error in precondition(error == nil); finished = true }
        wait { finished }
    }
}

@main enum ThemeWindowTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        NSApp.appearance = NSAppearance(named: .aqua)
        let fixture = ThemeFixture()
        // Simulate the previously forced dark appearance before selecting Auto.
        fixture.window.appearance = NSAppearance(named: .darkAqua)
        let bridge = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        let theme = try! String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
        fixture.web.loadHTMLString("""
        <html><head><style>
        #capture-form {background:rgb(255,255,255);border:1px solid rgb(235,235,235);border-radius:18px;padding:16px;color:rgb(118,118,118)}
        #capture-input {font-size:17px;line-height:24.65px;color:rgb(37,37,37);caret-color:rgb(37,37,37)}
        #capture-input::before {color:rgb(194,194,194)}
        #capture-submit {background:rgb(255,60,100);color:rgb(255,255,255)}
        @media(prefers-color-scheme:dark) {:root:not([data-theme=light]) #capture-form {background:rgb(41,39,37)}}
        </style><script>\(theme)</script></head><body><div id="capture-form"><div id="capture-input"></div><button id="capture-submit"></button></div><script>\(bridge)</script></body></html>
        """, baseURL: URL(string: "http://127.0.0.1"))
        fixture.wait { fixture.loaded && fixture.snapshots.last?["theme"] as? String == "system" && fixture.snapshots.last?["dark"] as? Bool == false }
        precondition(fixture.window.appearance == nil)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        fixture.wait { fixture.snapshots.last?["dark"] as? Bool == true }
        precondition(fixture.window.appearance == nil)
        precondition(fixture.snapshots.last?["surface"] as? String == "rgb(41, 39, 37)")
        fixture.evaluate("window.pagentTheme.set('light')")
        fixture.wait { fixture.window.appearance?.name == .aqua && fixture.snapshots.last?["dark"] as? Bool == false }
        NSApp.appearance = NSAppearance(named: .aqua)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        fixture.evaluate("window.dispatchEvent(new Event('focus'))")
        precondition(fixture.snapshots.last?["dark"] as? Bool == false)
        fixture.evaluate("window.pagentTheme.set('system')")
        fixture.wait { fixture.window.appearance == nil && fixture.snapshots.last?["dark"] as? Bool == true }
        NSApp.appearance = NSAppearance(named: .aqua)
        fixture.wait { fixture.snapshots.last?["dark"] as? Bool == false }
        print("PASS: real WebKit Auto clears a forced window theme, follows system changes and preserves explicit Light")
    }
}
