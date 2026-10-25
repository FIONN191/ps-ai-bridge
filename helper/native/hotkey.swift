import AppKit
import Carbon

var hotkey: EventHotKeyRef?
var code: UInt32 = 5
var mods: UInt32 = UInt32(cmdKey)
var enabled = false
var held = false
var lastHeartbeat = Date.distantPast
var lastStatus = ""
func emit(_ value: String) { print(value); fflush(stdout) }
func refresh() {
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
    let active = enabled && Date().timeIntervalSince(lastHeartbeat) < 2 && front == "com.adobe.Photoshop"
    if !active {
        if let h = hotkey { UnregisterEventHotKey(h); hotkey = nil }
        held = false
        if lastStatus != "idle" { emit("idle"); lastStatus = "idle" }
        return
    }
    if hotkey == nil {
        let result = RegisterEventHotKey(code, mods, EventHotKeyID(signature: 0x50534149, id: 1), GetApplicationEventTarget(), 0, &hotkey)
        let status = result == noErr ? "ready" : "error:\(result)"
        if status != lastStatus { emit(status); lastStatus = status }
    }
}
var eventTypes = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)), EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
    if let e = event {
        if GetEventKind(e) == UInt32(kEventHotKeyReleased) { held = false }
        else if !held { held = true; emit("fire") }
    }
    return noErr
}, 2, &eventTypes, nil, nil)
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let c = json["code"] as? UInt32, let m = json["mods"] as? UInt32, let en = json["enabled"] as? Bool else { continue }
        DispatchQueue.main.async {
            if c != code || m != mods || en != enabled {
                if let h = hotkey { UnregisterEventHotKey(h); hotkey = nil }
                held = false; lastStatus = ""
            }
            code = c; mods = m; enabled = en; lastHeartbeat = Date(); refresh()
        }
    }
    DispatchQueue.main.async { exit(0) }
}
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in refresh() }
RunLoop.main.run()
