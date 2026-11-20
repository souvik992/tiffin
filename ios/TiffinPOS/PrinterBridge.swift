import Foundation
import Network
import CoreBluetooth
import UIKit

/// The printer service of the iPhone/iPad app, for the POS backend (src/services/printing/android.ts): the same loopback
/// line protocol as the Android app's PrinterBridge.java, with a token passed in POS_ANDROID_BRIDGE ("port:token").
/// One JSON line per request ({ token, op, length, ... }), then `length` payload bytes; one JSON line back.
///  - list:   Bluetooth LE printers nearby (address ble:<id iOS gives the printer>). iOS lets apps use neither classic
///            Bluetooth printers (without Apple's MFi programme) nor USB printers; Wi-Fi printers go straight from the POS.
///  - print:  sends the ESC/POS bytes to that printer, in small pieces (slower when the printer has a small buffer).
///  - render: draws marked receipt lines (rupee sign, Hindi) with the iPhone's fonts, as 1-bit pictures for the printer.
final class PrinterBridge {
    static let shared = PrinterBridge()
    private let queue = DispatchQueue(label: "pos-printer-bridge")
    private var listener: NWListener?
    private let token = PosBackend.randomToken()
    private let ble = BlePrinters()

    /// Starts listening on a loopback port; "port:token" for the backend, or nil when it could not start.
    func start() -> String? {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        guard let l = try? NWListener(using: params) else { return nil }
        let ready = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { st in
            switch st { case .ready, .failed, .cancelled: ready.signal(); default: break }
        }
        l.newConnectionHandler = { [weak self] c in self?.serve(c) }
        l.start(queue: queue)
        _ = ready.wait(timeout: .now() + 3)
        guard let port = l.port?.rawValue, port > 0 else { l.cancel(); return nil }
        listener = l
        return "\(port):\(token)"
    }

    private func serve(_ c: NWConnection) {
        c.start(queue: DispatchQueue.global(qos: .userInitiated))
        var buf = Data()
        var head: [String: Any]?
        func reply(_ o: [String: Any]) {
            var d = (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{\"ok\":false}".utf8)
            d.append(0x0A)
            c.send(content: d, completion: .contentProcessed { _ in c.cancel() })
        }
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { data, _, done, err in
                if let data { buf.append(data) }
                if head == nil, let nl = buf.firstIndex(of: 0x0A) {
                    head = (try? JSONSerialization.jsonObject(with: buf[buf.startIndex..<nl])) as? [String: Any]
                    buf = Data(buf[buf.index(after: nl)...])
                    guard let h = head, let t = h["token"] as? String, Self.same(t, self.token) else { reply(["ok": false, "error": "Not allowed."]); return }
                }
                if let h = head {
                    let length = (h["length"] as? Int) ?? 0
                    if length > 8 * 1024 * 1024 { reply(["ok": false, "error": "Too much data."]); return }
                    if buf.count >= length {
                        self.handle(h, payload: buf.prefix(length), reply: reply)
                        return
                    }
                }
                if done || err != nil { c.cancel(); return }
                read()
            }
        }
        read()
    }

    private func handle(_ h: [String: Any], payload: Data, reply: @escaping ([String: Any]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            switch h["op"] as? String {
            case "list":
                do { reply(["ok": true, "printers": try self.ble.scan(seconds: 4)]) } catch { reply(["ok": false, "error": error.localizedDescription]) }
            case "print":
                guard let a = h["address"] as? String, a.hasPrefix("ble:"), let id = UUID(uuidString: String(a.dropFirst(4))) else {
                    reply(["ok": false, "error": "This printer can be used only on the device it was set up on."]); return
                }
                do { try self.ble.print(id, Data(payload), slow: (h["slow"] as? Bool) == true); reply(["ok": true]) } catch { reply(["ok": false, "error": error.localizedDescription]) }
            case "render":
                let specs = ((try? JSONSerialization.jsonObject(with: payload)) as? [[String: Any]]) ?? []
                reply(["ok": true, "lines": specs.map(TextPicture.render).joined(separator: "\n")])
            default:
                reply(["ok": false, "error": "Unknown request."])
            }
        }
    }

    private static func same(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var d: UInt8 = 0
        for i in 0..<x.count { d |= x[i] ^ y[i] }
        return d == 0
    }
}

