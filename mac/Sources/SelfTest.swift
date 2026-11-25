import AppKit
import WebKit

/// `Snap5 --selftest <folder>`: runs the real capture window on a drawn test picture.
/// Needs no privacy permission and never touches the user's clipboard or folders.
enum SelfTest {
    static var failures = 0

    static func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        print("\(ok ? "PASS" : "FAIL") \(name)\(detail.isEmpty ? "" : "  \(detail)")")
        if !ok { failures += 1 }
    }

    /// Processes events the way a running app does, so windows really appear on screen.
    static func spin(_ seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            if let event = NSApp.nextEvent(matching: .any, until: min(end, Date().addingTimeInterval(0.01)), inMode: .default, dequeue: true) {
                // The test posts its own input straight to the window. Anything from the real mouse or
                // keyboard is dropped, so using the Mac during a test cannot change the result.
                if !isUserInput(event.type) { NSApp.sendEvent(event) }
            }
        } while Date() < end
    }

    static func isUserInput(_ type: NSEvent.EventType) -> Bool {
        [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged, .mouseMoved,
         .mouseEntered, .mouseExited, .cursorUpdate, .scrollWheel, .keyDown, .keyUp, .flagsChanged].contains(type)
    }

    static func wait(_ seconds: Double = 8, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            spin(0.05)
        }
        return condition()
    }

    static func keyTests() {
        func run(_ events: [(Double, Bool)]) -> [KeySequence.Result] {
            var s = KeySequence()
            return events.compactMap { time, isFive in
                if isFive { return s.triggerKey(at: time) }
                s.otherKey(at: time)
                return nil
            }
        }
        check("keys: 5 5 waits for a third", run([(10, true), (10.2, true)]) == [.none, .waitForThird])
        check("keys: 5 5 5 is a triple", run([(10, true), (10.2, true), (10.4, true)]) == [.none, .waitForThird, .triple])
        check("keys: slow presses do nothing", run([(10, true), (10.6, true), (11.2, true)]) == [.none, .none, .none])
        check("keys: another key breaks the sequence", run([(10, true), (10.1, false), (10.2, true)]) == [.none, .none])
        check("keys: 55 typed inside a word or number is ignored", run([(10, false), (10.2, true), (10.35, true)]) == [.none, .none])
        check("keys: 5 5 works again after a pause", run([(10, false), (11, true), (11.2, true)]) == [.none, .waitForThird])
    }

    static func testPicture(width: Int, height: Int) -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(red: 0.93, green: 0.94, blue: 0.99, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        // A pretend app window at points x=60 y=50, 520×360 (the picture has 2 pixels per point).
        NSColor.white.setFill()
        NSRect(x: 120, y: height - 100 - 720, width: 1040, height: 720).fill()
        let text: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 56), .foregroundColor: NSColor.black]
        "Test chat window".draw(at: NSPoint(x: 180, y: height - 230), withAttributes: text)
        "This is a message to capture.".draw(at: NSPoint(x: 180, y: height - 360), withAttributes: [.font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.darkGray])
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])!
    }

    static func run(_ arguments: [String]) {
        let folder = URL(fileURLWithPath: arguments.first ?? NSTemporaryDirectory() + "snap5-selftest")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        keyTests()

        let webFolder = Bundle.main.resourceURL!.appendingPathComponent("web")
        var output = Output()
        output.pasteboard = NSPasteboard(name: NSPasteboard.Name("com.snap5.selftest"))
        output.downloads = folder.appendingPathComponent("downloads-\(UUID().uuidString.prefix(6))")
        output.history = folder.appendingPathComponent("history-\(UUID().uuidString.prefix(6))")

        let screen = NSScreen.screens[0]
        let size = NSSize(width: 1000, height: 640)
        let frame = NSRect(x: screen.frame.minX, y: screen.frame.maxY - size.height, width: size.width, height: size.height)
        let png = testPicture(width: 2000, height: 1280)
        try? png.write(to: folder.appendingPathComponent("input.png"))
        let rects: [[String: Double]] = [["x": 60, "y": 50, "w": 520, "h": 360]]

        var notices: [String] = []
        var pinned: (Data, NSRect?)?
        var pageProblems: [String] = []
        var ready = false
        var closed = false

        func open() -> CaptureSession {
            ready = false
            closed = false
            output.pasteboard.clearContents()
            let settings: [String: Any] = ["sound": false, "closeAfterCopy": true, "format": "png", "filename": "Snap5_{date}_{time}", "subfolder": ""]
            let session = CaptureSession(png: png, frame: frame, windows: rects, settings: settings, preset: "area",
                                         output: output, keepHistory: true, webFolder: webFolder)
            session.allowSavePanel = false
            session.window.ignoresMouseEvents = true // the real pointer passes through
            session.onReady = {
                ready = true
                session.web.trackingAreas.forEach { session.web.removeTrackingArea($0) }
                session.window.alphaValue = 0.02 // nearly invisible during the test
                session.window.makeKeyAndOrderFront(nil)
                session.window.orderFrontRegardless()
                session.window.makeFirstResponder(session.web)
            }
            session.onClose = { closed = true }
            session.onNotice = { notices.append($0) }
            session.onPin = { pinned = ($0, $1) }
            session.onLog = { pageProblems.append($0) }
            return session
        }

        func js(_ session: CaptureSession, _ source: String) -> Any? {
            var done = false
            var value: Any?
            session.web.evaluateJavaScript(source) { result, error in
                value = result
                if let error { pageProblems.append(error.localizedDescription) }
                done = true
            }
            _ = wait(5) { done }
            return value
        }
        func shadow(_ session: CaptureSession, _ expression: String) -> String {
            (js(session, "String((r => \(expression))(document.querySelector('snap5-root')?.shadowRoot))") as? String) ?? ""
        }
        func mouse(_ session: CaptureSession, _ type: NSEvent.EventType, _ x: Double, _ y: Double) {
            // WebKit follows the real pointer through tracking areas; switch that off for the test.
            session.web.trackingAreas.forEach { session.web.removeTrackingArea($0) }
            let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: size.height - y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: session.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            session.window.sendEvent(event)
            spin(0.04)
        }
        func drag(_ session: CaptureSession, _ a: (Double, Double), _ b: (Double, Double)) {
            mouse(session, .leftMouseDown, a.0, a.1)
            for step in 1...6 {
                let t = Double(step) / 6
                mouse(session, .leftMouseDragged, a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
            }
            mouse(session, .leftMouseUp, b.0, b.1)
            spin(0.15)
        }
        func key(_ session: CaptureSession, _ code: String, _ name: String, command: Bool = false) {
            _ = js(session, "window.dispatchEvent(new KeyboardEvent('keydown', {code:'\(code)', key:'\(name)', metaKey:\(command), bubbles:true, cancelable:true})); 1")
            spin(0.1)
        }
        func clipboard() -> NSBitmapImageRep? { output.pasteboard.data(forType: .png).flatMap { NSBitmapImageRep(data: $0) } }
        func files(_ url: URL) -> [String] { (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? [] }
        func snapshot(_ session: CaptureSession, _ name: String) {
            var done = false
            session.web.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation, let data = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    try? data.write(to: folder.appendingPathComponent("\(name).png"))
                }
                done = true
            }
            _ = wait(5) { done }
        }

        // 1. Click a window, mark it up, press Return.
        var session = open()
        check("capture window opens with the overlay", wait { ready }, pageProblems.joined(separator: " | "))
        spin(0.4)
        check("browser-only buttons are hidden", shadow(session, "getComputedStyle(r.querySelector('[data-action=editor]')).display + getComputedStyle(r.querySelector('[data-action=full]')).display") == "nonenone")
        check("hint says Whole screen", shadow(session, "[...r.querySelectorAll('.hint button')].map(b => b.textContent).join()").contains("Whole screen (F)"))
        mouse(session, .mouseMoved, 300, 200)
        mouse(session, .leftMouseDown, 300, 200)
        mouse(session, .leftMouseUp, 300, 200)
        spin(0.3)
        let picked = shadow(session, "r.querySelector('.dims').textContent")
        check("one click selects the whole window", picked == "1040 × 720", picked)
        key(session, "KeyR", "r")
        drag(session, (85, 90), (420, 140))
        key(session, "KeyA", "a")
        drag(session, (460, 300), (330, 215))
        snapshot(session, "mac-overlay")
        key(session, "Enter", "Enter")
        check("Return copies and closes", wait { closed }, pageProblems.joined(separator: " | "))
        let copied = clipboard()
        check("clipboard holds the selected window", copied?.pixelsWide == 1040 && copied?.pixelsHigh == 720, "\(copied?.pixelsWide ?? 0)x\(copied?.pixelsHigh ?? 0)")
        if let data = output.pasteboard.data(forType: .png) { try? data.write(to: folder.appendingPathComponent("copied.png")) }
        let red = copied.map { rep in
            (0..<rep.pixelsWide).contains { x in
                guard let c = rep.colorAt(x: x, y: 80)?.usingColorSpace(.deviceRGB) else { return false }
                return c.redComponent > 0.8 && c.greenComponent < 0.45 && c.blueComponent < 0.45
            }
        } ?? false
        check("the drawn box is in the copied picture", red)
        check("older apps can paste it too (TIFF)", output.pasteboard.data(forType: .tiff) != nil)
        check("a copy is kept in history", wait(3) { files(output.history).count == 1 }, "\(files(output.history))")
        check("copied notice shown", notices.contains { $0.contains("Copied") }, "\(notices)")

        // 2. Drag an area, download it.
        session = open()
        _ = wait { ready }
        spin(0.4)
        drag(session, (100, 100), (400, 300))
        let dims = shadow(session, "r.querySelector('.dims').textContent")
        check("dragging selects an area at full resolution", dims == "600 × 400", dims)
        key(session, "KeyS", "s", command: true)
        check("⌘S saves to Downloads and closes", wait { closed } && files(output.downloads).count == 1, "\(files(output.downloads))")
        if let name = files(output.downloads).first, let rep = NSBitmapImageRep(data: (try? Data(contentsOf: output.downloads.appendingPathComponent(name))) ?? Data()) {
            check("saved file is a 600×400 PNG", rep.pixelsWide == 600 && rep.pixelsHigh == 400, name)
        } else {
            check("saved file is a 600×400 PNG", false)
        }

        // 3. Pin.
        session = open()
        _ = wait { ready }
        spin(0.4)
        drag(session, (100, 100), (400, 300))
        key(session, "KeyP", "p", command: true)
        check("⌘P pins at the same place", wait { closed && pinned != nil } && pinned?.1?.width == 300 && pinned?.1?.height == 200, "\(String(describing: pinned?.1))")
        if let pinned {
            let pins = Pins()
            pins.add(png: pinned.0, rect: pinned.1)
            spin(0.2)
            pins.setHidden(true)
        }

        // Real keyboard events through AppKit, the way a person types. The app is not activated.
        func press(_ session: CaptureSession, _ text: String, code: UInt16, flags: NSEvent.ModifierFlags = []) {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                             windowNumber: session.window.windowNumber, context: nil, characters: text,
                                             charactersIgnoringModifiers: text, isARepeat: false, keyCode: code)!
                session.window.sendEvent(event)
                spin(0.05)
            }
        }
        session = open()
        _ = wait { ready }
        spin(0.4)
        check("overlay takes the keyboard without activating the app", session.window.isKeyWindow, "key=\(session.window.isKeyWindow) active=\(NSApp.isActive)")
        drag(session, (100, 100), (500, 340))
        press(session, "t", code: 17)
        let tool = shadow(session, "r.querySelector('[data-tool].on')?.dataset.tool")
        check("a real key press selects the text tool", tool == "text", tool)
        mouse(session, .leftMouseDown, 150, 180)
        mouse(session, .leftMouseUp, 150, 180)
        spin(0.4)
        for (character, code) in [("h", UInt16(4)), ("e", 14), ("y", 16), (" ", 49), ("5", 23), ("5", 23)] { press(session, character, code: code) }
        let typed = shadow(session, "r.querySelector('textarea')?.value")
        check("real typing goes into the text box", typed == "hey 55", typed)
        snapshot(session, "mac-text")
        press(session, "\r", code: 36)
        spin(0.3)
        check("Return finishes the text and keeps the overlay open", shadow(session, "!!r.querySelector('.ov') && !r.querySelector('textarea')") == "true" && !closed)
        press(session, "\r", code: 36)
        check("a second real Return copies and closes", wait { closed } && clipboard()?.pixelsWide == 800, "\(clipboard()?.pixelsWide ?? 0)")
        if let data = output.pasteboard.data(forType: .png) { try? data.write(to: folder.appendingPathComponent("copied-text.png")) }

        // 4. Whole screen with F, then Escape.
        session = open()
        _ = wait { ready }
        spin(0.4)
        key(session, "KeyF", "f")
        check("F copies the whole screen", wait { closed } && clipboard()?.pixelsWide == 2000, "\(clipboard()?.pixelsWide ?? 0)")
        session = open()
        _ = wait { ready }
        spin(0.4)
        key(session, "Escape", "Escape")
        check("Escape closes and copies nothing", wait { closed } && clipboard() == nil)

        print("info: \(ScreenGrab.windows(on: screen).count) windows visible on the main screen")
        check("no errors from the page", pageProblems.isEmpty, pageProblems.joined(separator: " | "))
        output.pasteboard.releaseGlobally()
        print("FAILS: \(failures)")
        exit(failures == 0 ? 0 : 1)
    }
}
