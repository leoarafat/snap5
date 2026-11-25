import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ServiceManagement

enum Option: String {
    case quickKey, ignoreTyping, chromeHandlesFive, keepHistory, sound
    var isOn: Bool { UserDefaults.standard.object(forKey: rawValue) as? Bool ?? true }
    func toggle() { UserDefaults.standard.set(!isOn, forKey: rawValue) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private let keys = KeyMonitor()
    private let hotKeys = HotKeys()
    private let notice = Notice()
    private let pins = Pins()
    private var session: CaptureSession?
    private var permissionTimer: Timer?
    private var busy = false
    private let output = Output()

    private var webFolder: URL { Bundle.main.resourceURL!.appendingPathComponent("web") }

    /// Browsers where the Snap5 extension already reacts to "5".
    private let chromeBundles: Set<String> = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let icon = NSImage(systemSymbolName: "5.square.fill", accessibilityDescription: "Snap5")
        icon?.isTemplate = true
        statusItem.button?.image = icon
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        installEditMenu()

        keys.shouldListen = { [weak self] in
            guard let self, Option.quickKey.isOn, self.session == nil, !self.busy else { return false }
            let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
            return !(Option.chromeHandlesFive.isOn && self.chromeBundles.contains(front))
        }
        keys.ignoreWhileTyping = { Option.ignoreTyping.isOn }
        keys.onDouble = { [weak self] in self?.captureArea() }
        keys.onTriple = { [weak self] in self?.copyWholeScreen() }

        hotKeys.register("⌃⌥S", key: kVK_ANSI_S) { [weak self] in self?.captureArea() }
        hotKeys.register("⌃⌥F", key: kVK_ANSI_F) { [weak self] in self?.copyWholeScreen() }

        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(appActivated), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        if let front = NSWorkspace.shared.frontmostApplication { Focus.prepare(front) }

        requestPermissionsOnFirstRun()
        keys.start()
        // Permissions can be granted while the app is running.
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            if self?.keys.isRunning == false { self?.keys.start() }
        }
    }

    @objc private func appActivated(_ notification: Notification) {
        if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { Focus.prepare(app) }
    }

    /// Without an Edit menu, ⌘C and ⌘V would not work inside the text tool.
    private func installEditMenu() {
        let main = NSMenu()
        let item = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        item.submenu = edit
        main.addItem(item)
        NSApp.mainMenu = main
    }

    // MARK: permissions

    private func requestPermissionsOnFirstRun() {
        if UserDefaults.standard.bool(forKey: "askedPermissions") { return }
        UserDefaults.standard.set(true, forKey: "askedPermissions")
        let alert = NSAlert()
        alert.messageText = "Welcome to Snap5"
        alert.informativeText = """
        Snap5 lives in the menu bar. macOS will now ask for three permissions. Turn on Snap5 for each one:

        1. Screen & System Audio Recording: to take screenshots.
        2. Input Monitoring: to notice 5 5 and 5 5 5. Snap5 only looks for the 5 key and stores nothing you type.
        3. Accessibility: to ignore 5 while you are typing in a text box.

        After turning them on, quit Snap5 and open it again.
        ⌃⌥S (area) and ⌃⌥F (whole screen) need only the first permission.
        """
        alert.addButton(withTitle: "Continue")
        NSApp.activate()
        alert.runModal()
        _ = CGRequestScreenCaptureAccess()
        _ = CGRequestListenEventAccess()
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    private func openSettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    @objc private func fixScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
        openSettings("Privacy_ScreenCapture")
    }

    @objc private func fixInputMonitoring() {
        _ = CGRequestListenEventAccess()
        openSettings("Privacy_ListenEvent")
    }

    @objc private func fixAccessibility() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        openSettings("Privacy_Accessibility")
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func add(_ title: String, _ action: Selector?, on: Bool = false) {
            let item = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
            item.target = self
            item.state = on ? .on : .off
        }
        add("Capture area or window      5 5  ·  ⌃⌥S", #selector(menuArea))
        add("Copy whole screen      5 5 5  ·  ⌃⌥F", #selector(menuScreen))
        add("Capture area after 3 seconds", #selector(menuDelayed))
        menu.addItem(.separator())

        let screen = CGPreflightScreenCaptureAccess()
        let input = CGPreflightListenEventAccess()
        let trusted = AXIsProcessTrusted()
        if !screen { add("⚠️ Allow Screen Recording…", #selector(fixScreenRecording)) }
        if !input { add("⚠️ Allow Input Monitoring (needed for 5 5)…", #selector(fixInputMonitoring)) }
        if !trusted { add("⚠️ Allow Accessibility (ignores 5 while typing)…", #selector(fixAccessibility)) }
        if screen && input && trusted { add("✓ All permissions allowed", nil) }
        if input && !keys.isRunning { add("Quit and reopen Snap5 to turn on 5 5", nil) }
        if !hotKeys.failed.isEmpty { add("Shortcut taken by another app: \(hotKeys.failed.joined(separator: ", "))", nil) }
        menu.addItem(.separator())

        add("Use the 5 key (5 5 and 5 5 5)", #selector(toggleQuickKey), on: Option.quickKey.isOn)
        add("Ignore 5 while typing", #selector(toggleTyping), on: Option.ignoreTyping.isOn)
        add("In Chrome, let the extension handle 5", #selector(toggleChrome), on: Option.chromeHandlesFive.isOn)
        add("Keep a copy in Pictures/Snap5", #selector(toggleHistory), on: Option.keepHistory.isOn)
        add("Shutter sound", #selector(toggleSound), on: Option.sound.isOn)
        add("Start Snap5 at login", #selector(toggleLogin), on: SMAppService.mainApp.status == .enabled)
        menu.addItem(.separator())
        add("Open captures folder", #selector(openFolder))
        menu.addItem(withTitle: "Quit Snap5", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    @objc private func menuArea() { later(0.25) { self.captureArea() } }
    @objc private func menuScreen() { later(0.25) { self.copyWholeScreen() } }
    @objc private func menuDelayed() {
        for second in 0..<3 { later(Double(second)) { self.notice.show("Capturing in \(3 - second)…") } }
        later(3.1) {
            self.notice.hide()
            self.later(0.15) { self.captureArea() }
        }
    }
    @objc private func toggleQuickKey() { Option.quickKey.toggle() }
    @objc private func toggleTyping() { Option.ignoreTyping.toggle() }
    @objc private func toggleChrome() { Option.chromeHandlesFive.toggle() }
    @objc private func toggleHistory() { Option.keepHistory.toggle() }
    @objc private func toggleSound() { Option.sound.toggle() }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch {
            notice.show("Could not change the login setting")
        }
    }
    @objc private func openFolder() {
        try? FileManager.default.createDirectory(at: output.history, withIntermediateDirectories: true)
        NSWorkspace.shared.open(output.history)
    }

    private func later(_ seconds: Double, _ work: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    // MARK: capture

    /// Grabs the screen under the mouse off the main thread, then hands the picture back.
    private func grab(_ done: @escaping (Data, NSScreen) -> Void) {
        guard session == nil, !busy else { return }
        guard CGPreflightScreenCaptureAccess() else {
            notice.show("Allow Screen Recording for Snap5, then reopen it")
            fixScreenRecording()
            return
        }
        busy = true
        notice.hide()
        let screen = ScreenGrab.screenUnderMouse()
        DispatchQueue.global(qos: .userInteractive).async {
            let result = Result { try ScreenGrab.png(of: screen) }
            DispatchQueue.main.async {
                self.busy = false
                switch result {
                case .success(let png): done(png, screen)
                case .failure(let error): self.notice.show(error.localizedDescription)
                }
            }
        }
    }

    private func shutter() {
        if Option.sound.isOn { NSSound(named: "Tink")?.play() }
    }

    func copyWholeScreen() {
        grab { png, screen in
            guard ImageData.copy(png: png, to: self.output.pasteboard) else { return self.notice.show("Could not copy") }
            if Option.keepHistory.isOn {
                try? png.write(to: ImageData.freeURL(in: self.output.history, name: ImageData.timestampName()))
            }
            self.shutter()
            self.notice.show("✅ Whole screen copied. Paste with ⌘V", on: screen)
        }
    }

    func captureArea() {
        grab { [self] png, screen in
            let windows = ScreenGrab.windows(on: screen)
            let settings: [String: Any] = ["sound": false, "closeAfterCopy": true, "format": "png", "filename": "Snap5_{date}_{time}", "subfolder": ""]
            let session = CaptureSession(png: png, frame: screen.frame, windows: windows, settings: settings, preset: "area",
                                         output: self.output, keepHistory: Option.keepHistory.isOn, webFolder: self.webFolder)
            session.onReady = { [weak session] in
                guard let session else { return }
                session.window.makeKeyAndOrderFront(nil)
                session.window.orderFrontRegardless()
                session.window.makeFirstResponder(session.web)
            }
            session.onNotice = { [weak self] text in
                if text.contains("Copied") { self?.shutter() }
                self?.notice.show(text, on: screen)
            }
            session.onPin = { [weak self] data, rect in self?.pins.add(png: data, rect: rect) }
            // The app you were in never lost focus, so ⌘V works right away.
            session.onClose = { [weak self] in self?.session = nil }
            self.session = session
            // If the page never becomes ready, do not leave an invisible window around.
            self.later(8) { [weak self, weak session] in
                if let session, self?.session === session, !session.window.isVisible { session.close() }
            }
        }
    }
}

@main
enum Snap5App {
    static func main() {
        let app = NSApplication.shared
        let arguments = CommandLine.arguments
        if arguments.count >= 2, arguments[1] == "--selftest" {
            SelfTest.run(Array(arguments.dropFirst(2)))
            return
        }
        // Only one copy at a time, otherwise every shortcut would fire twice.
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty { return }
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