struct PrinterError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// Bluetooth LE printers through Core Bluetooth. One job at a time; each job connects, finds the printer's writable
/// characteristic, sends the bytes in pieces and disconnects. Bluetooth permission is asked at the first use.
final class BlePrinters: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private let q = DispatchQueue(label: "pos-ble")
    private var central: CBCentralManager?
    private let job = NSLock()
    private var stateChanged = DispatchSemaphore(value: 0)
    private var seen: [UUID: (p: CBPeripheral, name: String, rssi: Int, printerish: Bool)] = [:]
    // the current print job
    private var target: CBPeripheral?
    private var connected = DispatchSemaphore(value: 0)
    private var discovered = DispatchSemaphore(value: 0)
    private var wrote = DispatchSemaphore(value: 0)
    private var canSend = DispatchSemaphore(value: 0)
    private var pendingServices = 0
    private var failure: String?
    private var writable: CBCharacteristic?
    private var cache: [UUID: (service: CBUUID, characteristic: CBUUID)] = [:]

    /// Services thermal printers commonly offer for ESC/POS data (tried first).
    private static let printerServices: Set<CBUUID> = ["18F0", "FF00", "FFE0", "FFF0", "AE30", "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "49535343-FE7D-4AE5-8FA9-9FAFD205E455"].map { CBUUID(string: $0) }.reduce(into: []) { $0.insert($1) }

    private func ready() throws -> CBCentralManager {
        if central == nil {
            stateChanged = DispatchSemaphore(value: 0)
            central = CBCentralManager(delegate: self, queue: q, options: [CBCentralManagerOptionShowPowerAlertKey: true])
            _ = stateChanged.wait(timeout: .now() + 10) // the first time, iOS asks the person to allow Bluetooth
        }
        guard let c = central else { throw PrinterError("Bluetooth is not available.") }
        for _ in 0..<50 where c.state == .unknown || c.state == .resetting { Thread.sleep(forTimeInterval: 0.1) }
        switch c.state {
        case .poweredOn: return c
        case .unauthorized: throw PrinterError("Allow Bluetooth for Tiffin POS: iOS Settings, Tiffin POS, Bluetooth.")
        case .poweredOff: throw PrinterError("Bluetooth is off. Turn it on in Control Centre or Settings.")
        case .unsupported: throw PrinterError("This device has no Bluetooth LE.")
        default: throw PrinterError("Bluetooth is not ready. Try again.")
        }
    }

    func scan(seconds: Double) throws -> [[String: Any]] {
        job.lock(); defer { job.unlock() }
        let c = try ready()
        q.sync { seen = [:] }
        for p in c.retrieveConnectedPeripherals(withServices: Array(Self.printerServices)) {
            q.sync { seen[p.identifier] = (p, p.name ?? "Printer", 0, true) }
        }
        c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        Thread.sleep(forTimeInterval: seconds)
        c.stopScan()
        let found = q.sync { Array(seen.values) }
        return found
            .sorted { ($0.printerish ? 1 : 0, $0.rssi) > ($1.printerish ? 1 : 0, $1.rssi) }
            .map { ["address": "ble:\($0.p.identifier.uuidString.uppercased())", "name": String($0.name.prefix(60)), "detail": $0.printerish ? "Bluetooth LE printer" : "Bluetooth LE device", "builtin": false] }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) { stateChanged.signal() }

    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData ad: [String: Any], rssi: NSNumber) {
        let name = (ad[CBAdvertisementDataLocalNameKey] as? String) ?? p.name
        guard let name, !name.isEmpty else { return } // unnamed devices are not printers people can recognise
        let services = (ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        let printerish = services.contains { Self.printerServices.contains($0) } || name.range(of: "print|pos|pt-|mtp|rpp|tm-|xp-|thermal|receipt|inner|58|80", options: [.regularExpression, .caseInsensitive]) != nil
        seen[p.identifier] = (p, name, rssi.intValue, printerish)
    }

    func print(_ id: UUID, _ bytes: Data, slow: Bool) throws {
        job.lock(); defer { job.unlock() }
        let c = try ready()
        guard let p = c.retrievePeripherals(withIdentifiers: [id]).first else { throw PrinterError("Printer not found. Switch it on, keep it near this device and set it up again in Printer setup.") }
        failure = nil; writable = nil; target = p
        connected = DispatchSemaphore(value: 0); discovered = DispatchSemaphore(value: 0)
        p.delegate = self
        defer { c.cancelPeripheralConnection(p); target = nil }
        c.connect(p, options: nil)
        if connected.wait(timeout: .now() + 12) == .timedOut { throw PrinterError("The printer did not connect. Is it switched on and near this device? Is another phone connected to it?") }
        if let f = failure { throw PrinterError(f) }
        if let known = cache[id] {
            q.sync { pendingServices = 1 }
            p.discoverServices([known.service])
        } else {
            p.discoverServices(nil)
        }
        if discovered.wait(timeout: .now() + 10) == .timedOut || writable == nil {
            cache[id] = nil
            throw PrinterError("This Bluetooth device does not accept printing. Choose the printer itself in Printer setup.")
        }
        let ch = writable!
        if let s = ch.service?.uuid { cache[id] = (s, ch.uuid) }
        let withResponse = !ch.properties.contains(.writeWithoutResponse)
        let type: CBCharacteristicWriteType = withResponse ? .withResponse : .withoutResponse
        let piece = max(20, min(slow ? 20 : 180, p.maximumWriteValueLength(for: type)))
        let pause = slow ? 0.03 : 0.006 // printers have small buffers: pace the data
        var at = 0
        while at < bytes.count {
            let end = min(bytes.count, at + piece)
            let chunk = bytes.subdata(in: at..<end)
            if withResponse {
                wrote = DispatchSemaphore(value: 0)
                p.writeValue(chunk, for: ch, type: .withResponse)
                if wrote.wait(timeout: .now() + 10) == .timedOut { throw PrinterError("The printer stopped answering while printing. Check it and print again.") }
                if let f = failure { throw PrinterError(f) }
            } else {
                var waited = 0
                while !p.canSendWriteWithoutResponse && waited < 100 {
                    canSend = DispatchSemaphore(value: 0)
                    _ = canSend.wait(timeout: .now() + 0.05)
                    waited += 1
                }
                if p.state != .connected { throw PrinterError("The printer disconnected while printing. Print again.") }
                p.writeValue(chunk, for: ch, type: .withoutResponse)
                Thread.sleep(forTimeInterval: pause)
            }
            at = end
        }
        Thread.sleep(forTimeInterval: 0.4) // let the last piece reach the printer before disconnecting
    }

    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) { connected.signal() }

    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        failure = "The printer did not connect: \(error?.localizedDescription ?? "unknown reason")."
        connected.signal()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        if p == target, error != nil { failure = "The printer disconnected. Print again."; wrote.signal() }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        let services = p.services ?? []
        if services.isEmpty { discovered.signal(); return }
        // known printer services first, so their characteristic wins
        let ordered = services.sorted { (Self.printerServices.contains($0.uuid) ? 0 : 1) < (Self.printerServices.contains($1.uuid) ? 0 : 1) }
        pendingServices = ordered.count
        for s in ordered { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] where ch.properties.contains(.writeWithoutResponse) || ch.properties.contains(.write) {
            let better = writable == nil || (Self.printerServices.contains(s.uuid) && !(writable.flatMap { $0.service.map { Self.printerServices.contains($0.uuid) } } ?? false))
            if better { writable = ch }
        }
        pendingServices -= 1
        if pendingServices <= 0 { discovered.signal() }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        if let error { failure = "The printer refused the data: \(error.localizedDescription)" }
        wrote.signal()
    }

    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) { canSend.signal() }
}

