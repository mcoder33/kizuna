import Foundation
import JavaScriptCore
@main enum RestartScriptTests {
    static func main() {
        let context = JSContext()!
        context.evaluateScript("var window = {}; var calls = 0;")
        let message = "引用 \"; calls = 99; // \nline \\ path"
        let script = DesktopRestartScript.prepare(fallbackMessage: message)!
        let output = context.evaluateScript(script)!.toString()!
        let status = try! JSONSerialization.jsonObject(with: Data(output.utf8)) as! [String: Any]
        precondition(status["reason"] as? String == message)
        precondition(context.evaluateScript("calls")!.toInt32() == 0)
        context.evaluateScript("window.KizunaUpdateGuard = {prepare() { calls += 1; return null; }}")
        let guardedOutput = context.evaluateScript(script)!.toString()!
        let guarded = try! JSONSerialization.jsonObject(with: Data(guardedOutput.utf8)) as! [String: Any]
        precondition(guarded["reason"] is NSNull)
        precondition(context.evaluateScript("calls")!.toInt32() == 1)
        print("PASS: localized restart fallback stays data; guard executes unchanged")
    }
}
