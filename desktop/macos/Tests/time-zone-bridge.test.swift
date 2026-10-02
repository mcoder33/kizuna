import Foundation
import JavaScriptCore

@main enum TimeZoneBridgeTests {
    static func main() {
        let context = JSContext()!
        context.evaluateScript("var events=[]; var window={dispatchEvent:function(event){events.push(event.type)}}; function CustomEvent(type){this.type=type}")
        for identifier in ["America/New_York", "Asia/Tokyo", "UTC", "x\"; window.injected=true; //\n山田\\y"] {
            context.evaluateScript(DesktopTimeZone.script(identifier:identifier))
            precondition(context.exception == nil)
            precondition(context.evaluateScript("window.KizunaSystemTimeZone")!.toString() == identifier)
            precondition(context.evaluateScript("window.injected")!.isUndefined)
            precondition(context.evaluateScript("events[events.length-1]")!.toString() == "pagent:systemtimezonechange")
        }
        context.evaluateScript(DesktopTimeZone.script())
        precondition(context.evaluateScript("window.KizunaSystemTimeZone")!.toString() == TimeZone.current.identifier)
        precondition(context.evaluateScript("events.length")!.toInt32() == 5)
        print("PASS: native OS time zone detection and changes remain safely serialized data")
    }
}