/// Draws one marked receipt line (textPicture.ts PictureSpec) like the Windows and Android renderers: font A cells are
/// 12 x 24 dots, a line at size w x h is (c x 12w) dots wide and 24h high. "<widthBytes> <height> <base64>" or "-".
enum TextPicture {
    static func render(_ spec: [String: Any]) -> String {
        let w = max(1, min(8, spec["w"] as? Int ?? 1)), h = max(1, min(8, spec["h"] as? Int ?? 1))
        let cols = max(1, min(96, spec["c"] as? Int ?? 32)), bold = spec["b"] as? Bool ?? false
        let segs = spec["s"] as? [[String: Any]] ?? []
        let cellW = 12 * w, height = 24 * h
        let width = Int((Double(cols * cellW) / 8).rounded(.up)) * 8
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return "-" }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(ctx)
        let font = UIFont.systemFont(ofSize: CGFloat(17 * h), weight: bold ? .bold : .regular)
        for seg in segs {
            let text = seg["t"] as? String ?? ""
            let col = seg["col"] as? Int ?? 0, span = seg["width"] as? Int ?? cols
            let para = NSMutableParagraphStyle()
            para.alignment = (seg["align"] as? String) == "c" ? .center : (seg["align"] as? String) == "r" ? .right : .left
            para.lineBreakMode = .byClipping
            let s = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor.black, .paragraphStyle: para])
            let textHeight = s.boundingRect(with: CGSize(width: CGFloat(span * cellW), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil).height
            s.draw(in: CGRect(x: CGFloat(col * cellW), y: (CGFloat(height) - textHeight) / 2, width: CGFloat(span * cellW), height: textHeight))
        }
        UIGraphicsPopContext()
        guard let px = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return "-" }
        let wb = width / 8
        var out = [UInt8](repeating: 0, count: wb * height)
        for y in 0..<height {
            for x in 0..<width where px[y * width + x] < 128 { out[y * wb + x / 8] |= UInt8(0x80 >> (x % 8)) }
        }
        return "\(wb) \(height) \(Data(out).base64EncodedString())"
    }
}
