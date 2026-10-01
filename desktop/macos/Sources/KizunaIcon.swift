import AppKit

enum KizunaIcon {
    private static let canvas = CGFloat(64)

    static func menuBarTemplate(size: CGFloat) -> NSImage {
        let rep = render(scale: 2)
        rep.size = NSSize(width: canvas, height: canvas)
        let image = NSImage(size: NSSize(width: size, height: size))
        image.addRepresentation(rep)
        image.isTemplate = true
        return image
    }

    static func selfTest() {
        let rep = render(scale: 2)
        func alpha(_ x: Int, _ y: Int) -> CGFloat {
            rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)?.alphaComponent ?? -1
        }
        let corners = [(0, 0), (127, 0), (0, 127), (127, 127)]
        let transparent = corners.allSatisfy { alpha($0.0, $0.1) == 0 }
        let symbolVisible = stride(from: 8, to: 120, by: 4).contains { y in
            stride(from: 8, to: 120, by: 4).contains { x in alpha(x, y) > 0.5 }
        }
        let template = menuBarTemplate(size: 18).isTemplate
        guard transparent, symbolVisible, template else {
            fatalError("Kizuna menu bar icon failed its transparency/template self-test")
        }
        print("PASS: Kizuna menu bar icon (transparent corners, visible mark, template)")
    }

    private static func render(scale: Int) -> NSBitmapImageRep {
        let pixels = Int(canvas) * scale
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: rep) else {
            fatalError("Could not create Kizuna menu bar image")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: pixels, height: pixels).fill(using: .copy)

        let transform = NSAffineTransform()
        transform.scaleX(by: CGFloat(scale), yBy: CGFloat(scale))
        transform.concat()

        let mark = NSBezierPath()
        mark.lineWidth = 6
        mark.lineCapStyle = .round
        mark.lineJoinStyle = .round
        mark.move(to: NSPoint(x: 8, y: 47))
        mark.curve(to: NSPoint(x: 56, y: 47), controlPoint1: NSPoint(x: 25, y: 53), controlPoint2: NSPoint(x: 39, y: 53))
        mark.move(to: NSPoint(x: 14, y: 37))
        mark.line(to: NSPoint(x: 50, y: 37))
        mark.move(to: NSPoint(x: 19, y: 42))
        mark.line(to: NSPoint(x: 21, y: 10))
        mark.move(to: NSPoint(x: 45, y: 42))
        mark.line(to: NSPoint(x: 43, y: 10))
        NSColor.black.setStroke()
        mark.stroke()

        NSGraphicsContext.restoreGraphicsState()
        return rep
    }
}
