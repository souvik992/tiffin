package com.tiffinpos.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The POS window: the same screens as the Windows app, served by the POS on this device (PosBackend). */
public class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static final int PICK_BACKUP_FOLDER = 2;
    private static final int PICK_ADDON = 4;
    private BackupCopier backups;

    private WebView web;
    private LinearLayout status;
    private TextView statusText;
    private Button retry;
    private int port = -1;
    private ValueCallback<Uri[]> pendingFiles;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); // a counter screen
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        backups = new BackupCopier(this);
        askPermissions();
        try {
            Intent svc = new Intent(this, PosService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc); else startService(svc);
        } catch (Exception ignored) { /* the POS still runs while the window is open */ }
        backups.startTimer();

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false); // the new-order sound
        s.setSupportZoom(false);
        web.setVisibility(View.INVISIBLE);
        web.addJavascriptInterface(new Bridge(), "PosAndroid"); // only the POS's own pages load in this window
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !isOwn(r.getUrl()); // only the POS itself, nothing from the internet
            }
            @Override public void onPageFinished(WebView v, String url) { if (isOwn(Uri.parse(url))) { v.setVisibility(View.VISIBLE); status.setVisibility(View.GONE); } }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) { recreate(); return true; }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = cb;
                Intent i = p.createIntent();
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(i, PICK_FILES); } catch (Exception e) { pendingFiles = null; return false; }
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        status = new LinearLayout(this);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 48, 48, 48);
        statusText = new TextView(this);
        statusText.setTextSize(18);
        statusText.setTextColor(Color.parseColor("#1F2937"));
        statusText.setGravity(Gravity.CENTER);
        retry = new Button(this);
        retry.setText("Try again");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> start());
        status.addView(statusText);
        status.addView(retry);
        root.addView(status, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        start();
    }

    private void start() {
        retry.setVisibility(View.GONE);
        status.setVisibility(View.VISIBLE);
        statusText.setText("Starting Tiffin POS…");
        PosBackend.start(this, new PosBackend.Listener() {
            @Override public void ready(int p, String token) {
                runOnUiThread(() -> {
                    port = p;
                    CookieManager cm = CookieManager.getInstance();
                    cm.setAcceptCookie(true);
                    // the app's private pass: the POS answers only requests carrying it (other apps cannot read this cookie)
                    cm.setCookie("http://127.0.0.1:" + p, "pos_k=" + token + "; Path=/; HttpOnly; SameSite=Strict", ok -> web.loadUrl("http://127.0.0.1:" + p + "/"));
                    cm.flush();
                });
            }
            @Override public void failed(String message) {
                runOnUiThread(() -> { statusText.setText(message); retry.setVisibility(View.VISIBLE); });
            }
        });
    }

    private boolean isOwn(Uri u) {
        return u != null && "http".equals(u.getScheme()) && "127.0.0.1".equals(u.getHost()) && u.getPort() == port;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_BACKUP_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                backups.setFolder(data.getData());
                new Thread(() -> { int n = backups.copyNow(); runOnUiThread(() -> toast(n < 0 ? "The backups could not be copied to that folder." : "Backups copied to the chosen folder.")); }).start();
            }
            return;
        }
        if (requestCode == PICK_ADDON) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri file = data.getData();
                new Thread(() -> {
                    try {
                        String what = AddonInstaller.install(this, file);
                        runOnUiThread(() -> toast(what + " installed. The POS restarts to load it."));
                        restartPos();
                    } catch (Exception e) {
                        runOnUiThread(() -> toast(e.getMessage() == null ? "The add-on could not be installed." : e.getMessage()));
                    }
                }).start();
            }
            return;
        }
        if (requestCode != PICK_FILES || pendingFiles == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) result = new Uri[]{data.getData()};
        }
        pendingFiles.onReceiveValue(result);
        pendingFiles = null;
    }

    private void askPermissions() {
        List<String> want = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) want.add(Manifest.permission.BLUETOOTH_CONNECT);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) want.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!want.isEmpty() && Build.VERSION.SDK_INT >= 23) requestPermissions(want.toArray(new String[0]), 3);
    }

    private void toast(String m) { Toast.makeText(this, m, Toast.LENGTH_LONG).show(); }

    /** Restarts the POS (after installing or removing an add-on): the window shows "Starting" and reloads. */
    private void restartPos() {
        runOnUiThread(() -> { web.setVisibility(View.INVISIBLE); status.setVisibility(View.VISIBLE); statusText.setText("Restarting Tiffin POS…"); });
        PosBackend.stopAndWait();
        runOnUiThread(this::start);
    }

    /** What the POS screens can ask of the Android app (window.PosAndroid). Only the POS's own pages load here. */
    private final class Bridge {
        /** Saves a download (CSV report, template) to the device's Downloads folder. Returns where, or an error. */
        @JavascriptInterface
        public String saveFile(String name, String mime, String base64) {
            String safe = name.replaceAll("[^A-Za-z0-9._ -]", "_");
            if (safe.isEmpty() || safe.length() > 120) safe = "tiffin-pos-file";
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new Exception("no Downloads folder");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) { if (out == null) throw new Exception("cannot write"); out.write(bytes); }
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) throw new Exception("no storage");
                    try (OutputStream out = new FileOutputStream(new File(dir, safe))) { out.write(bytes); }
                }
                String where = "Saved to Downloads: " + safe;
                runOnUiThread(() -> toast(where));
                return where;
            } catch (Exception e) {
                runOnUiThread(() -> toast("The file could not be saved."));
                return "error";
            }
        }

        /** Print / PDF of the current page (reports, bill copies) through Android's printing (includes Save as PDF). */
        @JavascriptInterface
        public void print(String title) {
            runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                String job = title == null || title.isEmpty() ? "Tiffin POS" : title;
                pm.print(job, web.createPrintDocumentAdapter(job), new PrintAttributes.Builder().build());
            });
        }

        /** Backups to a USB stick or SD card: choose the folder (Android's folder picker). */
        @JavascriptInterface
        public void chooseBackupFolder() {
            runOnUiThread(() -> {
                try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_BACKUP_FOLDER); } catch (Exception e) { toast("This device cannot choose a folder."); }
            });
        }

        @JavascriptInterface
        public String backupStatus() { return backups.status(); }

        @JavascriptInterface
        public int copyBackupsNow() { return backups.copyNow(); }

        @JavascriptInterface
        public void forgetBackupFolder() { backups.clearFolder(); }

        /** Add-ons: choose a .tiffinaddon file (the POS checks its signature when it loads it). */
        @JavascriptInterface
        public void installAddon() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(i, PICK_ADDON); } catch (Exception e) { toast("This device cannot choose a file."); }
            });
        }

        @JavascriptInterface
        public boolean removeAddon(String id) {
            boolean removed = AddonInstaller.remove(MainActivity.this, id);
            if (removed) new Thread(MainActivity.this::restartPos).start();
            return removed;
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else moveTaskToBack(true); // keep the POS running
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) { PosBackend.stop(); stopService(new Intent(this, PosService.class)); }
        web.destroy();
        super.onDestroy();
    }
}
