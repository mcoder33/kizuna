import AppKit
import WebKit

struct DesktopOrigin {
    static let production = URL(string: "https://yourkizuna.com")!

    static func configured(_ value: String?) -> URL {
        guard let value, let url = URL(string: value),
              let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil,
              url.scheme?.lowercased() == "https" ||
                (url.scheme?.lowercased() == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return production }
        parts.path = "/"
        parts.query = nil
        parts.fragment = nil
        return parts.url ?? production
    }

    static func contains(_ url: URL, origin: URL) -> Bool {
        func port(_ url: URL) -> Int? { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }
        return url.user == nil && url.password == nil &&
            url.scheme?.lowercased() == origin.scheme?.lowercased() &&
            url.host?.lowercased() == origin.host?.lowercased() && port(url) == port(origin)
    }

    static func canOpenExternally(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil else { return false }
        switch url.scheme?.lowercased() {
        case "https", "http": return url.host != nil
        case "mailto", "tel": return true
        default: return false
        }
    }

    static func selfTest() {
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            guard condition() else { fputs("FAIL: \(message)\n", stderr); exit(1) }
        }
        let prod = production
        check(configured(nil) == prod, "default origin")
        check(configured("http://attacker.example") == prod, "reject plaintext remote origin")
        check(configured("https://user:pass@attacker.example") == prod, "reject URL credentials")
        check(configured("file:///tmp/index.html") == prod, "reject local file origin")
        let loopback = configured("http://127.0.0.1:8878/test?x=1#today")
        check(loopback.absoluteString == "http://127.0.0.1:8878/", "loopback configuration normalized")
        check(configured("https://preview.example/path").absoluteString == "https://preview.example/", "explicit HTTPS configuration")
        check(contains(URL(string: "https://yourkizuna.com:443/login")!, origin: prod), "same-origin login")
        check(!contains(URL(string: "https://yourkizuna.com.evil.test/")!, origin: prod), "reject host suffix")
        check(!contains(URL(string: "https://yourkizuna.com:444/")!, origin: prod), "reject changed port")
        check(!contains(URL(string: "http://yourkizuna.com/")!, origin: prod), "reject scheme downgrade")
        check(!contains(URL(string: "https://kizuna.agent-hub.space/")!, origin: prod), "legacy host is a different origin")
        for value in ["javascript:alert(1)", "file:///tmp/data", "data:text/html,test", "custom:payload"] {
            check(!canOpenExternally(URL(string: value)!), "reject external scheme \(value)")
        }
        check(canOpenExternally(URL(string: "https://example.com")!), "allow external web link")
        check(canOpenExternally(URL(string: "mailto:user@example.com")!), "allow mail link")
        print("PASS: desktop navigation policy (17 checks)")
    }
}

final class DesktopNavigation: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let origin: URL
    var onLoad: (() -> Void)?
    var onFailure: ((Error) -> Void)?
    var onStart: (() -> Void)?
    weak var window: NSWindow?
    private var downloads: [WKDownload] = []

    init(origin: URL) { self.origin = origin }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if DesktopOrigin.contains(url, origin: origin) {
            if navigationAction.shouldPerformDownload { decisionHandler(.download) }
            else if navigationAction.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(navigationAction.request)
            } else { decisionHandler(.allow) }
        } else {
            decisionHandler(.cancel)
            // Support the app's user-facing window.open meeting buttons too.
            // Subframes and main-window automatic redirects cannot launch apps.
            if (navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil),
               navigationAction.sourceFrame.isMainFrame,
               navigationAction.sourceFrame.request.url.map({ DesktopOrigin.contains($0, origin: origin) }) == true,
               DesktopOrigin.canOpenExternally(url) { NSWorkspace.shared.open(url) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, DesktopOrigin.contains(url, origin: origin) else {
            decisionHandler(.cancel); return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { onStart?() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onLoad?() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onFailure?(NSError(domain: "Kizuna", code: 1, userInfo: [NSLocalizedDescriptionKey: L("Окно приложения нужно перезагрузить.")]))
    }
    private func failed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        onFailure?(error)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard trusted(frame) else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = L("Кизуна"); alert.informativeText = message
        alert.runModal(); completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard trusted(frame) else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = L("Кизуна"); alert.informativeText = message
        alert.addButton(withTitle: L("Продолжить")); alert.addButton(withTitle: L("Отмена"))
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard trusted(frame) else { completionHandler(nil); return }
        let alert = NSAlert(); alert.messageText = L("Кизуна"); alert.informativeText = prompt
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        alert.accessoryView = field; alert.addButton(withTitle: L("Сохранить")); alert.addButton(withTitle: L("Отмена"))
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard trusted(frame), let window else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    private func trusted(_ frame: WKFrameInfo) -> Bool {
        frame.isMainFrame && frame.request.url.map { DesktopOrigin.contains($0, origin: origin) } == true
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { own(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { own(download) }
    private func own(_ download: WKDownload) { downloads.append(download); download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard let window else { completionHandler(nil); return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map { DesktopOrigin.contains($0, origin: origin) } == true ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) { downloads.removeAll { $0 === download } }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeAll { $0 === download }
        let alert = NSAlert(); alert.messageText = L("Не удалось скачать файл"); alert.informativeText = error.localizedDescription
        alert.runModal()
    }
}
