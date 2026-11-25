import AppKit
import WebKit
import UniformTypeIdentifiers

/// Where results go. The self-test swaps these for a private clipboard and a temp folder.
struct Output {
    var pasteboard = NSPasteboard.general
    var downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var history = FileManager.default.urls(for: .picturesDirectory, in: .userDomainMask)[0].appendingPathComponent("Snap5")
}

enum ImageData {
    static func decode(_ dataUrl: String) -> Data? {
        guard let comma = dataUrl.firstIndex(of: ",") else { return nil }
        return Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...]))
    }

    static func dataUrl(png: Data) -> String { "data:image/png;base64," + png.base64EncodedString() }

    static func copy(png: Data, to pasteboard: NSPasteboard) -> Bool {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setData(png, forType: .png)
        // Some older apps only accept TIFF.
        if let tiff = NSBitmapImageRep(data: png)?.tiffRepresentation { item.setData(tiff, forType: .tiff) }
        return pasteboard.writeObjects([item])
    }

    /// A name that never overwrites an existing file. `name` may contain sub-folders.
    static func freeURL(in folder: URL, name: String) throws -> URL {
        let parts = name.split(separator: "/").map(String.init).filter { $0 != ".." && $0 != "." }
        var url = folder
        for part in parts { url.appendPathComponent(part) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        var candidate = url
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = url.deletingLastPathComponent().appendingPathComponent("\(base) (\(n)).\(ext)")
            n += 1
        }
        return candidate
    }

    static func timestampName() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return "Snap5_\(f.string(from: Date())).png"
    }
}

enum ScreenGrab {
    static func displayID(_ screen: NSScreen) -> CGDirectDisplayID {
        screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! CGDirectDisplayID
    }

