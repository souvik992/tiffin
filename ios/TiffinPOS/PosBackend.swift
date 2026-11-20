import Foundation
import NodeMobile

/// Runs the POS backend (pos/main.cjs, ios/backend/main.ts bundled) with Node for iOS on its own thread inside the app.
/// iOS lets an app run no other programs, so Node is a library here (NodeMobile.xcframework, pinned in
/// ios/node-runtime.json). It can be started once per app launch; the backend restarts itself in place when it must
/// (restoring a backup, add-ons). The backend writes its gatekeeper's port to a file, as on Android.
final class PosBackend {
    static let shared = PosBackend()

    enum State { case starting, ready(port: Int, token: String), failed(String) }
    private(set) var state: State = .starting
    private var listeners: [(State) -> Void] = []
    private var started = false
    let token: String = {
        #if DEBUG
        // automated tests in the simulator (ios/scripts/simulator-test.ts) pass the pass in; never in a release build
        if let t = ProcessInfo.processInfo.environment["POS_TEST_TOKEN"], t.count >= 32 { return t }
        #endif
        return PosBackend.randomToken()
    }()

    let appSupport: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("TiffinPOS", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
    var dataDir: URL { appSupport.appendingPathComponent("pos-data", isDirectory: true) }
    var addonsDir: URL { appSupport.appendingPathComponent("pos-addons", isDirectory: true) }
    var logFile: URL { appSupport.appendingPathComponent("pos-backend.log") }
    private var portFile: URL { FileManager.default.temporaryDirectory.appendingPathComponent("pos-port") }

    /// Called on the main thread now and on every change.
    func observe(_ f: @escaping (State) -> Void) {
        listeners.append(f)
        f(state)
    }

    private func set(_ s: State) {
        DispatchQueue.main.async {
            self.state = s
            self.listeners.forEach { $0(s) }
        }
    }

    func start() {
        guard !started else { return }
        started = true
        guard let pos = Bundle.main.resourceURL?.appendingPathComponent("pos", isDirectory: true),
              FileManager.default.fileExists(atPath: pos.appendingPathComponent("main.cjs").path) else {
            set(.failed("The app is incomplete (no POS inside). Install it again."))
            return
        }
        for u in [dataDir, addonsDir] { try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true) }
        try? FileManager.default.removeItem(at: portFile)
        try? FileManager.default.removeItem(at: portFile.appendingPathExtension("error"))
        trimLog()

        let bridge = PrinterBridge.shared.start() // "port:token", or nil: printing through the app then reports itself unavailable
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        var env: [String: String] = [
            "HOME": appSupport.path,
            "TMPDIR": FileManager.default.temporaryDirectory.path,
            "POS_DATA_DIR": dataDir.path,
            "POS_UI_DIR": pos.appendingPathComponent("ui", isDirectory: true).path,
            "POS_APP_TOKEN": token,
            "POS_PORT_FILE": portFile.path,
            "POS_APP_VERSION": version,
            "POS_ADDONS_DIR": addonsDir.path,
        ]
        if let bridge { env["POS_ANDROID_BRIDGE"] = bridge } // same protocol as the Android app's printer service
        for (k, v) in env { setenv(k, v, 1) }

        let main = pos.appendingPathComponent("main.cjs").path
        let log = logFile.path
        let thread = Thread {
            // Node writes its log lines to stdout and stderr: keep them in a file for support (Settings shows nothing of it).
            freopen(log, "a", stdout)
            freopen(log, "a", stderr)
            setvbuf(stdout, nil, _IOLBF, 0)
            let code = PosBackend.runNode(["node", main])
            self.set(.failed("The POS stopped (code \(code)). Close Tiffin POS completely and open it again. Your bills are safe."))
        }
        thread.name = "pos-node"
        thread.stackSize = 16 * 1024 * 1024 // V8 without a JIT uses more stack than the default 512 KB of a thread
        thread.qualityOfService = .userInitiated
        thread.start()
        waitForPort()
    }

    /// node_start needs argv in one block of memory, one string after another (libuv reuses it), as nodejs-mobile says.
    private static func runNode(_ args: [String]) -> Int32 {
        let bytes = args.map { Array($0.utf8CString) }
        let total = bytes.reduce(0) { $0 + $1.count }
        let block = UnsafeMutablePointer<CChar>.allocate(capacity: total)
        var argv = [UnsafeMutablePointer<CChar>?]()
        var p = block
        for b in bytes {
            b.withUnsafeBufferPointer { src in p.update(from: src.baseAddress!, count: b.count) }
            argv.append(p)
            p += b.count
        }
        argv.append(nil)
        return argv.withUnsafeMutableBufferPointer { node_start(Int32(args.count), $0.baseAddress) }
    }

    private func waitForPort() {
        DispatchQueue.global(qos: .userInitiated).async {
            let deadline = Date().addingTimeInterval(300) // a first start on an old phone (or a busy simulator) runs the database setup without a JIT
            while Date() < deadline {
                if case .failed = self.state { return }
                if let err = try? String(contentsOf: self.portFile.appendingPathExtension("error"), encoding: .utf8) {
                    self.set(.failed("Tiffin POS could not start: \(err.replacingOccurrences(of: "FAILED ", with: ""))"))
                    return
                }
                if let s = try? String(contentsOf: self.portFile, encoding: .utf8), let port = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)), port > 0 {
                    self.set(.ready(port: port, token: self.token))
                    return
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            self.set(.failed("Tiffin POS is taking too long to start. Close it completely and open it again."))
        }
    }

    private func trimLog() {
        if let size = (try? FileManager.default.attributesOfItem(atPath: logFile.path)[.size]) as? NSNumber, size.intValue > 5_000_000 {
            try? FileManager.default.removeItem(at: logFile)
        }
    }

    static func randomToken() -> String {
        var b = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, b.count, &b)
        return Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
