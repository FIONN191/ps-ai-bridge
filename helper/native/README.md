# macOS 快捷键组件

源码 hotkey.swift 使用系统 Carbon RegisterEventHotKey，不录制或监听普通输入，不使用事件 tap。仅前台 bundle ID 为 com.adobe.Photoshop 且插件心跳不超过 2 秒时注册；离开 PS 或心跳失效时释放。

通过 stdin 接收 JSON 行 {code, mods, enabled}；stdout 返回 ready / error:OSStatus / fire。按下到松开之间只发送一次 fire。stdin 关闭时退出。

构建：
```sh
xcrun swiftc helper/native/hotkey.swift -o helper/native/hotkey-macos-arm64 -target arm64-apple-macosx12.0
xcrun swiftc helper/native/hotkey.swift -o helper/native/hotkey-macos-x64 -target x86_64-apple-macosx12.0
```

二进制需要保留执行权限，使用 macOS 自带 framework，无额外运行时。x64 为交叉编译产物，未在 Intel Mac 实机验证。
