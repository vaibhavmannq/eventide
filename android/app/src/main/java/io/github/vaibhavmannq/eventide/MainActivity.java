package io.github.vaibhavmannq.eventide;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

/**
 * Eventide for Android: the live site in the app's own WebView, like the Windows and Linux app (desktop/), so it
 * never depends on which browser the phone has. Google refuses sign-in inside an app's own web view, so signing
 * in happens in the browser and comes back through eventide://signin, exactly as on the desktop (docs/DESIGN.md
 * §9.1): the app keeps a secret (the verifier), sends its SHA-256 (the challenge) with the sign-in, and swaps the
 * one-time code plus the verifier for a session at /desktop.
 */
public class MainActivity extends Activity {
    private static final String PENDING = "pending-sign-in";

    private WebView web;
    private Uri home;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        home = Uri.parse(getString(R.string.home));

        // Debug builds only: lets the emulator test (.github/scripts/android-smoke.sh) read the page through DevTools.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.night));
        // The page sits in a frame padded by the system bars: a WebView draws under its own padding.
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(getColor(R.color.night));
        frame.addView(web);
        setContentView(frame);
        keepClearOfSystemBars(frame);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // the offline copy and the outbox live in IndexedDB
        // The server only swaps a handoff code for a session when the request names the app (packages/api/src/auth.ts).
        settings.setUserAgentString(settings.getUserAgentString() + " EventideAndroid/" + version());
        CookieManager.getInstance().setAcceptCookie(true);

        // Without a WebChromeClient a WebView shows no confirm() or alert() and confirm() answers "no": deleting an
        // expense, removing someone or leaving a group would silently do nothing. The default one shows them.
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return route(request.getUrl());
            }
        });

        // Back goes back a page. Apps for Android 16 get only this callback, not onBackPressed.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }

        if (saved != null) web.restoreState(saved);
        if (!open(getIntent()) && web.getUrl() == null) web.loadUrl(home.toString());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent);
    }

    /** Links that start the app: eventide://signin (step 3 of signing in), or an invite link to the site. */
    private boolean open(Intent intent) {
        Uri link = intent == null ? null : intent.getData();
        if (link == null) return false;
        if ("eventide".equals(link.getScheme()) && "signin".equals(link.getHost())) {
            String code = link.getQueryParameter("code");
            String verifier = prefs().getString(PENDING, null);
            prefs().edit().remove(PENDING).apply(); // one attempt per sign-in
            if (isToken(code) && verifier != null) {
                web.loadUrl(home + "/desktop#code=" + code + "&verifier=" + verifier);
                return true;
            }
            return false;
        }
        if (sameSite(link)) {
            web.loadUrl(link.toString());
            return true;
        }
        return false;
    }

    /**
     * Where a link in the page goes. The site's own pages stay in the app; signing in goes to the browser (step 1);
     * any other link (GitHub, an email address) opens where the person would expect it to.
     */
    private boolean route(Uri url) {
        if (sameSite(url)) {
            String path = url.getPath();
            if (!"/api/auth/github".equals(path) && !"/api/auth/google".equals(path)) return false;
            String verifier = newVerifier();
            prefs().edit().putString(PENDING, verifier).apply(); // survives Android closing the app meanwhile
            outside(url.buildUpon().appendQueryParameter("handoff", challengeFor(verifier)).build());
            return true;
        }
        outside(url);
        return true;
    }

    private boolean sameSite(Uri url) {
        return "https".equals(url.getScheme()) && home.getHost() != null && home.getHost().equals(url.getHost());
    }

    private void outside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            // nothing on the phone can open it
        }
    }

    /** Android 15 and later draw apps edge to edge: keep the page out from under the status bar and keyboard. */
    private void keepClearOfSystemBars(FrameLayout frame) {
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED; // handled here; the page must not pad again
            }
            return insets;
        });
    }

    private void back() {
        if (web.canGoBack()) web.goBack();
        else finish();
    }

    @Override
    @SuppressWarnings("deprecation") // Android 12 and earlier
    public void onBackPressed() {
        back();
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush(); // keep the session if Android closes the app
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("eventide", MODE_PRIVATE);
    }

    private String version() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /** 32 random bytes, base64url: the shape the server expects for a code or a verifier. */
    static String newVerifier() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return base64url(bytes);
    }

    static String challengeFor(String verifier) {
        try {
            return base64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static boolean isToken(String text) {
        return text != null && text.matches("[A-Za-z0-9_-]{43}");
    }

    private static String base64url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }
}
