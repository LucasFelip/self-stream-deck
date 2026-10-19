package dev.selfstreamdeck;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.Manifest;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Thin shell around the web UI served by the PC (server/). All the deck logic lives on the
 * server; this app only stores the pairing URL, keeps the screen on and renders the page.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "deck";
    private static final String KEY_URL = "url";
    private static final int BACKGROUND = Color.parseColor("#0E0F13");

    private SharedPreferences prefs;
    private WebView web;
    private static final int REQUEST_CAMERA = 7;

    private boolean showingSetup;
    private PermissionRequest pendingCamera; // a page asked for the camera while the system permission was still unknown

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        savePairingFromIntent(getIntent());

        String url = prefs.getString(KEY_URL, null);
        if (url == null) showSetup();
        else showDeck(url);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (savePairingFromIntent(intent)) showDeck(prefs.getString(KEY_URL, ""));
    }

    /** The PC can pair the app over adb: am start -n dev.selfstreamdeck/.MainActivity --es url "http://…" */
    private boolean savePairingFromIntent(Intent intent) {
        String url = intent == null ? null : normalize(intent.getStringExtra(KEY_URL));
        if (url == null) return false;
        prefs.edit().putString(KEY_URL, url).apply();
        return true;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // A stray back press must not drop the deck; only leave the setup screen if a URL is saved.
        String url = prefs.getString(KEY_URL, null);
        if (showingSetup && url != null) showDeck(url);
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    // --- deck -----------------------------------------------------------------

    private void showDeck(final String url) {
        showingSetup = false;
        destroyWebView();

        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showLoadError(url);
            }
        });

        // The page can use the phone camera (the deck turns it into the PC's webcam), but only the paired PC's page.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> answerCameraRequest(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingCamera == request) pendingCamera = null;
            }
        });

        setContentView(web);
        web.loadUrl(url);
        hideSystemBars();
    }

    private boolean isDeckOrigin(Uri origin) {
        String saved = prefs.getString(KEY_URL, null);
        if (origin == null || saved == null) return false;
        Uri deck = Uri.parse(saved);
        return origin.getHost() != null && origin.getHost().equalsIgnoreCase(deck.getHost()) && origin.getPort() == deck.getPort();
    }

    private void answerCameraRequest(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) wantsCamera = true;
        }
        if (!wantsCamera || !isDeckOrigin(request.getOrigin())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingCamera = request;
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQUEST_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA || pendingCamera == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) pendingCamera.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        else pendingCamera.deny();
        pendingCamera = null;
    }

    private void showLoadError(String url) {
        String html = "<body style='background:#0e0f13;color:#eceef4;font-family:sans-serif;text-align:center;padding:48px 16px'>"
                + "<h2>Sem conexão com o PC</h2>"
                + "<p style='color:#8b90a0'>Confira se o servidor está rodando e se o celular está na mesma rede (ou use USB com adb reverse).</p>"
                + "<p><button style='font-size:1.1rem;padding:12px 24px' onclick='location.href=\"" + url + "\"'>Tentar de novo</button></p>"
                + "<p><button style='font-size:1.1rem;padding:12px 24px' onclick='Android.openSettings()'>Configurar endereço</button></p>"
                + "</body>";
        web.loadDataWithBaseURL(url, html, "text/html", "UTF-8", null);
    }

    private void destroyWebView() {
        if (web != null) {
            web.destroy();
            web = null;
        }
    }

    private class Bridge {
        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(MainActivity.this::showSetup);
        }

        /** Short haptic tick for button presses; the page calls it through Deck.vibrate(). */
        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void vibrate(int milliseconds) {
            Vibrator vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) return;
            long duration = Math.max(1, Math.min(milliseconds, 500));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vibrator.vibrate(duration);
            }
        }
    }

    // --- setup ----------------------------------------------------------------

    private void showSetup() {
        showingSetup = true;
        destroyWebView();

        int pad = dp(24);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(BACKGROUND);

        TextView title = new TextView(this);
        title.setText("Conectar ao PC");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);

        TextView hint = new TextView(this);
        hint.setText("Cole o endereço que o servidor mostra ao iniciar:\nhttp://IP:7878/?token=…");
        hint.setTextColor(Color.parseColor("#8B90A0"));
        hint.setPadding(0, dp(8), 0, dp(16));

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.parseColor("#555A6B"));
        input.setHint("http://192.168.0.10:7878/?token=...");
        input.setText(prefs.getString(KEY_URL, ""));

        final TextView error = new TextView(this);
        error.setTextColor(Color.parseColor("#FF6B6B"));

        Button connect = new Button(this);
        connect.setText("Conectar");
        connect.setOnClickListener(v -> {
            String url = normalize(input.getText().toString());
            if (url == null) {
                error.setText("Endereço inválido. Use o formato http://IP:7878/?token=…");
                return;
            }
            prefs.edit().putString(KEY_URL, url).apply();
            showDeck(url);
        });

        ViewGroup.LayoutParams wide = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        root.addView(title, wide);
        root.addView(hint, wide);
        root.addView(input, wide);
        root.addView(error, wide);
        root.addView(connect, wide);

        setContentView(root);
        hideSystemBars();
    }

    /** Accepts "ip:port/?token=x" without a scheme and rejects anything that is not http(s). */
    private static String normalize(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty()) return null;
        if (!value.contains("://")) value = "http://" + value;
        if (!value.startsWith("http://") && !value.startsWith("https://")) return null;
        return value;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
