import AppKit
import WebKit

private final class CaptureTransport: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class CaptureEditor: NSTextView {
    var onSubmit: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onFocus: ((Bool) -> Void)?
    var placeholder = ""
    var placeholderColor = NSColor.placeholderTextColor
    override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); if result { onFocus?(true) }; return result }
    override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); if result { onFocus?(false) }; return result }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty && !hasMarkedText() {
            ((placeholder.isEmpty ? L("Какая мысль зацепила?") : placeholder) as NSString).draw(at: NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height),
                withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 17), .foregroundColor: placeholderColor])
        }
    }
    override func keyDown(with event: NSEvent) {
        if !hasMarkedText() {
            if event.keyCode == 53 { onDismiss?(); return }
            if QuickCapturePolicy.shouldSubmit(event.keyCode, modifiers: event.modifierFlags, composing: false) { onSubmit?(); return }
        }
        super.keyDown(with: event)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if QuickCapturePolicy.shouldSubmit(event.keyCode, modifiers: event.modifierFlags, composing: hasMarkedText()) {
            onSubmit?(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

enum QuickCapturePolicy {
    static func shouldSubmit(_ key: UInt16, modifiers: NSEvent.ModifierFlags, composing: Bool) -> Bool {
        !composing && [36, 76].contains(key) && !modifiers.intersection([.command, .control]).isEmpty
    }
    static func validText(_ text: String) -> Bool { !text.isEmpty && text.utf16.count <= 10_000 }
    static func confirmed(_ data: [String: Any], origin: URL) -> Bool {
        guard let captureID = data["captureId"] as? String, UUID(uuidString: captureID) != nil,
              let jobID = data["jobId"] as? String, UUID(uuidString: jobID) != nil,
              let path = data["statusUrl"] as? String,
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              DesktopOrigin.contains(url, origin: origin), url.query == nil, url.fragment == nil,
              url.path == "/api/jobs/\(jobID)" else { return false }
        return true
    }
    static func selfTest() {
        func check(_ value: Bool) { if !value { fputs("FAIL: quick capture policy\n", stderr); exit(1) } }
        check(!validText("")); check(validText(String(repeating: "a", count: 10_000)))
        check(!validText(String(repeating: "🙂", count: 5_001)))
        let id = "00000000-0000-4000-8000-000000000001"
        let envelope: [String: Any] = ["captureId": id, "jobId": id, "statusUrl": "/api/jobs/\(id)"]
        check(confirmed(envelope, origin: DesktopOrigin.production))
        var hostile = envelope; hostile["statusUrl"] = "https://example.com/api/jobs/\(id)"
        check(!confirmed(hostile, origin: DesktopOrigin.production))
        hostile = envelope; hostile["jobId"] = "wrong"
        check(!confirmed(hostile, origin: DesktopOrigin.production))
        check(!shouldSubmit(36, modifiers: [], composing: false))
        check(!shouldSubmit(36, modifiers: .shift, composing: false))
        check(shouldSubmit(36, modifiers: .command, composing: false))
        check(shouldSubmit(76, modifiers: .control, composing: false))
        check(!shouldSubmit(36, modifiers: .command, composing: true))
        print("PASS: quick capture policy (11 checks)")
    }
}

@MainActor
final class DesktopQuickCapture: NSObject, NSWindowDelegate, NSTextViewDelegate {
    private weak var webView: WKWebView?
    private let origin: URL
    private let panel: CapturePanel
    private let editor = CaptureEditor()
    private let message = NSTextField(wrappingLabelWithString: L("⌘+Enter — отправить, Enter — новая строка"))
    private var messageText: () -> String = { L("⌘+Enter — отправить, Enter — новая строка") }
    private let submitButton = CaptureSubmitButton(title: "", target: nil, action: nil)
    private let surface = CaptureSurface()
    private var palette = CaptureAppearance.fallback(dark: true)
    private var paddingConstraints: [NSLayoutConstraint] = []
    private let scroll = NSScrollView()
    private var editorHeight: NSLayoutConstraint!
    private var messageHeight: NSLayoutConstraint!
    private let transport = CaptureTransport()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: transport, delegateQueue: nil)
    }()
    private struct Attempt {
        let raw: String
        let key: String
        let account: String
        let body: Data
    }
    private var attempt: Attempt?
    private var busy = false
    private var unconfirmed = false
    private var awaitingLogin = false
    private var previousApp: NSRunningApplication?
    var onLogin: (() -> Void)?
    var preventsRestart: Bool { busy || unconfirmed || !editor.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    func hideForRestart() { panel.orderOut(nil) }

    init(webView: WKWebView, origin: URL) {
        self.webView = webView; self.origin = origin
        panel = CapturePanel(contentRect: NSRect(x: 0, y: 0, width: 800, height: 165),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = L("Быстрая запись — Кизуна"); panel.titleVisibility = .hidden
        panel.isFloatingPanel = true; panel.level = .floating
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
        panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.delegate = self; panel.isMovableByWindowBackground = true
        let base = surface
        panel.contentView = base
        editor.isRichText = false; editor.font = .systemFont(ofSize: 17); editor.backgroundColor = .clear
        editor.drawsBackground = false; editor.textColor = .labelColor; editor.insertionPointColor = .labelColor
        editor.textContainerInset = NSSize(width: 0, height: 5)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]; editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 752, height: CGFloat.greatestFiniteMagnitude)
        editor.allowsUndo = true; editor.delegate = self; editor.setAccessibilityLabel(L("Новая запись"))
        editor.onSubmit = { [weak self] in self?.submit() }
        editor.onDismiss = { [weak self] in self?.hide(restoreFocus: true) }
        editor.onFocus = { [weak self] in self?.surface.focused = $0 }
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay; scroll.borderType = .noBorder
        scroll.documentView = editor; editor.frame = NSRect(x: 0, y: 0, width: 752, height: 44)
        message.font = .systemFont(ofSize: 12)
        submitButton.isBordered = false; submitButton.target = self; submitButton.action = #selector(submitAction)
        submitButton.toolTip = L("Сохранить запись — {CAPTURE_MOD}+Enter", ["CAPTURE_MOD": "⌘"])
        submitButton.setAccessibilityLabel(L("Сохранить запись"))
        submitButton.isEnabled = false
        for view in [scroll, message, submitButton] { view.translatesAutoresizingMaskIntoConstraints = false; base.addSubview(view) }
        editorHeight = scroll.heightAnchor.constraint(equalToConstant: 58)
        messageHeight = message.heightAnchor.constraint(equalToConstant: 14)
        paddingConstraints = [
            scroll.leadingAnchor.constraint(equalTo: base.leadingAnchor, constant: 24),
            scroll.topAnchor.constraint(equalTo: base.topAnchor, constant: 24),
            scroll.trailingAnchor.constraint(equalTo: base.trailingAnchor, constant: -24),
            submitButton.trailingAnchor.constraint(equalTo: base.trailingAnchor, constant: -24),
            submitButton.bottomAnchor.constraint(equalTo: base.bottomAnchor, constant: -24)
        ]
        NSLayoutConstraint.activate(paddingConstraints + [
            editorHeight, messageHeight,
            submitButton.widthAnchor.constraint(equalToConstant: 38), submitButton.heightAnchor.constraint(equalToConstant: 38),
            message.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 5),
            message.trailingAnchor.constraint(lessThanOrEqualTo: submitButton.leadingAnchor, constant: -18),
            message.centerYAnchor.constraint(equalTo: submitButton.centerYAnchor)
        ])
        if let saved = UserDefaults.standard.dictionary(forKey: "KizunaCaptureAppearance"), let value = CaptureAppearance.read(saved) {
            applyAppearance(value)
        } else { applyAppearance(.fallback(dark: NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)) }
        message.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    }

    func syncAppearance(_ snapshot: [String: Any]) {
        guard let value = CaptureAppearance.read(snapshot) else { return }
        UserDefaults.standard.set(snapshot, forKey: "KizunaCaptureAppearance")
        applyAppearance(value)
    }
    private func applyAppearance(_ value: CaptureAppearance) {
        palette = value; surface.palette = value; submitButton.palette = value
        panel.appearance = NSAppearance(named: value.dark ? .darkAqua : .aqua)
        editor.font = value.editorFont; editor.textColor = value.ink; editor.insertionPointColor = value.caret
        editor.placeholder = value.placeholder; editor.placeholderColor = value.placeholderColor
        let paragraph = NSMutableParagraphStyle(); paragraph.minimumLineHeight = value.lineHeight
        editor.defaultParagraphStyle = paragraph
        editor.typingAttributes[.paragraphStyle] = paragraph
        if let storage = editor.textStorage { storage.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: storage.length)) }
        message.textColor = value.muted
        for (index, constraint) in paddingConstraints.enumerated() { constraint.constant = index < 2 ? value.padding : -value.padding }
        if editorHeight != nil { updateLayout() }
    }

    private func setMessage(_ value: @autoclosure @escaping () -> String) {
        messageText = value
        message.stringValue = value()
    }
    func refreshLocale() {
        panel.title = L("Быстрая запись — Кизуна")
        editor.setAccessibilityLabel(L("Новая запись"))
        submitButton.toolTip = L("Сохранить запись — {CAPTURE_MOD}+Enter", ["CAPTURE_MOD": "⌘"])
        submitButton.setAccessibilityLabel(L("Сохранить запись"))
        message.stringValue = messageText()
        editor.needsDisplay = true
        updateLayout()
    }
    func show() {
        refreshLocale()
        if panel.isVisible { panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(editor); return }
        previousApp = NSWorkspace.shared.frontmostApplication
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let frame = screen?.visibleFrame {
            let width = min(800, frame.width - 40)
            panel.setFrame(NSRect(x: frame.midX - width / 2, y: frame.minY + frame.height * 0.68 - 165, width: width, height: 165), display: true)
        }
        updateLayout()
        panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
    }
    func resumeAfterLogin() {
        guard awaitingLogin else { return }
        awaitingLogin = false
        setMessage(L("Вход выполнен.") + " " + L("Сохранить запись — {CAPTURE_MOD}+Enter", ["CAPTURE_MOD": "⌘"]))
        show()
    }
    private func hide(restoreFocus: Bool) {
        let wasVisible = panel.isVisible
        panel.orderOut(nil)
        if restoreFocus && wasVisible, let previousApp, !previousApp.isTerminated { previousApp.activate(options: []) }
    }
    func windowDidResignKey(_ notification: Notification) { hide(restoreFocus: false) }
    @objc private func dismissAction() { hide(restoreFocus: true) }
    @objc private func submitAction() { submit() }
    func textDidChange(_ notification: Notification) {
        let raw = editor.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty && !unconfirmed { attempt = nil }
        submitButton.isEnabled = !busy && QuickCapturePolicy.validText(raw)
        if !QuickCapturePolicy.validText(raw) && !raw.isEmpty { setMessage(L("В записи может быть не больше 10 000 символов.")) }
        else if !busy && !unconfirmed { setMessage(L("⌘+Enter — отправить, Enter — новая строка")) }
        updateLayout()
    }
    private func updateLayout() {
        guard let container = editor.textContainer, let manager = editor.layoutManager else { return }
        panel.contentView?.layoutSubtreeIfNeeded()
        manager.ensureLayout(for: container)
        // Include the extra line fragment, so Enter grows immediately.
        let textHeight = max(manager.usedRect(for: container).height, manager.extraLineFragmentRect.maxY)
        let desiredEditor = min((panel.screen?.visibleFrame.height ?? 700) * 0.4, max(ceil(palette.fontSize * 3.4), ceil(textHeight + editor.textContainerInset.height * 2)))
        let messageWidth = max(160, panel.frame.width - palette.padding * 2 - 61)
        let labelRect = (message.stringValue as NSString).boundingRect(with: NSSize(width: messageWidth, height: 100),
            options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: message.font ?? NSFont.systemFont(ofSize: 12)])
        let desiredMessage = max(14, ceil(labelRect.height))
        editorHeight.constant = desiredEditor; messageHeight.constant = desiredMessage
        let height = palette.padding * 2 + desiredEditor + 21 + max(38, desiredMessage)
        var frame = panel.frame; frame.origin.y += frame.height - height; frame.size.height = height
        panel.setFrame(frame, display: true)
        panel.contentView?.layoutSubtreeIfNeeded()
        editor.needsDisplay = true
    }
    private func setBusy(_ value: Bool) {
        busy = value; editor.isEditable = !value && !unconfirmed
        submitButton.isEnabled = !value && QuickCapturePolicy.validText(editor.string.trimmingCharacters(in: .whitespacesAndNewlines))
        submitButton.alphaValue = value ? 0.65 : 1
        submitButton.needsDisplay = true
        updateLayout()
    }
    private enum CaptureError: Error { case login, changedAccount, message(String) }
    private func cookieHeader() async throws -> String {
        guard let webView else { throw CaptureError.login }
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        let selected = cookies.filter {
            $0.name == "pagent_session" && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == origin.host?.lowercased()
            && $0.path == "/" && (!$0.isSecure || origin.scheme == "https")
            && ($0.expiresDate == nil || $0.expiresDate! > Date())
        }
        guard !selected.isEmpty, let header = HTTPCookie.requestHeaderFields(with: selected)["Cookie"] else { throw CaptureError.login }
        return header
    }
    private func request(_ path: String, cookie: String, attempt: Attempt? = nil) async throws -> (Int, [String: Any]) {
        let url = URL(string: path, relativeTo: origin)!.absoluteURL
        var request = URLRequest(url: url); request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(DesktopLocale.current, forHTTPHeaderField: "Accept-Language")
        if let attempt {
            request.httpMethod = "POST"; request.httpBody = attempt.body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("respond-async", forHTTPHeaderField: "Prefer")
            request.setValue(attempt.key, forHTTPHeaderField: "Idempotency-Key")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, let final = response.url,
              DesktopOrigin.contains(final, origin: origin), data.count <= 1_048_576 else { throw CaptureError.message(L("Не удалось проверить ответ сервера. Черновик сохранён.")) }
        if response.statusCode == 401 { throw CaptureError.login }
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CaptureError.message(L("Сервер не подтвердил сохранение. Повторите отправку.")) }
        return (response.statusCode, payload)
    }
    private func submit() {
        let raw = editor.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, QuickCapturePolicy.validText(raw) else { return }
        guard !unconfirmed || attempt?.raw == raw else {
            setMessage(L("Сначала нужно подтвердить прежнюю отправку. Верните исходный текст для безопасного повтора."))
            updateLayout()
            return
        }
        setBusy(true); setMessage(L("Сохраняем запись…"))
        Task { [weak self] in
            guard let self else { return }
            let previouslyUnconfirmed = self.unconfirmed
            defer { self.setBusy(false) }
            do {
                let cookie = try await self.cookieHeader()
                let (meStatus, me) = try await self.request("/api/auth/me", cookie: cookie)
                guard meStatus == 200, let account = (me["user"] as? [String: Any])?["id"] as? String else { throw CaptureError.login }
                if let previous = self.attempt, previous.account != account { throw CaptureError.changedAccount }
                if self.attempt?.raw != raw {
                    var body: [String: Any] = ["raw": raw]
                    if let webView = self.webView, let url = webView.url, DesktopOrigin.contains(url, origin: self.origin),
                       let selected = try? await webView.evaluateJavaScript("""
                       (() => {
                         const provider = document.querySelector('#ai-provider');
                         const model = document.querySelector('#ai-model');
                         const result = {};
                         if (provider?.options.length) {
                           result.provider = provider.value || 'fallback';
                           if (['openrouter','openai','gemini'].includes(result.provider) && model?.value) result.model = model.value;
                         }
                         return result;
                       })()
                       """), let options = selected as? [String: String] {
                        for key in ["provider", "model"] { if let value = options[key] { body[key] = value } }
                    }
                    self.attempt = Attempt(raw: raw, key: "mac-\(UUID().uuidString)", account: account, body: try JSONSerialization.data(withJSONObject: body))
                }
                guard let pending = self.attempt else { return }
                // Never send a draft after the session in the web view changes.
                guard try await self.cookieHeader() == cookie else { throw CaptureError.changedAccount }
                self.unconfirmed = true
                let (status, payload) = try await self.request("/api/captures", cookie: cookie, attempt: pending)
                if !previouslyUnconfirmed && (400..<500).contains(status) && status != 409 { self.unconfirmed = false }
                guard status == 202, QuickCapturePolicy.confirmed(payload, origin: self.origin) else {
                    let detail = (payload["error"] as? [String: Any])?["message"] as? String
                    throw CaptureError.message(detail ?? L("Сервер не подтвердил сохранение. Черновик остался здесь."))
                }
                self.editor.string = ""; self.editor.undoManager?.removeAllActions(); self.attempt = nil
                self.unconfirmed = false
                self.setMessage(L("⌘+Enter — отправить, Enter — новая строка"))
                self.hide(restoreFocus: true)
            } catch CaptureError.login {
                self.awaitingLogin = true; self.setMessage(L("Войдите в Кизуну. Черновик останется здесь."))
                self.hide(restoreFocus: false); self.onLogin?()
            } catch CaptureError.changedAccount {
                self.setMessage(L("Учётная запись изменилась. Вернитесь в прежнюю учётную запись для отправки этого черновика."))
            } catch CaptureError.message(let message) {
                self.setMessage(message)
            } catch {
                if self.unconfirmed {
                    self.setMessage(L("Сервер не подтвердил сохранение. Повторите отправку.") + " " + L("Сохранить запись — {CAPTURE_MOD}+Enter", ["CAPTURE_MOD": "⌘"]))
                } else {
                    self.setMessage(L("Нет связи с сервером. Черновик сохранён — попробуйте ещё раз."))
                }
            }
        }
    }
}
