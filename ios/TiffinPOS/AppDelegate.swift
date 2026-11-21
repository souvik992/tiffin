import UIKit

/// quickPOS for iPhone and iPad: the same POS as on Windows and Android, running on this device (PosBackend: Node for
/// iOS inside the app), shown in a web view (PosViewController). See ios/README.md.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        PosBackend.shared.start() // as early as possible: the window waits for it
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var background: UIBackgroundTaskIdentifier = .invalid

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = PosViewController()
        w.makeKeyAndVisible()
        window = w
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true // a counter screen: it does not dim while the shop is open
        endBackgroundTask()
        BackupCopier.shared.startTimer()
        (window?.rootViewController as? PosViewController)?.checkAlive()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// iOS freezes the app shortly after it leaves the screen. Ask for the usual extra half minute so a bill or kitchen
    /// ticket that is printing finishes; bills themselves are already saved.
    func sceneDidEnterBackground(_ scene: UIScene) {
        endBackgroundTask()
        background = UIApplication.shared.beginBackgroundTask(withName: "pos-finish-printing") { [weak self] in self?.endBackgroundTask() }
        BackupCopier.shared.stopTimer()
    }

    private func endBackgroundTask() {
        if background != .invalid { UIApplication.shared.endBackgroundTask(background); background = .invalid }
    }
}
