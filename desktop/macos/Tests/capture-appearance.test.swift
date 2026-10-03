import AppKit

@main enum CaptureAppearanceTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        let raw: [String: Any] = ["dark": true, "surface": "rgb(41, 39, 37)", "surfaceEnd": "rgb(36, 35, 34)",
            "border": "#49403b", "focus": "#ab7873", "ink": "rgb(237, 230, 223)", "caret": "#f2a99c",
            "placeholderColor": "rgb(178, 166, 158)", "muted": "rgba(164, 153, 145, 1)", "button": "#e94a69",
            "buttonHover": "#f05b77", "buttonInk": "rgb(32, 32, 30)", "radius": 23.0, "padding": 24.0,
            "fontSize": 17.0, "lineHeight": 24.65, "font": "sans", "placeholder": "О чём думаете?"]
        let palette = CaptureAppearance.read(raw)!
        precondition(palette.button == CaptureAppearance.color("#e94a69"))
        precondition(palette.surface == CaptureAppearance.color("#292725"))
        precondition(palette.placeholder == "О чём думаете?")
        precondition(palette.windowAppearance?.name == .darkAqua, "Old snapshots retain their explicit theme")
        for dark in [false, true] {
            var system = raw; system["theme"] = "system"; system["dark"] = dark
            precondition(CaptureAppearance.read(system)!.windowAppearance == nil, "Auto must inherit the system, never pin WebKit's color scheme")
            let restored = CaptureAppearance.read(system)!.followingSystemAppearance(dark: !dark)
            precondition(restored.dark == !dark && restored.placeholder == palette.placeholder)
            precondition(restored.windowAppearance == nil && restored.fontSize == palette.fontSize)
        }
        precondition(palette.followingSystemAppearance(dark: false).dark, "An explicit dark choice must survive restart in a light system")
        for (key, bad) in [("fontSize", Double.nan as Any), ("padding", -1), ("font", "unexpected"),
                           ("button", "rgb(999, 1, 2)"), ("ink", "javascript:alert(1)"), ("theme", "invalid"), ("placeholder", String(repeating: "x", count: 201))] {
            var hostile = raw; hostile[key] = bad
            precondition(CaptureAppearance.read(hostile) == nil)
        }
        var light = raw; light["dark"] = false; light["surface"] = "rgb(255, 255, 255)"; light["font"] = "mono"; light["fontSize"] = 13.5
        let small = CaptureAppearance.read(light)!
        precondition(!small.dark && small.editorFont.pointSize == 13.5)
        let view = CaptureSurface(frame: NSRect(x: 0, y: 0, width: 800, height: 165))
        view.palette = palette; view.focused = true
        let action = CaptureSubmitButton(frame: NSRect(x: 738, y: 24, width: 38, height: 38))
        action.palette = palette; action.isBordered = false; view.addSubview(action)
        let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: representation)
        try! representation.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "/private/tmp/kizuna-native-graphite.png"))
        print("PASS: capture appearance accepts web colors, themes and fonts; rejects malformed snapshots")
    }
}
