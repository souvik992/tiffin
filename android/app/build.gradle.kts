import java.util.Properties

plugins {
    id("com.android.application")
}

// The app version follows the desktop app (desktop/package.json), so Windows and Android builds of one commit match.
val desktopVersion: String = Regex("\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+)\"")
    .find(rootProject.file("../desktop/package.json").readText())!!.groupValues[1]
val (vMajor, vMinor, vPatch) = desktopVersion.split(".").map { it.toInt() }

// Release signing: environment variables (CI secrets), else the key in the user's profile
// (%USERPROFILE%\.tiffinpos\android-signing, never in the repository). Without either, the release build is unsigned.
val signingDir = File(System.getProperty("user.home"), ".tiffinpos/android-signing")
val localSigning = Properties().apply { File(signingDir, "release.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) } }
val keystore: String? = System.getenv("POS_ANDROID_KEYSTORE") ?: File(signingDir, "release.jks").takeIf { it.isFile && !localSigning.isEmpty }?.path
fun signing(env: String, prop: String): String? = System.getenv(env) ?: localSigning.getProperty(prop)

android {
    namespace = "com.tiffinpos.pos"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.tiffinpos.pos"
        minSdk = 24
        targetSdk = 37
        versionCode = vMajor * 10000 + vMinor * 100 + vPatch
        versionName = desktopVersion
    }

    signingConfigs {
        if (keystore != null) create("release") {
            storeFile = file(keystore)
            storePassword = signing("POS_ANDROID_KEYSTORE_PASSWORD", "storePassword")
            keyAlias = signing("POS_ANDROID_KEY_ALIAS", "keyAlias")
            keyPassword = signing("POS_ANDROID_KEY_PASSWORD", "keyPassword")
        }
    }

    buildTypes {
        release {
            optimization { enable = false }
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    // One APK per processor type: Node and its libraries are large, a device needs only its own.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }

    packaging {
        // Node runs as a program: its files must be unpacked on the device (in the app's native library folder).
        jniLibs { useLegacyPackaging = true }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

base.archivesName.set("TiffinPOS-$desktopVersion")
