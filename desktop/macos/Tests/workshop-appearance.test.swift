import AppKit
import WebKit

@MainActor final class WorkshopAppearanceFixture: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let web: WKWebView
    var snapshots: [[String: Any]] = []
    var loaded = false
    var navigationError: Error?
    var diagnostic = ""

    init(origin: URL, bridge: String) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // A command-line WKWebView stays Page Visibility "hidden" even with an
        // ordered window. Only the harness simulates a foreground app; the
        // production room runtime and capture bridge remain unmodified.
        configuration.userContentController.addUserScript(WKUserScript(source: """
        Object.defineProperty(document, 'hidden', { configurable:true, get:() => false });
        Object.defineProperty(document, 'visibilityState', { configurable:true, get:() => 'visible' });
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        super.init()
        configuration.userContentController.add(self, name: "kizunaCaptureAppearance")
        let encodedOrigin = String(data: try! JSONEncoder().encode(origin.absoluteString), encoding: .utf8)!
        let trusted = "if (window.location.origin === new URL(\(encodedOrigin)).origin) { \(bridge) }"
        configuration.userContentController.addUserScript(
            WKUserScript(source: trusted, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.contentView!.addSubview(web)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError = error }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError = error }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let raw = message.body as? [String: Any], let palette = CaptureAppearance.read(raw) else {
            fatalError("Production capture bridge emitted an invalid appearance snapshot")
        }
        snapshots.append(raw)
        window.appearance = palette.windowAppearance
    }

    func wait(_ label: String, timeout: TimeInterval = 30, until condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            if let navigationError { fatalError("\(label): \(navigationError)") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.03))
        }
        precondition(condition(), "Timed out: \(label); loaded=\(loaded); url=\(web.url?.absoluteString ?? "nil"); snapshots=\(snapshots.count); state=\(diagnostic)")
    }

    func evaluate(_ script: String) -> Any? {
        var finished = false
        var value: Any?
        var failure: Error?
        web.evaluateJavaScript(script) { result, error in
            value = result; failure = error; finished = true
        }
        wait("evaluating JavaScript") { finished }
        precondition(failure == nil, "JavaScript failed: \(failure!)")
        return value
    }

    func state() -> [String: Any] {
        let value = evaluate("""
        (() => {
          const root = document.documentElement;
          const form = document.querySelector('#capture-form');
          const field = document.querySelector('#capture-input');
          const submit = document.querySelector('#capture-submit');
          const circle = document.querySelector('#todo .entry:not(.overdue):not(.completed):not(.completing) > .completion-button:not(.auto)');
          if (!form || !field || !submit) return {ready:false};
          const box = getComputedStyle(form), text = getComputedStyle(field), button = getComputedStyle(submit);
          const variable = (name, fallback) => box.getPropertyValue(name).trim() || fallback;
          return {
            ready:true, appearance:root.dataset.appearance || '', roomLight:root.dataset.roomLight || '',
            hidden:document.hidden, roomError:root.dataset.roomError || '',
            fallback:root.dataset.roomFallback || '', theme:root.dataset.theme || 'system',
            dark:root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches),
            draft:field.textContent, sceneCount:document.querySelectorAll('.workshop-scene.shown').length,
            circleBorder:circle ? getComputedStyle(circle).borderTopColor : '',
            circleLine:circle ? getComputedStyle(circle).getPropertyValue('--ws-scene-line').trim() : '',
            circleHovered:circle ? circle.matches(':hover') : false,
            nightSelectorMatches:circle ? circle.matches('html[data-appearance="workshop"][data-room-light="night"] #todo .entry:not(.completed):not(.completing):not(.overdue) > .completion-button:not(.auto)') : false,
            circleAnimations:circle ? circle.getAnimations().map(a => ({playState:a.playState,currentTime:a.currentTime,duration:a.effect?.getTiming().duration})) : [],
            sceneLine:getComputedStyle(root).getPropertyValue('--ws-scene-line').trim(),
            circleTransition:circle ? getComputedStyle(circle).transitionDuration : '',
            sceneOpacity:getComputedStyle(document.querySelector('.workshop-scene.shown') || form).opacity,
            sceneFilter:getComputedStyle(document.querySelector('.workshop-scene.shown') || form).filter,
            roomImage:root.style.getPropertyValue('--workshop-room-image').trim(),
            surfaceImage:box.backgroundImage, surfaceColor:box.backgroundColor,
            border:variable('--capture-line', variable('--n-92', box.borderTopColor)),
            focus:variable('--capture-focus-line', variable('--n-85', box.borderTopColor)),
            ink:text.color, caret:text.caretColor === 'auto' ? text.color : text.caretColor,
            placeholderColor:getComputedStyle(field, '::before').color,
            button:variable('--capture-button', button.backgroundColor),
            buttonHover:variable('--capture-button-hover', button.backgroundColor), buttonInk:button.color,
            muted:getComputedStyle(form.querySelector('.capture-foot') || form).color,
            radius:parseFloat(box.borderTopLeftRadius), padding:parseFloat(box.paddingTop),
            fontSize:parseFloat(text.fontSize), lineHeight:parseFloat(text.lineHeight),
            font:root.dataset.font || 'sans', placeholder:field.dataset.placeholder || ''
          };
        })()
        """)
        return value as? [String: Any] ?? [:]
    }

    func set(_ id: String, to value: String) {
        let idJSON = String(data: try! JSONEncoder().encode(id), encoding: .utf8)!
        let valueJSON = String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
        let result = evaluate("(() => { const select=document.getElementById(\(idJSON)); if (!select) return false; select.value=\(valueJSON); select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()")
        precondition(result as? Bool == true, "Missing production setting \(id)")
    }

    func waitForCircle(token: String, rendered: String) {
        wait("completion circle receives \(token)") { self.state()["sceneLine"] as? String == token }
        // The command-line WebKit process remains backgrounded at the engine
        // level. Its 150 ms CSS transitions stay at currentTime=0 indefinitely,
        // despite the final selector and inherited token both being correct.
        // Finish the real CSS animations to inspect and capture their final paint;
        // no stylesheet, inline style, or production behavior is overridden.
        _ = evaluate("document.querySelectorAll('#todo .entry:not(.overdue):not(.completed):not(.completing) > .completion-button:not(.auto)').forEach(circle => circle.getAnimations().forEach(animation => animation.finish()))")
        wait("completion circle settles to \(token)", timeout: 3) {
            let style = state()
            diagnostic = "appearance=\(style["appearance"] ?? "?"); theme=\(style["theme"] ?? "?"); room=\(style["roomLight"] ?? "?"); rootToken=\(style["sceneLine"] ?? "?"); circleToken=\(style["circleLine"] ?? "?"); border=\(style["circleBorder"] ?? "?"); hover=\(style["circleHovered"] ?? "?"); selector=\(style["nightSelectorMatches"] ?? "?"); animations=\(style["circleAnimations"] ?? "?")"
            return style["sceneLine"] as? String == token && style["circleBorder"] as? String == rendered
        }
        let style = state()
        print("Completion circle: --ws-scene-line=\(style["sceneLine"]!), border=\(style["circleBorder"]!), transition=\(style["circleTransition"]!)")
    }

    func saveSnapshot(_ name: String, in directory: URL?) {
        guard let directory else { return }
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var finished = false
        var image: NSImage?
        var failure: Error?
        web.takeSnapshot(with: nil) { result, error in image = result; failure = error; finished = true }
        wait("WebKit snapshot \(name)") { finished }
        precondition(failure == nil, "WebKit snapshot failed: \(String(describing: failure))")
        let bitmap = NSBitmapImageRep(data: image!.tiffRepresentation!)!
        let png = bitmap.representation(using: .png, properties: [:])!
        try! png.write(to: directory.appendingPathComponent(name + ".png"), options: .atomic)
    }

    func verify(_ appearance: String, _ theme: String, _ dark: Bool, _ roomLight: String? = nil,
                draft: String, expectedGeometry: [String: Any]? = nil) -> [String: Any] {
        wait("\(appearance)/\(theme) appearance and capture bridge") {
            let state = self.state()
            return state["ready"] as? Bool == true && state["appearance"] as? String == appearance
                && state["theme"] as? String == theme && state["dark"] as? Bool == dark
                && (roomLight == nil || state["roomLight"] as? String == roomLight)
                && self.snapshots.last?["theme"] as? String == theme
                && self.snapshots.last?["dark"] as? Bool == dark
        }
        let computed = state()
        let raw = snapshots.last!
        guard let palette = CaptureAppearance.read(raw) else { fatalError("Cannot parse native appearance") }
        precondition(computed["draft"] as? String == draft, "Appearance change altered the web draft")
        precondition(raw["theme"] as? String == theme && raw["dark"] as? Bool == dark)
        precondition(palette.windowAppearance?.name == (theme == "system" ? nil : (dark ? .darkAqua : .aqua)))
        for key in ["border", "focus", "ink", "caret", "placeholderColor", "button", "buttonHover", "buttonInk", "muted", "font", "placeholder"] {
            precondition(raw[key] as? String == computed[key] as? String, "Native \(key) differs from the actual web field")
        }
        for key in ["radius", "padding", "fontSize", "lineHeight"] {
            let actual = (raw[key] as? NSNumber)?.doubleValue ?? .nan
            let expected = (computed[key] as? NSNumber)?.doubleValue ?? .nan
            precondition(abs(actual - expected) < 0.02, "Native \(key) differs from the actual web field")
            if let previous = expectedGeometry?[key] as? NSNumber {
                precondition(abs(actual - previous.doubleValue) < 0.02, "\(key) changed between classic and workshop")
            }
        }
        let image = computed["surfaceImage"] as? String ?? "none"
        let surface = raw["surface"] as? String ?? ""
        let end = raw["surfaceEnd"] as? String ?? ""
        if image == "none" { precondition(surface == computed["surfaceColor"] as? String && end == surface) }
        else { precondition(image.contains(surface) && image.contains(end), "Native gradient differs from the web field") }
        if appearance == "workshop" {
            precondition(computed["fallback"] as? String == "", "Room image fell back")
            precondition((computed["sceneCount"] as? Int ?? 0) > 0 && !(computed["roomImage"] as? String ?? "").isEmpty,
                         "Workshop room was not painted")
            if roomLight == "day" { precondition(computed["sceneOpacity"] as? String == "0.8") }
            if roomLight == "night" {
                precondition(computed["sceneOpacity"] as? String == "1")
                precondition((computed["sceneFilter"] as? String ?? "").contains("0.78"))
            }
        } else {
            precondition((computed["sceneCount"] as? Int ?? 0) == 0, "Classic appearance retained room layers")
        }
        return raw
    }
}

@main enum WorkshopAppearanceTests {
    @MainActor static func main() {
        let preview = URL(string: CommandLine.arguments[1])!
        precondition(preview.scheme == "http" && preview.host == "127.0.0.1" && preview.path == "/__preview", "Only the local preview is allowed")
        let bridge = try! String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
        let output = CommandLine.arguments.count > 3 && !CommandLine.arguments[3].isEmpty
            ? URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true) : nil
        let origin = URL(string: "http://127.0.0.1:\(preview.port!)")!
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.regular)
        NSApp.finishLaunching()
        NSApp.appearance = NSAppearance(named: .aqua)
        let fixture = WorkshopAppearanceFixture(origin: origin, bridge: bridge)
        fixture.web.load(URLRequest(url: preview))
        var initialState: [String: Any] = [:]
        fixture.wait("authenticated app and painted day room", timeout: 45) {
            initialState = fixture.state()
            fixture.diagnostic = "\(initialState["ready"] ?? "?")/\(initialState["appearance"] ?? "?")/\(initialState["roomLight"] ?? "?")/\(initialState["sceneCount"] ?? "?")/\(fixture.snapshots.count); hidden=\(initialState["hidden"] ?? "?"); fallback=\(initialState["fallback"] ?? "?"); error=\(initialState["roomError"] ?? "?")"
            return fixture.loaded && initialState["ready"] as? Bool == true
                && initialState["appearance"] as? String == "workshop"
                && initialState["roomLight"] as? String == "day"
                && (initialState["sceneCount"] as? Int ?? 0) > 0
                && !fixture.snapshots.isEmpty
        }
        let draft = "Черновик остаётся моим"
        _ = fixture.evaluate("(() => { const field=document.querySelector('#capture-input'); field.textContent='Черновик остаётся моим'; field.dispatchEvent(new Event('input',{bubbles:true})); })()")
        let workshopLight = fixture.verify("workshop", "light", false, "day", draft: draft)
        fixture.waitForCircle(token: "#4c5c4f", rendered: "rgb(76, 92, 79)")
        fixture.saveSnapshot("workshop-light-day-wkwebview", in: output)
        fixture.set("setting-room-light", to: "night")
        fixture.wait("night room without changing interface theme") { fixture.state()["roomLight"] as? String == "night" }
        _ = fixture.verify("workshop", "light", false, "night", draft: draft, expectedGeometry: workshopLight)
        _ = fixture.evaluate("window.pagentTheme.set('dark')")
        let workshopDark = fixture.verify("workshop", "dark", true, "night", draft: draft)
        fixture.waitForCircle(token: "#d2ddcc", rendered: "rgb(210, 221, 204)")
        fixture.saveSnapshot("workshop-dark-night-wkwebview", in: output)
        fixture.set("setting-appearance", to: "classic")
        _ = fixture.verify("classic", "dark", true, draft: draft, expectedGeometry: workshopDark)
        _ = fixture.evaluate("window.pagentTheme.set('light')")
        let classicLight = fixture.verify("classic", "light", false, draft: draft, expectedGeometry: workshopLight)
        fixture.set("setting-appearance", to: "workshop")
        _ = fixture.verify("workshop", "light", false, "night", draft: draft, expectedGeometry: classicLight)
        _ = fixture.evaluate("window.pagentTheme.set('system')")
        _ = fixture.verify("workshop", "system", false, "night", draft: draft)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        _ = fixture.verify("workshop", "system", true, "night", draft: draft)
        NSApp.appearance = NSAppearance(named: .aqua)
        _ = fixture.verify("workshop", "system", false, "night", draft: draft)
        print("PASS: production WKWebView capture bridge follows classic/workshop, day/night and light/dark/system without changing the draft")
    }
}
