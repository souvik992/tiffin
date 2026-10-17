package com.tiffinpos.pos;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Installs an add-on file (.tiffinaddon: the signed package files, zipped) into files/pos-addons/<id>. This only
 * unpacks: the POS checks the signature, every file's fingerprint and the version when it starts, exactly as on Windows,
 * and switches the add-on off with a reason if anything is wrong.
 */
final class AddonInstaller {
    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9._-]{1,80}$");
    private static final Pattern ID = Pattern.compile("^[a-z0-9][a-z0-9-]{1,39}$");
    private static final int MAX_FILES = 20;
    private static final long MAX_BYTES = 30L * 1024 * 1024;

    private AddonInstaller() {}

    static File dir(Context ctx) { return new File(ctx.getFilesDir(), "pos-addons"); }

    /** Returns "<name> <version>" of the installed add-on; throws with a message for the person otherwise. */
    static String install(Context ctx, Uri file) throws Exception {
        Map<String, byte[]> files = new HashMap<>();
        long total = 0;
        try (InputStream raw = ctx.getContentResolver().openInputStream(file); ZipInputStream zin = new ZipInputStream(raw)) {
            if (raw == null) throw new Exception("The file could not be opened.");
            for (ZipEntry e; (e = zin.getNextEntry()) != null; ) {
                String name = e.getName();
                if (e.isDirectory() || !NAME.matcher(name).matches() || name.contains("..")) throw new Exception("This is not a Tiffin POS add-on file.");
                if (files.size() >= MAX_FILES) throw new Exception("This is not a Tiffin POS add-on file.");
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = zin.read(buf)) > 0; ) {
                    total += n;
                    if (total > MAX_BYTES) throw new Exception("The add-on file is too large.");
                    b.write(buf, 0, n);
                }
                files.put(name, b.toByteArray());
            }
        }
        byte[] m = files.get("manifest.json");
        if (m == null) throw new Exception("This is not a Tiffin POS add-on file (no manifest).");
        JSONObject manifest = new JSONObject(new String(m, StandardCharsets.UTF_8));
        String id = manifest.optString("id");
        if (!ID.matcher(id).matches()) throw new Exception("This is not a Tiffin POS add-on file.");
        File root = dir(ctx);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create the add-ons folder.");
        File tmp = new File(root, "." + id + ".new"), target = new File(root, id), old = new File(root, "." + id + ".old");
        deleteTree(tmp);
        if (!tmp.mkdirs()) throw new IOException("Cannot unpack the add-on.");
        for (Map.Entry<String, byte[]> f : files.entrySet()) {
            try (OutputStream out = new FileOutputStream(new File(tmp, f.getKey()))) { out.write(f.getValue()); }
        }
        deleteTree(old);
        if (target.exists() && !target.renameTo(old)) throw new IOException("Cannot replace the installed add-on.");
        if (!tmp.renameTo(target)) { old.renameTo(target); throw new IOException("Cannot install the add-on."); }
        deleteTree(old);
        return manifest.optString("name", id) + " " + manifest.optString("version", "");
    }

    /** Removes an add-on's files (its data in the POS database stays, as on Windows). */
    static boolean remove(Context ctx, String id) {
        if (!ID.matcher(id).matches()) return false;
        File target = new File(dir(ctx), id);
        if (!target.exists()) return false;
        deleteTree(target);
        return true;
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
