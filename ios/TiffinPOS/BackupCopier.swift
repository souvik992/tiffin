import Foundation

/// Copies the POS backups (pos-data/backups) into a folder the owner chose in Files: iCloud Drive, or a USB drive or SD
/// card plugged into the iPhone or iPad (the app keeps access to it with a bookmark). Copies new or changed files only,
/// every 15 minutes while the app is open and when "Copy now" is pressed, into <folder>/TiffinPOS-backups. The backups
/// themselves are made and checked by the POS (hourly and daily) as on Windows and Android. Same as BackupCopier.java.
final class BackupCopier {
    static let shared = BackupCopier()
    private let defaults = UserDefaults.standard
    private let lock = NSLock()
    private var timer: Timer?
    /// Called on the main thread when the status changed (the screen shows it).
    var onChange: (() -> Void)?

    private var source: URL { PosBackend.shared.dataDir.appendingPathComponent("backups", isDirectory: true) }

    func setFolder(_ url: URL) -> Bool {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else { return false }
        defaults.set(bookmark, forKey: "backup.folder")
        defaults.set(url.lastPathComponent, forKey: "backup.name")
        defaults.removeObject(forKey: "backup.lastError")
        return true
    }

    func clearFolder() {
        for k in ["backup.folder", "backup.name", "backup.last", "backup.lastError"] { defaults.removeObject(forKey: k) }
        changed()
    }

    func statusJSON() -> String {
        let o: [String: Any] = [
            "folder": defaults.string(forKey: "backup.name") ?? NSNull(),
            "lastCopiedAt": Int(defaults.double(forKey: "backup.last")),
            "lastError": defaults.string(forKey: "backup.lastError") ?? "",
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }

    func startTimer() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { _ in
            DispatchQueue.global(qos: .utility).async { _ = BackupCopier.shared.copyNow() }
        }
        DispatchQueue.global(qos: .utility).async { _ = self.copyNow() }
    }

    func stopTimer() { timer?.invalidate(); timer = nil }

    /// How many files were copied, or -1 when it failed.
    func copyNow() -> Int {
        lock.lock(); defer { lock.unlock() }
        guard let bookmark = defaults.data(forKey: "backup.folder") else { return 0 }
        guard FileManager.default.fileExists(atPath: source.path) else { return 0 }
        var stale = false
        guard let folder = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            return failed("The backup folder cannot be found any more. Choose the folder again.")
        }
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        if stale, let fresh = try? folder.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) { defaults.set(fresh, forKey: "backup.folder") }
        var n = 0
        var problem: Error?
        // Files coordinates writes with iCloud Drive and other file providers
        NSFileCoordinator().coordinate(writingItemAt: folder, options: [], error: nil) { dir in
            do { n = try copyDir(from: source, to: dir.appendingPathComponent("TiffinPOS-backups", isDirectory: true)) } catch { problem = error }
        }
        if problem != nil { return failed("The backup folder could not be written. Is the USB drive still plugged in, or iCloud Drive on? Choose the folder again.") }
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "backup.last")
        defaults.removeObject(forKey: "backup.lastError")
        changed()
        return n
    }

    private func copyDir(from: URL, to: URL) throws -> Int {
        let fm = FileManager.default
        try fm.createDirectory(at: to, withIntermediateDirectories: true)
        var n = 0
        for f in try fm.contentsOfDirectory(at: from, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey]) {
            let v = try f.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            let target = to.appendingPathComponent(f.lastPathComponent)
            if v.isDirectory == true { n += try copyDir(from: f, to: target); continue }
            if let have = try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize, have == v.fileSize { continue } // backup files never change once made
            if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
            try fm.copyItem(at: f, to: target)
            n += 1
        }
        return n
    }

    private func failed(_ message: String) -> Int {
        defaults.set(message, forKey: "backup.lastError")
        changed()
        return -1
    }

    private func changed() { DispatchQueue.main.async { self.onChange?() } }
}
