import Foundation
import AppKit
import WebKit
import UserNotifications

// URLSession has no shared browser cookie jar and never follows a redirect.
private final class NotificationTransport: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// Pure helpers also used by the notification policy smoke check.
enum DesktopNotificationPolicy {
    static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        func port(_ url: URL) -> Int { url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80) }
        return url.scheme?.lowercased() == origin.scheme?.lowercased()
            && url.host?.lowercased() == origin.host?.lowercased()
            && port(url) == port(origin) && url.user == nil && url.password == nil
    }

    // Unknown/malformed settings fail closed, rather than exposing private text.
    static func isQuiet(_ value: String, at: Date, timeZone: String) -> Bool {
        if value == "off" { return false }
        guard let zone = TimeZone(identifier: timeZone) else { return true }
        let bounds = value.split(separator: "-", omittingEmptySubsequences: false)
        func minute(_ text: Substring) -> Int? {
            let parts = text.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
                  let hour = Int(parts[0]), let minute = Int(parts[1]),
                  (0...23).contains(hour), (0...59).contains(minute) else { return nil }
            return hour * 60 + minute
        }
        guard bounds.count == 2, let from = minute(bounds[0]), let to = minute(bounds[1]) else { return true }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let clock = calendar.component(.hour, from: at) * 60 + calendar.component(.minute, from: at)
        if from == to { return false }
        return from < to ? clock >= from && clock < to : clock >= from || clock < to
    }

    static func shouldDeliver(item: [String: Any], preferences: [String: String],
                              defaults: [String: String], quiet: Bool) -> Bool {
        guard !quiet, let kind = item["kind"] as? String,
              item["read"] as? Bool == false, item["resolved"] as? Bool == false,
              item["dismissed"] as? Bool != true else { return false }
        return (preferences[kind] ?? defaults[kind]) == "phone"
    }
}

