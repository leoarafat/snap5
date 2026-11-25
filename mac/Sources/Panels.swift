import AppKit

/// A short message near the bottom of the screen that never takes focus.
final class Notice {
    private var panel: NSPanel?
    private var timer: Timer?

    func show(_ text: String, on screen: NSScreen = ScreenGrab.screenUnderMouse()) {
        hide()
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        label.textColor = .white
        label.sizeToFit()
        let size = NSSize(width: label.frame.width + 36, height: 42)
        let panel = NSPanel(contentRect: NSRect(x: screen.frame.midX - size.width / 2, y: screen.visibleFrame.minY + 80, width: size.width, height: size.height),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = .screenSaver
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let box = NSView(frame: NSRect(origin: .zero, size: size))
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.93).cgColor
        box.layer?.cornerRadius = 12
        label.setFrameOrigin(NSPoint(x: 18, y: (size.height - label.frame.height) / 2))
        box.addSubview(label)
        panel.contentView = box
        panel.orderFrontRegardless()
        self.panel = panel
        timer = Timer.scheduledTimer(withTimeInterval: 2.2, repeats: false) { [weak self] _ in self?.hide() }
    }

    func hide() {
        timer?.invalidate()
        panel?.orderOut(nil)
        panel = nil
    }
}

private final class PinView: NSImageView {
    var png = Data()
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.close() } else { window?.performDrag(with: event) }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: "Copy", action: #selector(copyImage), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Close pin", action: #selector(closePin), keyEquivalent: "").target = self
        return menu
    }

    @objc private func copyImage() { _ = ImageData.copy(png: png, to: .general) }
    @objc private func closePin() { window?.close() }
}

/// Screenshots that float above other apps. Drag to move, resize from a corner, double-click to close.
final class Pins: NSObject, NSWindowDelegate {
    private var panels: [NSPanel] = []

    func add(png: Data, rect: NSRect?) {
        guard let image = NSImage(data: png) else { return }
        let screen = ScreenGrab.screenUnderMouse().visibleFrame
        var frame = rect ?? NSRect(x: screen.midX - 200, y: screen.midY - 150, width: 400, height: 300)
        frame.size.width = max(frame.width, 80)
        frame.size.height = max(frame.height, 60)
        let panel = NSPanel(contentRect: frame, styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentAspectRatio = frame.size
        panel.delegate = self
        let view = PinView(frame: NSRect(origin: .zero, size: frame.size))
        view.png = png
        view.image = image
        view.imageScaling = .scaleProportionallyUpOrDown
        view.toolTip = "Drag to move · double-click to close · right-click to copy"
        panel.contentView = view
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
        panels.append(panel)
    }

    func windowWillClose(_ notification: Notification) {
        panels.removeAll { $0 === notification.object as? NSPanel }
    }

    func setHidden(_ hidden: Bool) {
        panels.forEach { hidden ? $0.orderOut(nil) : $0.orderFrontRegardless() }
    }
}
