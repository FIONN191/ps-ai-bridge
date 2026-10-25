import AppKit
import Carbon

// Carbon 的全局快捷键事件要靠应用的事件循环分发：必须启动 NSApplication（.accessory 不显示 Dock 图标），
// 只跑 RunLoop 的话注册会成功，但按键永远收不到。
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// 只在这个程序在前台时生效；PS_AI_BRIDGE_HOTKEY_APP 是测试用的，平时就是 Photoshop（正式版和 Beta 的 bundle ID 一样）
let targetApp = ProcessInfo.processInfo.environment["PS_AI_BRIDGE_HOTKEY_APP"] ?? "com.adobe.Photoshop"
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
    let active = enabled && Date().timeIntervalSince(lastHeartbeat) < 2 && front == targetApp
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
app.run()