    static func screenUnderMouse() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.screens[0]
    }

    /// Takes the picture with Apple's own screenshot tool, then removes the temporary file.
    static func png(of screen: NSScreen) throws -> Data {
        let bounds = CGDisplayBounds(displayID(screen))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("snap5-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-x", "-t", "png", "-R", "\(Int(bounds.origin.x)),\(Int(bounds.origin.y)),\(Int(bounds.width)),\(Int(bounds.height))", file.path]
        try task.run()
        task.waitUntilExit()
        guard task.terminationStatus == 0, let data = try? Data(contentsOf: file), !data.isEmpty else {
            throw NSError(domain: "Snap5", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS did not return a picture. Check the Screen Recording permission."])
        }
        return data
    }

    /// Visible windows on this screen, front-most first, in the overlay's coordinates.
    static func windows(on screen: NSScreen) -> [[String: Double]] {
        let display = CGDisplayBounds(displayID(screen))
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let mine = Int(ProcessInfo.processInfo.processIdentifier)
        return list.compactMap { info in
            guard (info[kCGWindowLayer as String] as? Int) == 0, (info[kCGWindowOwnerPID as String] as? Int) != mine,
                  (info[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  let raw = info[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: raw) else { return nil }
            let visible = rect.intersection(display)
            guard !visible.isNull, visible.width >= 60, visible.height >= 40 else { return nil }
            return ["x": Double(visible.minX - display.minX), "y": Double(visible.minY - display.minY), "w": Double(visible.width), "h": Double(visible.height)]
        }
    }
}

final class OverlayWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    // Allows covering the menu bar.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class OverlayWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The frozen-screen selection and markup window.
final class CaptureSession: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    let window: OverlayWindow
    let web: OverlayWebView
    private let png: Data
    private let windowRects: [[String: Double]]
    private let settings: [String: Any]
    private let preset: String
    private let output: Output
    private let keepHistory: Bool

    var onClose: () -> Void = {}
    var onReady: () -> Void = {}
    var onNotice: (String) -> Void = { _ in }
    var onPin: (Data, NSRect?) -> Void = { _, _ in }
    var onLog: (String) -> Void = { NSLog("Snap5 page: %@", $0) }
    var allowSavePanel = true
    private var closed = false

    init(png: Data, frame: NSRect, windows: [[String: Double]], settings: [String: Any], preset: String, output: Output, keepHistory: Bool, webFolder: URL) {
        self.png = png
        self.windowRects = windows
        self.settings = settings
        self.preset = preset
        self.output = output
        self.keepHistory = keepHistory
        // Like Spotlight: takes the keyboard without pulling focus away from the app you are in.
        window = OverlayWindow(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        web = OverlayWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        super.init()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "snap5")
        web.navigationDelegate = self
        window.level = .screenSaver
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        window.acceptsMouseMovedEvents = true
        window.contentView = web
        web.loadFileURL(webFolder.appendingPathComponent("capture.html"), allowingReadAccessTo: webFolder)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let payload: [String: Any] = ["dataUrl": ImageData.dataUrl(png: png), "windows": windowRects, "settings": settings, "preset": preset]
        web.callAsyncJavaScript("await window.snap5Start(payload)", arguments: ["payload": payload], in: nil, in: .page) { [weak self] result in
            if case .failure(let error) = result {
                self?.onLog("start failed: \(error)")
                self?.close()
            }
        }
    }

    func close() {
        if closed { return }
        closed = true
        web.configuration.userContentController.removeScriptMessageHandler(forName: "snap5", contentWorld: .page)
        window.orderOut(nil)
        window.close()
        onClose()
    }

    private func saveHistory(_ data: Data) {
        guard keepHistory else { return }
        do {
            try data.write(to: ImageData.freeURL(in: output.history, name: ImageData.timestampName()))
        } catch {
            onLog("history: \(error.localizedDescription)")
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return replyHandler(nil, "bad message") }
        let image = (body["dataUrl"] as? String).flatMap(ImageData.decode)
        var reply: [String: Any] = ["ok": true]
        switch type {
        case "ready":
            onReady()
        case "copy":
            reply["ok"] = image.map { ImageData.copy(png: $0, to: output.pasteboard) } ?? false
        case "copy-text":
            output.pasteboard.clearContents()
            output.pasteboard.setString(body["text"] as? String ?? "", forType: .string)
        case "history-add":
            if let image { saveHistory(image) }
        case "download":
            guard let image else { return replyHandler(["ok": false, "error": "No picture"], nil) }
            let name = body["filename"] as? String ?? ImageData.timestampName()
            if (body["saveAs"] as? Bool ?? false) && allowSavePanel {
                saveAs(image, name: name)
            } else {
                do {
                    try image.write(to: ImageData.freeURL(in: output.downloads, name: name))
                } catch {
                    reply = ["ok": false, "error": "Could not save: \(error.localizedDescription)"]
                }
            }
        case "pin":
            if let image {
                var rect: NSRect?
                if let r = body["rect"] as? [String: Double] {
                    rect = NSRect(x: window.frame.minX + (r["x"] ?? 0), y: window.frame.maxY - (r["y"] ?? 0) - (r["h"] ?? 0), width: r["w"] ?? 300, height: r["h"] ?? 200)
                }
                onPin(image, rect)
            }
        case "capture":
            // "F" in the overlay: the whole screen, exactly as frozen.
            _ = ImageData.copy(png: png, to: output.pasteboard)
            saveHistory(png)
            onNotice("✅ Whole screen copied")
        case "notice":
            onNotice(body["title"] as? String ?? "")
        case "closed":
            replyHandler(reply, nil)
            DispatchQueue.main.async { self.close() }
            return
        case "log":
            onLog(body["text"] as? String ?? "")
        default:
            reply = ["ok": false, "error": "Not available in the Mac app"]
        }
        replyHandler(reply, nil)
    }

    /// The overlay is above every normal window, so it steps aside for the save dialog.
    private func saveAs(_ data: Data, name: String) {
        DispatchQueue.main.async {
            self.window.orderOut(nil)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (name as NSString).lastPathComponent
            panel.directoryURL = self.output.downloads
            NSApp.activate()
            if panel.runModal() == .OK, let url = panel.url {
                do { try data.write(to: url) } catch { self.onNotice("Could not save: \(error.localizedDescription)") }
            }
        }
    }
}