// Best effort while the application runs; this is not a background push service.
// Opening a banner only navigates the real UI: it never mutates read state.
@MainActor
final class DesktopNotifications: NSObject, UNUserNotificationCenterDelegate {
    private weak var webView: WKWebView?
    private let origin: URL
    private let center = UNUserNotificationCenter.current()
    private let transport = NotificationTransport()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: transport, delegateQueue: nil)
    }()
    private var timer: Timer?
    private var pollTask: Task<Void, Never>?
    private var active = false
    private var generation = 0
    private var accountID: String?
    private var delivery = DesktopNotificationDelivery()
    var onOpen: ((URL) -> Void)?

    init(webView: WKWebView, origin: URL) {
        self.webView = webView
        self.origin = origin
        super.init()
        center.delegate = self
    }

    func start() {
        guard !active, UserDefaults.standard.object(forKey: "desktopNotificationsEnabled") as? Bool != false else { return }
        active = true
        poll()
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func stop() {
        active = false
        generation += 1
        timer?.invalidate()
        timer = nil
        pollTask?.cancel()
        pollTask = nil
    }

    // Called only from the user's explicit menu action, never at startup.
    func requestAuthorization() {
        Task {
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound])
                if granted {
                    UserDefaults.standard.set(true, forKey: "desktopNotificationsEnabled")
                    start()
                    refresh()
                } else {
                    showMessage(L("Уведомления запрещены в macOS. Разрешите их в Системных настройках → Уведомления → Кизуна."))
                }
            } catch { showMessage(error.localizedDescription) }
            publishAuthorization()
        }
    }

    func disable() {
        UserDefaults.standard.set(false, forKey: "desktopNotificationsEnabled")
        stop()
        publishAuthorization()
    }

    func refresh() {
        publishAuthorization()
        poll()
    }

    func publishAuthorization() {
        Task {
            let settings = await center.notificationSettings()
            let authorized = settings.authorizationStatus == .authorized
            let enabled = UserDefaults.standard.object(forKey: "desktopNotificationsEnabled") as? Bool != false
            let state = ["authorized": authorized, "enabled": enabled,
                         "denied": settings.authorizationStatus == .denied]
            guard let webView, let url = webView.url,
                  DesktopNotificationPolicy.sameOrigin(url, origin),
                  let data = try? JSONSerialization.data(withJSONObject: state),
                  let json = String(data: data, encoding: .utf8) else { return }
            _ = try? await webView.evaluateJavaScript("window.KizunaNotificationState = \(json); window.dispatchEvent(new Event('pagent:notificationschange'));")
        }
    }

    func sendTest() {
        Task {
            let settings = await center.notificationSettings()
            guard settings.authorizationStatus == .authorized else { requestAuthorization(); return }
            let content = UNMutableNotificationContent()
            content.title = L("Кизуна")
            content.body = L("Уведомления включены на этом устройстве")
            content.sound = .default
            content.userInfo = ["url": origin.absoluteString + "#today"]
            do { try await center.add(UNNotificationRequest(identifier: "kizuna-test", content: content, trigger: nil)) }
            catch { showMessage(error.localizedDescription) }
        }
    }

    private func showMessage(_ text: String) {
        let alert = NSAlert()
        alert.messageText = L("Кизуна")
        alert.informativeText = text
        alert.runModal()
    }

    private func resetAccount() {
        accountID = nil
        delivery = DesktopNotificationDelivery()
    }

    private func poll() {
        guard active, pollTask == nil, let webView else { return }
        let currentGeneration = generation
        pollTask = Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            defer { if self.generation == currentGeneration { self.pollTask = nil } }
            do {
                let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
                let valid = cookies.filter { cookie in
                    let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
                    return cookie.name == "pagent_session" && domain.lowercased() == self.origin.host?.lowercased()
                        && cookie.path == "/" && (!cookie.isSecure || self.origin.scheme == "https")
                        && (cookie.expiresDate == nil || cookie.expiresDate! > Date())
                }
                guard !valid.isEmpty else { self.resetAccount(); return }
                let headers = HTTPCookie.requestHeaderFields(with: valid)
                let me = try await self.json("/api/auth/me", headers: headers)
                guard let user = me["user"] as? [String: Any], let id = user["id"] as? String else { return }
                if self.accountID != id {
                    self.resetAccount()
                    self.accountID = id
                }
                let configuration = try await self.json("/api/settings", headers: headers)
                guard let settings = configuration["settings"] as? [String: Any],
                      let encoded = settings["notifyPrefs"] as? String,
                      let data = encoded.data(using: .utf8),
                      let preferences = try JSONSerialization.jsonObject(with: data) as? [String: String],
                      let quietHours = settings["quietHours"] as? String,
                      let timeZone = configuration["timeZone"] as? String else { return }
                let page = try await self.json("/api/notifications", headers: headers)
                guard let items = page["notifications"] as? [[String: Any]],
                      let kinds = page["kinds"] as? [[String: Any]] else { return }
                guard self.active, self.generation == currentGeneration, !Task.isCancelled else { return }
                let ids = Set(items.compactMap { $0["id"] as? String })
                if self.delivery.baseline(ids) { return }
                let defaults = Dictionary(kinds.compactMap { kind -> (String, String)? in
                    guard let key = kind["key"] as? String, let mode = kind["default"] as? String else { return nil }
                    return (key, mode)
                }, uniquingKeysWith: { first, _ in first })
                let quiet = DesktopNotificationPolicy.isQuiet(quietHours, at: Date(), timeZone: timeZone)
                let authorization = await self.center.notificationSettings()
                guard self.active, self.generation == currentGeneration, !Task.isCancelled else { return }
                // Do not display an old account's text after logout/account switch.
                let currentCookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
                guard currentCookies.contains(where: { fresh in
                    valid.contains(where: { $0.name == fresh.name && $0.domain == fresh.domain && $0.value == fresh.value })
                }) else { self.resetAccount(); return }
                guard self.active, self.generation == currentGeneration, !Task.isCancelled else { return }
                for item in items.reversed() {
                    guard let id = item["id"] as? String else { continue }
                    guard DesktopNotificationPolicy.shouldDeliver(item: item, preferences: preferences, defaults: defaults, quiet: quiet),
                          let url = self.destination(item) else { self.delivery.ignore(id); continue }
                    guard authorization.authorizationStatus == .authorized else { continue }
                    guard self.active, self.generation == currentGeneration, !Task.isCancelled else { return }
                    let content = UNMutableNotificationContent()
                    content.title = (item["data"] as? [String: Any])?["pushTitle"] as? String ?? L("Кизуна")
                    content.body = [item["lead"] as? String, item["text"] as? String].compactMap { $0 }.joined(separator: " ")
                    content.sound = .default
                    content.userInfo = ["url": url.absoluteString]
                    let request = UNNotificationRequest(identifier: "kizuna-\(id)", content: content, trigger: nil)
                    try? await self.delivery.deliver(id) { try await self.center.add(request) }
                }
            } catch {
                if (error as? PollError) == .unauthorized { self.resetAccount() }
                // Temporary network/settings failures never generate notifications.
            }
        }
    }

    private enum PollError: Error { case unauthorized, invalidResponse }
    private func json(_ path: String, headers: [String: String]) async throws -> [String: Any] {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              DesktopNotificationPolicy.sameOrigin(url, origin) else { throw PollError.invalidResponse }
        var request = URLRequest(url: url)
        request.allHTTPHeaderFields = headers
        request.setValue(DesktopLocale.current, forHTTPHeaderField: "Accept-Language")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, let finalURL = response.url,
              DesktopNotificationPolicy.sameOrigin(finalURL, origin) else { throw PollError.invalidResponse }
        if response.statusCode == 401 { throw PollError.unauthorized }
        guard response.statusCode == 200, data.count <= 1_048_576,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw PollError.invalidResponse }
        return object
    }

    private func destination(_ item: [String: Any]) -> URL? {
        let data = item["data"] as? [String: Any] ?? [:]
        var path = data["url"] as? String
        if path == nil {
            func escaped(_ value: String) -> String {
                value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            }
            if let id = item["captureId"] as? String { path = "/#today?open=\(escaped(id))" }
            else if let id = item["roomId"] as? String { path = "/#circles?room=\(escaped(id))" }
            else if item["circleId"] is String { path = "/#circles" }
            else if ["invite", "event_added", "event_changed"].contains(item["kind"] as? String ?? "") {
                path = "/#calendar"
                if let date = data["date"] as? String {
                    path! += "?date=\(escaped(date))"
                    if let event = item["eventUid"] as? String { path! += "&event=\(escaped(event))" }
                }
            } else {
                path = item["kind"] as? String == "signup" ? "/#admin"
                    : ["spend", "calendar_error"].contains(item["kind"] as? String ?? "") ? "/#settings" : "/#today"
            }
        }
        guard let path, let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              DesktopNotificationPolicy.sameOrigin(url, origin) else { return nil }
        return url
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        let target = response.notification.request.content.userInfo["url"] as? String
        Task { @MainActor [weak self] in
            guard let self, let target, let url = URL(string: target),
                  DesktopNotificationPolicy.sameOrigin(url, self.origin) else { return }
            self.onOpen?(url)
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
