import AppKit

struct CaptureAppearance {
    var dark: Bool
    var surface: NSColor, surfaceEnd: NSColor, border: NSColor, focus: NSColor
    var ink: NSColor, caret: NSColor, placeholderColor: NSColor, muted: NSColor
    var button: NSColor, buttonHover: NSColor, buttonInk: NSColor
    var radius: CGFloat = 23, padding: CGFloat = 24, fontSize: CGFloat = 17, lineHeight: CGFloat = 24.65
    var font = "sans", placeholder = ""

    static func color(_ value: Any?) -> NSColor? {
        guard let source = value as? String, source.count <= 80 else { return nil }
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#"), [7, 9].contains(text.count), let hex = UInt64(text.dropFirst(), radix: 16) {
            let rgb = text.count == 9 ? hex >> 8 : hex
            return NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255,
                           blue: CGFloat(rgb & 255) / 255, alpha: text.count == 9 ? CGFloat(hex & 255) / 255 : 1)
        }
        guard text.hasPrefix("rgb(" ) || text.hasPrefix("rgba("), text.hasSuffix(")") else { return nil }
        let values = text.drop(while: { $0 != "(" }).dropFirst().dropLast().split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard [3, 4].contains(values.count), values.allSatisfy({ $0.isFinite }), values.prefix(3).allSatisfy({ (0...255).contains($0) }),
              values.count == 3 || (0...1).contains(values[3]) else { return nil }
        return NSColor(srgbRed: values[0] / 255, green: values[1] / 255, blue: values[2] / 255, alpha: values.count == 4 ? values[3] : 1)
    }
    // Used before the web field loads; subsequent changes come from its computed CSS.
    static func fallback(dark: Bool) -> CaptureAppearance {
        func c(_ darkValue: String, _ lightValue: String) -> NSColor { color(dark ? darkValue : lightValue)! }
        return CaptureAppearance(dark: dark, surface: c("#292725", "#ffffff"), surfaceEnd: c("#242322", "#ffffff"),
            border: c("#49403b", "#ebebeb"), focus: c("#ab7873", "#d9d9d9"), ink: c("#ede6df", "#252525"),
            caret: c("#f2a99c", "#252525"), placeholderColor: c("#b2a69e", "#c2c2c2"), muted: c("#a49991", "#767676"),
            button: c("#e94a69", "#ff3c64"), buttonHover: c("#f05b77", "#ff3c64"), buttonInk: c("#20201e", "#ffffff"),
            radius: dark ? 23 : 18, padding: dark ? 24 : 16)
    }
    static func read(_ snapshot: [String: Any]) -> CaptureAppearance? {
        guard let dark = snapshot["dark"] as? Bool,
              let surface = Self.color(snapshot["surface"]), let end = Self.color(snapshot["surfaceEnd"]),
              let border = Self.color(snapshot["border"]), let focus = Self.color(snapshot["focus"]),
              let ink = Self.color(snapshot["ink"]), let caret = Self.color(snapshot["caret"]),
              let placeholderColor = Self.color(snapshot["placeholderColor"]), let muted = Self.color(snapshot["muted"]),
              let button = Self.color(snapshot["button"]), let hover = Self.color(snapshot["buttonHover"]), let buttonInk = Self.color(snapshot["buttonInk"]),
              let radius = snapshot["radius"] as? Double, (0...48).contains(radius),
              let padding = snapshot["padding"] as? Double, (8...48).contains(padding),
              let size = snapshot["fontSize"] as? Double, (10...32).contains(size),
              let line = snapshot["lineHeight"] as? Double, (10...64).contains(line),
              let font = snapshot["font"] as? String, ["sans", "serif", "mono"].contains(font),
              let placeholder = snapshot["placeholder"] as? String, placeholder.count <= 200 else { return nil }
        return CaptureAppearance(dark: dark, surface: surface, surfaceEnd: end, border: border, focus: focus, ink: ink, caret: caret,
                  placeholderColor: placeholderColor, muted: muted, button: button, buttonHover: hover, buttonInk: buttonInk,
                  radius: radius, padding: padding, fontSize: size, lineHeight: line, font: font, placeholder: placeholder)
    }
    var editorFont: NSFont {
        switch font {
        case "serif": return NSFont(name: "Iowan Old Style", size: fontSize) ?? .systemFont(ofSize: fontSize)
        case "mono": return .monospacedSystemFont(ofSize: fontSize, weight: .regular)
        default: return .systemFont(ofSize: fontSize)
        }
    }
}

final class CaptureSurface: NSView {
    var palette = CaptureAppearance.fallback(dark: true) { didSet { needsDisplay = true } }
    var focused = false { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: palette.radius, yRadius: palette.radius)
        NSGradient(colorsAndLocations: (palette.surface, 0), (palette.surfaceEnd, 0.76), (palette.surfaceEnd, 1))?.draw(in: shape, angle: 305)
        (focused ? palette.focus : palette.border).setStroke(); shape.lineWidth = 1; shape.stroke()
    }
}

final class CaptureSubmitButton: NSButton {
    var palette = CaptureAppearance.fallback(dark: true) { didSet { needsDisplay = true } }
    private var hovered = false
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
    override func draw(_ dirtyRect: NSRect) {
        (hovered && isEnabled ? palette.buttonHover : palette.button).setFill()
        NSBezierPath(ovalIn: bounds).fill()
        // Same right arrow as the web button, without AppKit's disabled-image dimming.
        let arrow = NSBezierPath(); arrow.lineWidth = 2.7; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        arrow.move(to: NSPoint(x: c.x - 7, y: c.y)); arrow.line(to: NSPoint(x: c.x + 7, y: c.y))
        arrow.move(to: NSPoint(x: c.x + 1, y: c.y + 6)); arrow.line(to: NSPoint(x: c.x + 7, y: c.y)); arrow.line(to: NSPoint(x: c.x + 1, y: c.y - 6))
        palette.buttonInk.setStroke(); arrow.stroke()
    }
}
