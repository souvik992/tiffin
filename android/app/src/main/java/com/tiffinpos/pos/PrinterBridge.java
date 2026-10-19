package com.tiffinpos.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The POS backend's way to Android printers (src/services/printing/android.ts). Listens on a loopback port; every
 * request must carry the token given to the backend at start. Protocol: one JSON line, then for "print" the bytes;
 * answers one JSON line. USB printers (USB class 7) through Android's USB host API; Bluetooth (SPP) printers,
 * including the built-in printer of Sunmi-type POS machines (a paired device named "InnerPrinter").
 */
final class PrinterBridge {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final Pattern USB = Pattern.compile("^usb:([0-9a-f]{4}):([0-9a-f]{4})(?::([A-Za-z0-9._-]{1,64}))?$");
    private static final Pattern BT = Pattern.compile("^bt:((?:[0-9A-F]{2}:){5}[0-9A-F]{2})$");
    private static final int MAX_JOB = 8 * 1024 * 1024;
    private static final String USB_PERMISSION = "com.tiffinpos.pos.USB_PERMISSION";

    private final Context ctx;
    private final String token;
    private ServerSocket server;
    private final Object printLock = new Object(); // one print at a time per device keeps receipts whole

    PrinterBridge(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        token = Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /** "port:token" for POS_ANDROID_BRIDGE. */
    synchronized String start() throws IOException {
        if (server == null || server.isClosed()) {
            server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(this::accept, "pos-printer-bridge");
            t.setDaemon(true);
            t.start();
        }
        return server.getLocalPort() + ":" + token;
    }

    private void accept() {
        while (!server.isClosed()) {
            try {
                Socket s = server.accept();
                Thread t = new Thread(() -> handle(s), "pos-printer-job");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) { return; }
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s; InputStream in = sock.getInputStream(); OutputStream out = sock.getOutputStream()) {
            sock.setSoTimeout(30_000);
            JSONObject req = new JSONObject(readLine(in));
            JSONObject res;
            if (!sameToken(req.optString("token"))) res = fail("Not allowed.");
            else switch (req.optString("op")) {
                case "list": res = list(); break;
                case "print": {
                    int n = req.optInt("length", -1);
                    if (n < 0 || n > MAX_JOB) { res = fail("The print job is too large."); break; }
                    byte[] data = readN(in, n);
                    synchronized (printLock) { res = print(req.optString("address"), data, req.optBoolean("slow")); }
                    break;
                }
                case "render": {
                    int n = req.optInt("length", -1);
                    if (n < 0 || n > MAX_RENDER) { res = fail("Too many lines to draw."); break; }
                    res = render(new String(readN(in, n), StandardCharsets.UTF_8));
                    break;
                }
                default: res = fail("Unknown request.");
            }
            out.write((res + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Exception ignored) { /* the backend reports a dropped connection itself */ }
    }

    // ------------------------------------------------------------------ drawing receipt lines

    private static final int MAX_RENDER = 1_000_000;

    /**
     * Receipt lines with the rupee sign or Indian scripts, drawn with Android's fonts (which join Hindi letters
     * correctly) as 1-bit pictures for the printer. Input: [{s:[{t,col,width,align}], w, h, b, c}] (backend
     * textPicture.ts). Output "lines": one "<widthBytes> <height> <base64>" per line, or "-" when one cannot be drawn.
     */
    private JSONObject render(String json) throws Exception {
        JSONArray specs = new JSONArray(json);
        StringBuilder lines = new StringBuilder();
        for (int i = 0; i < specs.length(); i++) {
            try {
                JSONObject s = specs.getJSONObject(i);
                int w = Math.max(1, Math.min(8, s.optInt("w", 1))), h = Math.max(1, Math.min(8, s.optInt("h", 1)));
                int cellW = 12 * w, height = 24 * h;
                int width = ((Math.max(1, Math.min(64, s.optInt("c", 48))) * cellW + 7) / 8) * 8;
                Bitmap bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(bmp);
                canvas.drawColor(Color.WHITE);
                Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                paint.setColor(Color.BLACK);
                paint.setTextSize(17f * h);
                paint.setTypeface(s.optBoolean("b") ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
                Paint.FontMetrics fm = paint.getFontMetrics();
                float baseline = (height - (fm.descent - fm.ascent)) / 2f - fm.ascent;
                JSONArray segs = s.getJSONArray("s");
                for (int k = 0; k < segs.length(); k++) {
                    JSONObject g = segs.getJSONObject(k);
                    String text = g.optString("t");
                    float left = g.optInt("col") * cellW, room = g.optInt("width") * cellW;
                    float tw = paint.measureText(text);
                    String align = g.optString("align", "l");
                    float x = align.equals("r") ? left + room - tw : align.equals("c") ? left + (room - tw) / 2f : left;
                    canvas.save();
                    canvas.clipRect(left, 0, left + room, height);
                    canvas.drawText(text, x, baseline, paint);
                    canvas.restore();
                }
                int wb = width / 8;
                byte[] out = new byte[wb * height];
                int[] px = new int[width];
                for (int y = 0; y < height; y++) {
                    bmp.getPixels(px, 0, width, 0, y, width, 1);
                    for (int x = 0; x < width; x++) {
                        int c = px[x];
                        int lum = ((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff);
                        if (lum < 384) out[y * wb + (x >> 3)] |= (byte) (0x80 >> (x & 7));
                    }
                }
                bmp.recycle();
                lines.append(wb).append(' ').append(height).append(' ').append(Base64.encodeToString(out, Base64.NO_WRAP)).append('\n');
            } catch (Exception e) {
                lines.append("-\n");
            }
        }
        JSONObject r = new JSONObject();
        r.put("ok", true);
        r.put("lines", lines.toString());
        return r;
    }

    private boolean sameToken(String t) {
        return MessageDigest.isEqual(t.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8));
    }

    // ------------------------------------------------------------------ listing

    @SuppressLint("MissingPermission") // checked by canUseBluetooth()
    private JSONObject list() throws Exception {
        JSONArray arr = new JSONArray();
        BluetoothAdapter bt = adapter();
        if (bt != null && canUseBluetooth() && bt.isEnabled()) {
            Set<BluetoothDevice> paired = bt.getBondedDevices();
            for (BluetoothDevice d : paired) {
                String name = d.getName() == null ? "" : d.getName();
                BluetoothClass c = d.getBluetoothClass();
                int major = c == null ? BluetoothClass.Device.Major.UNCATEGORIZED : c.getMajorDeviceClass();
                boolean builtin = name.equalsIgnoreCase("InnerPrinter");
                boolean printerLike = builtin || major == BluetoothClass.Device.Major.IMAGING || major == BluetoothClass.Device.Major.UNCATEGORIZED
                        || name.toLowerCase(Locale.ROOT).matches(".*(print|pos|thermal|receipt|rpp|mtp|bt-?\\d).*");
                if (!printerLike) continue;
                JSONObject o = new JSONObject();
                o.put("address", "bt:" + d.getAddress().toUpperCase(Locale.ROOT));
                o.put("name", builtin ? "Built-in printer" : (name.isEmpty() ? "Bluetooth printer" : name));
                o.put("detail", builtin ? "Built into this POS machine" : "Bluetooth, paired with this device");
                o.put("builtin", builtin);
                arr.put(o);
            }
        }
        UsbManager um = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        if (um != null) for (UsbDevice d : um.getDeviceList().values()) {
            if (printerInterface(d) == null) continue;
            JSONObject o = new JSONObject();
            o.put("address", String.format(Locale.ROOT, "usb:%04x:%04x", d.getVendorId(), d.getProductId()));
            String product = d.getProductName();
            o.put("name", product == null || product.trim().isEmpty() ? "USB receipt printer" : product.trim());
            o.put("detail", String.format(Locale.ROOT, "USB %04x:%04x", d.getVendorId(), d.getProductId()));
            o.put("builtin", false);
            arr.put(o);
        }
        JSONObject res = ok();
        res.put("printers", arr);
        if (bt != null && !canUseBluetooth()) res.put("note", "Allow Nearby devices for Tiffin POS to see Bluetooth printers.");
        return res;
    }

    // ------------------------------------------------------------------ printing

    private JSONObject print(String address, byte[] data, boolean slow) throws Exception {
        Matcher u = USB.matcher(address);
        if (u.matches()) return printUsb(Integer.parseInt(u.group(1), 16), Integer.parseInt(u.group(2), 16), data, slow);
        Matcher b = BT.matcher(address);
        if (b.matches()) return printBluetooth(b.group(1), data, slow);
        return fail("Unknown printer address.");
    }

    @SuppressLint("MissingPermission") // checked by canUseBluetooth()
    private JSONObject printBluetooth(String mac, byte[] data, boolean slow) throws Exception {
        BluetoothAdapter bt = adapter();
        if (bt == null) return fail("This device has no Bluetooth.");
        if (!canUseBluetooth()) return fail("Allow Nearby devices for Tiffin POS (Android Settings, Apps, Tiffin POS, Permissions), then print again.");
        if (!bt.isEnabled()) return fail("Turn on Bluetooth, then print again.");
        BluetoothDevice dev = bt.getRemoteDevice(mac);
        BluetoothSocket sock = null;
        try {
            try { bt.cancelDiscovery(); } catch (SecurityException ignored) { }
            try {
                sock = dev.createRfcommSocketToServiceRecord(SPP);
                sock.connect();
            } catch (IOException first) {
                if (sock != null) try { sock.close(); } catch (IOException ignored) { }
                sock = dev.createInsecureRfcommSocketToServiceRecord(SPP);
                sock.connect();
            }
            OutputStream out = sock.getOutputStream();
            int chunk = slow ? 128 : 512;
            for (int i = 0; i < data.length; i += chunk) {
                out.write(data, i, Math.min(chunk, data.length - i));
                out.flush();
                if (slow) Thread.sleep(20);
            }
            Thread.sleep(Math.min(3000, 300 + data.length / (slow ? 4 : 16))); // let the printer take the last bytes
            return ok();
        } catch (IOException e) {
            return fail("The Bluetooth printer did not answer. Check it is on and paired, then print again.");
        } finally {
            if (sock != null) try { sock.close(); } catch (IOException ignored) { }
        }
    }

    private JSONObject printUsb(int vid, int pid, byte[] data, boolean slow) throws Exception {
        UsbManager um = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        if (um == null) return fail("This device has no USB host support.");
        UsbDevice dev = null;
        for (UsbDevice d : um.getDeviceList().values()) if (d.getVendorId() == vid && d.getProductId() == pid) { dev = d; break; }
        if (dev == null) return fail("The USB printer is not plugged in.");
        if (!um.hasPermission(dev)) {
            int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
            Intent i = new Intent(USB_PERMISSION).setPackage(ctx.getPackageName());
            um.requestPermission(dev, PendingIntent.getBroadcast(ctx, 0, i, flags));
            return fail("Allow the USB printer on the screen (tap OK), then it prints.");
        }
        UsbInterface intf = printerInterface(dev);
        UsbEndpoint outEp = null;
        if (intf != null) for (int i = 0; i < intf.getEndpointCount(); i++) {
            UsbEndpoint e = intf.getEndpoint(i);
            if (e.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && e.getDirection() == UsbConstants.USB_DIR_OUT) { outEp = e; break; }
        }
        if (intf == null || outEp == null) return fail("This USB device is not a printer this app can use.");
        UsbDeviceConnection conn = um.openDevice(dev);
        if (conn == null) return fail("The USB printer could not be opened. Unplug it and plug it in again.");
        try {
            if (!conn.claimInterface(intf, true)) return fail("The USB printer is busy. Unplug it and plug it in again.");
            int chunk = slow ? 512 : 16 * 1024;
            for (int i = 0; i < data.length; ) {
                int n = conn.bulkTransfer(outEp, data, i, Math.min(chunk, data.length - i), 5000);
                if (n <= 0) return fail("The USB printer stopped taking data. Check paper and the cable.");
                i += n;
                if (slow) Thread.sleep(10);
            }
            return ok();
        } finally {
            conn.releaseInterface(intf);
            conn.close();
        }
    }

    // ------------------------------------------------------------------ helpers

    private static UsbInterface printerInterface(UsbDevice d) {
        for (int i = 0; i < d.getInterfaceCount(); i++) if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return d.getInterface(i);
        return null;
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private boolean canUseBluetooth() {
        return Build.VERSION.SDK_INT < 31 || ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private static JSONObject ok() throws Exception { JSONObject o = new JSONObject(); o.put("ok", true); return o; }
    private static JSONObject fail(String m) throws Exception { JSONObject o = new JSONObject(); o.put("ok", false); o.put("error", m); return o; }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1 && c != '\n'; ) { b.write(c); if (b.size() > 4096) throw new IOException("line too long"); }
        return b.toString("UTF-8");
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        for (int off = 0; off < n; ) { int r = in.read(buf, off, n - off); if (r < 0) throw new IOException("short read"); off += r; }
        return buf;
    }
}
