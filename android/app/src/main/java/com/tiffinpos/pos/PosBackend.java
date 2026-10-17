package com.tiffinpos.pos;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.Map;

/**
 * Runs the POS backend: the same Node.js code as on Windows (android/backend/main.ts), as a child process of this app.
 * Node and its libraries are in the app's native library folder (the only place Android allows running programs from);
 * the backend and UI files are unpacked from the APK once per version. Bills live in files/pos-data.
 */
final class PosBackend {
    interface Listener { void ready(int port, String token); void failed(String message); }

    private static Process process;
    private static OutputStream stdin;
    private static PrinterBridge bridge;

    private PosBackend() {}

    /** Starts the backend on a background thread and reports the port (or why it failed). */
    static synchronized void start(Context ctx, Listener listener) {
        if (process != null && process.isAlive()) { stop(); }
        new Thread(() -> {
            try {
                File appDir = unpack(ctx);
                File data = new File(ctx.getFilesDir(), "pos-data");
                if (!data.isDirectory() && !data.mkdirs()) throw new IOException("Cannot create the data folder.");
                File portFile = new File(ctx.getFilesDir(), "pos-port");
                //noinspection ResultOfMethodCallIgnored
                portFile.delete();
                String token = randomToken();
                String nativeDir = ctx.getApplicationInfo().nativeLibraryDir;
                ProcessBuilder pb = new ProcessBuilder(nativeDir + "/libposnode.so", new File(appDir, "app/android/backend/main.ts").getPath());
                Map<String, String> env = pb.environment();
                env.put("LD_LIBRARY_PATH", nativeDir);
                env.put("HOME", ctx.getFilesDir().getPath());
                env.put("TMPDIR", ctx.getCacheDir().getPath());
                env.put("POS_DATA_DIR", data.getPath());
                env.put("POS_UI_DIR", new File(appDir, "ui").getPath());
                env.put("POS_APP_TOKEN", token);
                env.put("POS_PORT_FILE", portFile.getPath());
                env.put("POS_APP_VERSION", versionName(ctx));
                synchronized (PosBackend.class) { if (bridge == null) bridge = new PrinterBridge(ctx); }
                env.put("POS_ANDROID_BRIDGE", bridge.start()); // USB and Bluetooth printers through this app
                pb.directory(new File(appDir, "app"));
                pb.redirectErrorStream(true);
                pb.redirectOutput(ProcessBuilder.Redirect.appendTo(new File(ctx.getFilesDir(), "pos-backend.log")));
                Process p = pb.start();
                synchronized (PosBackend.class) { process = p; stdin = p.getOutputStream(); }
                long until = System.currentTimeMillis() + 120_000; // the first start on a slow device builds the database
                while (System.currentTimeMillis() < until) {
                    if (portFile.isFile()) {
                        int port = Integer.parseInt(new String(Files.readAllBytes(portFile.toPath()), StandardCharsets.UTF_8).trim());
                        listener.ready(port, token);
                        return;
                    }
                    if (!p.isAlive()) { listener.failed("The POS stopped while starting (code " + p.exitValue() + "). " + lastLog(ctx)); return; }
                    Thread.sleep(100);
                }
                listener.failed("The POS took too long to start. " + lastLog(ctx));
            } catch (Exception e) {
                listener.failed("The POS could not start: " + e.getMessage());
            }
        }, "pos-backend-start").start();
    }

    /** Asks the backend to finish its work and stop (closing its input), then makes sure it is gone. */
    static synchronized void stop() {
        Process p = process;
        process = null;
        if (p == null) return;
        try { if (stdin != null) stdin.close(); } catch (IOException ignored) { }
        new Thread(() -> {
            try { if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroy(); } catch (InterruptedException ignored) { p.destroy(); }
        }, "pos-backend-stop").start();
    }

    static synchronized boolean running() { return process != null && process.isAlive(); }

    /** Unpacks assets/pos (backend + UI) into files/pos-app/<fingerprint> unless that version is already there. */
    private static File unpack(Context ctx) throws IOException {
        AssetManager am = ctx.getAssets();
        String fp;
        try (InputStream in = am.open("pos/fingerprint.txt")) { fp = new String(readAll(in), StandardCharsets.UTF_8).trim(); }
        File root = new File(ctx.getFilesDir(), "pos-app");
        File dir = new File(root, fp);
        if (new File(dir, ".complete").isFile()) return dir;
        File tmp = new File(root, fp + ".tmp");
        deleteTree(tmp);
        copyAssets(am, "pos", tmp);
        if (!new File(tmp, ".complete").createNewFile() || !tmp.renameTo(dir)) throw new IOException("Cannot unpack the POS files.");
        File[] old = root.listFiles();
        if (old != null) for (File f : old) if (!f.getName().equals(fp)) deleteTree(f);
        return dir;
    }

    private static void copyAssets(AssetManager am, String path, File to) throws IOException {
        String[] list = am.list(path);
        if (list == null || list.length == 0) { // a file
            File parent = to.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create " + parent);
            try (InputStream in = am.open(path); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return;
        }
        if (!to.isDirectory() && !to.mkdirs()) throw new IOException("Cannot create " + to);
        for (String name : list) copyAssets(am, path + "/" + name, new File(to, name));
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        return b.toByteArray();
    }

    private static String randomToken() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static String versionName(Context ctx) {
        try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; } catch (Exception e) { return "0.0.0"; }
    }

    /** The last lines of the backend's log, to show with a start-up error. */
    private static String lastLog(Context ctx) {
        try {
            byte[] all = Files.readAllBytes(new File(ctx.getFilesDir(), "pos-backend.log").toPath());
            String s = new String(all, Math.max(0, all.length - 600), Math.min(all.length, 600), StandardCharsets.UTF_8);
            return s.trim();
        } catch (IOException e) { return ""; }
    }
}
