package com.tiffinpos.pos;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Copies the POS backups (files/pos-data/backups) to a folder the owner chose on a USB stick or SD card (Android's
 * folder picker; the permission is kept). Copies new or changed files only, every 15 minutes while the app runs and
 * when "Copy now" is pressed. The backups themselves are made by the POS (verified, hourly and daily) as on Windows.
 */
final class BackupCopier {
    private static final String PREFS = "backup-copy";
    private final Context ctx;
    private Thread timer;

    BackupCopier(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    private SharedPreferences prefs() { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    void setFolder(Uri tree) {
        ctx.getContentResolver().takePersistableUriPermission(tree, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        prefs().edit().putString("tree", tree.toString()).apply();
    }

    void clearFolder() { prefs().edit().remove("tree").remove("last").remove("lastError").apply(); }

    /** { folder, lastCopiedAt, lastError } as JSON for the screen. */
    String status() {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            String tree = prefs().getString("tree", null);
            o.put("folder", tree == null ? org.json.JSONObject.NULL : Uri.decode(Uri.parse(tree).getLastPathSegment()));
            o.put("lastCopiedAt", prefs().getLong("last", 0));
            o.put("lastError", prefs().getString("lastError", ""));
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    synchronized void startTimer() {
        if (timer != null) return;
        timer = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                copyNow();
                try { Thread.sleep(15 * 60_000); } catch (InterruptedException e) { return; }
            }
        }, "pos-backup-copy");
        timer.setDaemon(true);
        timer.start();
    }

    /** Copies new or changed backup files. Returns how many files were copied, or -1 when it failed. */
    synchronized int copyNow() {
        String tree = prefs().getString("tree", null);
        if (tree == null) return 0;
        File src = new File(ctx.getFilesDir(), "pos-data/backups");
        if (!src.isDirectory()) return 0;
        try {
            Uri t = Uri.parse(tree);
            Uri root = DocumentsContract.buildDocumentUriUsingTree(t, DocumentsContract.getTreeDocumentId(t));
            Uri dir = childDir(t, root, "TiffinPOS-backups");
            int n = copyDir(t, src, dir);
            prefs().edit().putLong("last", System.currentTimeMillis()).putString("lastError", "").apply();
            return n;
        } catch (Exception e) {
            prefs().edit().putString("lastError", "The backup folder could not be written. Is the USB stick or SD card still in? Choose the folder again.").apply();
            return -1;
        }
    }

    private int copyDir(Uri tree, File from, Uri to) throws Exception {
        Map<String, Long> existing = list(tree, to);
        int n = 0;
        File[] files = from.listFiles();
        if (files == null) return 0;
        for (File f : files) {
            if (f.isDirectory()) { n += copyDir(tree, f, childDir(tree, to, f.getName())); continue; }
            Long size = existing.get(f.getName());
            if (size != null && size == f.length()) continue; // already copied (backup files never change after they are made)
            ContentResolver cr = ctx.getContentResolver();
            Uri doc = size != null ? childUri(tree, to, f.getName()) : DocumentsContract.createDocument(cr, to, "application/octet-stream", f.getName());
            if (doc == null) throw new Exception("cannot create " + f.getName());
            try (InputStream in = new FileInputStream(f); OutputStream out = cr.openOutputStream(doc, "wt")) {
                if (out == null) throw new Exception("cannot write " + f.getName());
                byte[] buf = new byte[64 * 1024];
                for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
            }
            n++;
        }
        return n;
    }

    private Map<String, Long> list(Uri tree, Uri dir) {
        Map<String, Long> m = new HashMap<>();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(dir));
        try (Cursor c = ctx.getContentResolver().query(children, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE}, null, null, null)) {
            if (c != null) while (c.moveToNext()) m.put(c.getString(0), c.isNull(1) ? -1L : c.getLong(1));
        }
        return m;
    }

    private Uri childUri(Uri tree, Uri dir, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(dir));
        try (Cursor c = ctx.getContentResolver().query(children, new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null) while (c.moveToNext()) if (name.equals(c.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0));
        }
        return null;
    }

    private Uri childDir(Uri tree, Uri dir, String name) throws Exception {
        Uri found = childUri(tree, dir, name);
        if (found != null) return found;
        Uri made = DocumentsContract.createDocument(ctx.getContentResolver(), dir, DocumentsContract.Document.MIME_TYPE_DIR, name);
        if (made == null) throw new Exception("cannot create folder " + name);
        return made;
    }
}
