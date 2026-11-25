import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Watches for the "5" key in every app. It only compares key codes; nothing typed is stored.
final class KeyMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var sequence = KeySequence()
    private var pending: DispatchWorkItem?

    var onDouble: () -> Void = {}
    var onTriple: () -> Void = {}
    /// Return false to stay out of the way (feature off, Chrome in front, overlay open).
    var shouldListen: () -> Bool = { true }
    var ignoreWhileTyping: () -> Bool = { true }

    private static let triggerCodes: Set<Int64> = [Int64(kVK_ANSI_5), Int64(kVK_ANSI_Keypad5)]

    var isRunning: Bool { tap != nil }

    /// Needs the Input Monitoring permission. Returns false until the user has granted it.
    @discardableResult
    func start() -> Bool {
        if tap != nil { return true }
        guard CGPreflightListenEventAccess() else { return false }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, info in
            let monitor = Unmanaged<KeyMonitor>.fromOpaque(info!).takeUnretainedValue()
            monitor.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
                                           eventsOfInterest: mask, callback: callback,
                                           userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        tap = port
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    private func cancelPending() {
        pending?.cancel()
        pending = nil
    }

    private func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let now = ProcessInfo.processInfo.systemUptime
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let modified = !event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
        guard KeyMonitor.triggerCodes.contains(code), !modified else {
            cancelPending()
            sequence.otherKey(at: now)
            return
        }
        if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
        guard shouldListen(), !(ignoreWhileTyping() && Focus.isTextInput()) else {
            cancelPending()
            sequence.reset()
            return
        }
        cancelPending()
        switch sequence.triggerKey(at: now) {
        case .none:
            break
        case .waitForThird:
            let work = DispatchWorkItem { [weak self] in
                self?.sequence.reset()
                self?.onDouble()
            }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + sequence.interval, execute: work)
        case .triple:
            onTriple()
        }
    }
}

/// Is the cursor in a text box? Uses the Accessibility permission when it has been granted.
enum Focus {
    private static func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var result: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success ? result : nil
    }

    /// Chromium and Electron apps (such as Claude) only describe their text boxes after being asked.
    static func prepare(_ app: NSRunningApplication) {
        guard AXIsProcessTrusted() else { return }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    static func isTextInput() -> Bool {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return false }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(appElement, 0.15)
        guard let focused = value(appElement, kAXFocusedUIElementAttribute as String) else { return false }
        let element = focused as! AXUIElement
        let role = value(element, kAXRoleAttribute as String) as? String ?? ""
        if ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) { return true }
        var settable: DarwinBoolean = false
        let hasCaret = value(element, kAXSelectedTextRangeAttribute as String) != nil
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        return hasCaret && settable.boolValue
    }
}

/// System-wide shortcuts. These work without any privacy permission.
final class HotKeys {
    private var actions: [UInt32: () -> Void] = [:]
    private var installed = false
    private(set) var failed: [String] = []

    func register(_ name: String, key: Int, action: @escaping () -> Void) {
        installHandler()
        let id = UInt32(actions.count + 1)
        actions[id] = action
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(UInt32(key), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x534E_5035), id: id),
                                         GetApplicationEventTarget(), 0, &ref)
        if status != noErr { failed.append(name) }
    }

    private func installHandler() {
        if installed { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, info in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &id)
            Unmanaged<HotKeys>.fromOpaque(info!).takeUnretainedValue().actions[id.id]?()
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
    }
}
