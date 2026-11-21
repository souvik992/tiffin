import UIKit
import WebKit
import UniformTypeIdentifiers

/// The POS window: the same screens as the Windows and Android apps, served by the POS on this device. Only the POS's
/// own pages load here (http://127.0.0.1:<port>, with the app's private cookie); web links open in Safari.
final class PosViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    private var web: WKWebView!
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private var port = 0
    private static let paper = UIColor(red: 0xF6 / 255, green: 0xF2 / 255, blue: 0xEC / 255, alpha: 1)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.paper

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // the sign-in stays across restarts (localStorage), like the other apps
        config.mediaTypesRequiringUserActionForPlayback = [] // the new-order sound rings without a tap first
        config.allowsInlineMediaPlayback = true
        config.dataDetectorTypes = [] // phone numbers on bills are text, not links
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: PosScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "pos")
        config.userContentController = ucc

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = Self.paper
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.isHidden = true
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true } // Safari > Develop, for testing
        #endif
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        // Inside the safe area: nothing of the POS sits under the notch, the camera or the home bar.
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: g.topAnchor), web.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: g.leadingAnchor), web.trailingAnchor.constraint(equalTo: g.trailingAnchor),
        ])

        status.numberOfLines = 0
        status.textAlignment = .center
        status.font = .preferredFont(forTextStyle: .title3)
        status.textColor = UIColor(red: 0x1F / 255, green: 0x29 / 255, blue: 0x37 / 255, alpha: 1)
        status.text = "Starting quickPOS…"
        let stack = UIStackView(arrangedSubviews: [spinner, status])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
        ])
        spinner.startAnimating()

        PosBackend.shared.observe { [weak self] s in self?.show(s) }
        BackupCopier.shared.onChange = { [weak self] in self?.pushBackupStatus() }
    }

    private func show(_ s: PosBackend.State) {
        switch s {
        case .starting:
            status.text = "Starting quickPOS…"
        case .failed(let message):
            spinner.stopAnimating()
            status.text = message
            web.isHidden = true
            status.superview?.isHidden = false
        case .ready(let p, let token):
            guard port != p else { return }
            port = p
            // The app's private pass: the POS answers only requests carrying it. Other apps cannot read this cookie.
            var props: [HTTPCookiePropertyKey: Any] = [.domain: "127.0.0.1", .path: "/", .name: "pos_k", .value: token, HTTPCookiePropertyKey("HttpOnly"): "TRUE"]
            props[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
            guard let cookie = HTTPCookie(properties: props) else { return }
            web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
                guard let self, let url = URL(string: "http://127.0.0.1:\(p)/") else { return }
                self.web.load(URLRequest(url: url))
            }
        }
    }

    private func isOwn(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.absoluteString == "about:blank" { return true }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
    }

    /// After the app was in the background: the page is still there; if the POS stopped answering, say so.
    func checkAlive() {
        guard port > 0, let url = URL(string: "http://127.0.0.1:\(port)/api/ping") else { return }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.setValue("pos_k=\(PosBackend.shared.token)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: req) { [weak self] _, res, _ in
            guard (res as? HTTPURLResponse) == nil else { return }
            DispatchQueue.main.async {
                self?.status.text = "quickPOS lost its connection while it was in the background. Close it completely (swipe it away) and open it again. Your bills are safe."
                self?.spinner.stopAnimating()
                self?.status.superview?.isHidden = false
                self?.web.isHidden = true
            }
        }.resume()
    }

    // MARK: navigation: only the POS itself; https links open in Safari

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if isOwn(action.request.url) { decisionHandler(.allow); return }
        if let u = action.request.url, u.scheme == "https", action.navigationType == .linkActivated { UIApplication.shared.open(u) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isOwn(webView.url) else { return }
        web.isHidden = false
        status.superview?.isHidden = true
        spinner.stopAnimating()
        pushBackupStatus()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.port > 0, let url = URL(string: "http://127.0.0.1:\(self.port)/") else { return }
            self.web.load(URLRequest(url: url)) // the POS may be restarting in place (restore, add-on): try again
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url, u.scheme == "https" { UIApplication.shared.open(u) }
        return nil // no pop-up windows
    }

    // MARK: alert, confirm, prompt (the screens ask "Remove this?" with window.confirm)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }

    // MARK: window.PosAndroid on iOS (PosScript)

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard isOwn(message.frameInfo.request.url) || isOwn(webIfOwnURL()), let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "not allowed"); return
        }
        switch op {
        case "saveFile":
            replyHandler(saveFile(name: body["name"] as? String ?? "", base64: body["base64"] as? String ?? ""), nil)
        case "print":
            printPage(title: body["title"] as? String ?? "quickPOS")
            replyHandler(true, nil)
        case "chooseBackupFolder":
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            present(picker, animated: true)
            replyHandler(true, nil)
        case "backupStatus":
            replyHandler(BackupCopier.shared.statusJSON(), nil)
        case "copyBackupsNow":
            DispatchQueue.global(qos: .userInitiated).async {
                let n = BackupCopier.shared.copyNow()
                DispatchQueue.main.async { replyHandler(n, nil) }
            }
        case "forgetBackupFolder":
            BackupCopier.shared.clearFolder()
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown request")
        }
    }

    private func webIfOwnURL() -> URL? { web.url }

    /// Downloads (CSV reports, the menu template): the share sheet, which offers Save to Files, AirDrop, WhatsApp, mail.
    private func saveFile(name: String, base64: String) -> String {
        var safe = name.replacingOccurrences(of: "[^A-Za-z0-9._ -]", with: "_", options: .regularExpression)
        if safe.isEmpty || safe.count > 120 { safe = "tiffin-pos-file" }
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return "error" }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(safe)
        do { try data.write(to: file) } catch { return "error" }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        sheet.popoverPresentationController?.permittedArrowDirections = []
        present(sheet, animated: true)
        return "Choose where to keep \(safe) (Save to Files, or send it)."
    }

    /// Print / PDF of the page (reports, bill copies): AirPrint, and Share as PDF from the same screen.
    private func printPage(title: String) {
        let pc = UIPrintInteractionController.shared
        let info = UIPrintInfo.printInfo()
        info.jobName = title
        info.outputType = .general
        pc.printInfo = info
        pc.printFormatter = web.viewPrintFormatter()
        if UIDevice.current.userInterfaceIdiom == .pad {
            pc.present(from: CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1), in: view, animated: true)
        } else {
            pc.present(animated: true)
        }
    }

    // MARK: backup folder (Settings > Backups)

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        let ok = BackupCopier.shared.setFolder(url)
        pushBackupStatus()
        guard ok else { toast("That folder cannot be used. Choose another one."); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let n = BackupCopier.shared.copyNow()
            DispatchQueue.main.async { self.toast(n < 0 ? "The backups could not be copied to that folder." : "Backups copied to the chosen folder.") }
        }
    }

    private func pushBackupStatus() {
        guard !web.isHidden || web.url != nil else { return }
        web.evaluateJavaScript("window.__posIosBackup && window.__posIosBackup(\(BackupCopier.shared.statusJSON()))", completionHandler: nil)
    }

    private func toast(_ text: String) {
        let a = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        present(a, animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { a.dismiss(animated: true) }
    }
}
