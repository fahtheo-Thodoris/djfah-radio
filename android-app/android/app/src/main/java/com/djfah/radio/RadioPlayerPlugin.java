package com.djfah.radio;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.annotation.OptIn;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

/** Γέφυρα ανάμεσα στην οθόνη της εφαρμογής και στην υπηρεσία αναπαραγωγής. */
@OptIn(markerClass = UnstableApi.class)
@CapacitorPlugin(name = "RadioPlayer")
public class RadioPlayerPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaController controller;
    private ListenableFuture<MediaController> pending;
    private final List<Runnable> waiting = new ArrayList<>();
    private String pendingShare;

    @Override
    public void load() {
        PlaybackService.titleListener = title -> {
            JSObject o = new JSObject();
            o.put("title", title);
            notifyListeners("meta", o, true);
        };
        Intent i = getActivity() != null ? getActivity().getIntent() : null;
        captureShare(i);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        captureShare(intent);
    }

    /** Κείμενο που μοιράστηκε ο χρήστης από άλλη εφαρμογή (π.χ. Shazam). */
    private void captureShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null && subject == null) return;
        String all = ((subject != null ? subject + "\n" : "") + (text != null ? text : "")).trim();
        intent.setAction(Intent.ACTION_MAIN);
        pendingShare = all;
        JSObject o = new JSObject();
        o.put("text", all);
        notifyListeners("shared", o, true);
    }

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject o = new JSObject();
        o.put("text", pendingShare);
        pendingShare = null;
        call.resolve(o);
    }

    // ------------------------------------------------------------ σύνδεση με την υπηρεσία
    private void withController(Runnable r) {
        main.post(() -> {
            if (controller != null) {
                r.run();
                return;
            }
            waiting.add(r);
            if (pending != null) return;
            Context ctx = getContext();
            SessionToken token = new SessionToken(ctx, new ComponentName(ctx, PlaybackService.class));
            pending = new MediaController.Builder(ctx, token).buildAsync();
            pending.addListener(() -> {
                try {
                    controller = pending.get();
                    controller.addListener(new Player.Listener() {
                        @Override
                        public void onIsPlayingChanged(boolean isPlaying) {
                            sendState();
                        }

                        @Override
                        public void onPlaybackStateChanged(int playbackState) {
                            sendState();
                        }

                        @Override
                        public void onPlayerError(PlaybackException error) {
                            JSObject o = new JSObject();
                            o.put("message", error.getErrorCodeName());
                            notifyListeners("error", o);
                        }
                    });
                } catch (Exception e) {
                    controller = null;
                }
                pending = null;
                List<Runnable> todo = new ArrayList<>(waiting);
                waiting.clear();
                for (Runnable w : todo) w.run();
            }, ContextCompat.getMainExecutor(ctx));
        });
    }

    private void sendState() {
        if (controller == null) return;
        String s;
        int st = controller.getPlaybackState();
        if (controller.isPlaying()) s = "playing";
        else if (st == Player.STATE_BUFFERING) s = "buffering";
        else if (st == Player.STATE_ENDED) s = "ended";
        else if (st == Player.STATE_IDLE) s = "idle";
        else s = controller.getPlayWhenReady() ? "buffering" : "paused";
        JSObject o = new JSObject();
        o.put("state", s);
        notifyListeners("state", o);
    }

    // ------------------------------------------------------------ εντολές
    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Λείπει η διεύθυνση ροής");
            return;
        }
        String station = call.getString("station", "DjFah Radio");
        String subtitle = call.getString("subtitle", "DjFah Radio");
        String artwork = call.getString("artwork", "");
        withController(() -> {
            if (controller == null) {
                call.reject("Η υπηρεσία αναπαραγωγής δεν ξεκίνησε");
                return;
            }
            MediaMetadata.Builder md = new MediaMetadata.Builder()
                    .setTitle(station)
                    .setArtist(subtitle)
                    .setStation(station);
            if (artwork != null && artwork.startsWith("http")) md.setArtworkUri(Uri.parse(artwork));
            MediaItem.Builder item = new MediaItem.Builder().setUri(url).setMediaMetadata(md.build());
            if (url.toLowerCase().contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
            controller.setMediaItem(item.build());
            controller.prepare();
            controller.play();
            call.resolve();
        });
    }

    /** Παίζει ήδη κάτι; (όταν η οθόνη ξανανοίγει ενώ η μουσική συνεχίζει στο παρασκήνιο) */
    @PluginMethod
    public void getState(PluginCall call) {
        withController(() -> {
            JSObject o = new JSObject();
            boolean playing = controller != null && (controller.isPlaying() || controller.getPlayWhenReady());
            o.put("playing", playing);
            MediaItem cur = controller != null ? controller.getCurrentMediaItem() : null;
            o.put("url", cur != null && cur.localConfiguration != null ? cur.localConfiguration.uri.toString() : "");
            call.resolve(o);
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withController(() -> {
            if (controller != null) controller.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withController(() -> {
            if (controller != null) {
                controller.stop();
                controller.clearMediaItems();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        float v = call.getFloat("volume", 1f);
        withController(() -> {
            if (controller != null) controller.setVolume(Math.max(0f, Math.min(1f, v)));
            call.resolve();
        });
    }

    /** Ενημερώνει την οθόνη κλειδώματος με τον τίτλο του τραγουδιού. */
    @PluginMethod
    public void setNowPlaying(PluginCall call) {
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        withController(() -> {
            if (controller != null && controller.getCurrentMediaItem() != null) {
                MediaItem cur = controller.getCurrentMediaItem();
                MediaMetadata md = cur.mediaMetadata.buildUpon().setTitle(title).setArtist(artist).build();
                controller.replaceMediaItem(controller.getCurrentMediaItemIndex(), cur.buildUpon().setMediaMetadata(md).build());
            }
            call.resolve();
        });
    }

    // ------------------------------------------------------------ βοηθητικά
    @PluginMethod
    public void openUrl(PluginCall call) {
        String app = call.getString("app", "");
        String url = call.getString("url", "");
        Context ctx = getContext();
        boolean ok = false;
        if (app != null && !app.isEmpty()) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(app));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                ok = true;
            } catch (ActivityNotFoundException ignored) {
            }
        }
        if (!ok && url != null && !url.isEmpty()) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                ok = true;
            } catch (ActivityNotFoundException ignored) {
            }
        }
        JSObject o = new JSObject();
        o.put("ok", ok);
        call.resolve(o);
    }

    @PluginMethod
    public void copy(PluginCall call) {
        String text = call.getString("text", "");
        main.post(() -> {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("DjFah Radio", text));
            call.resolve();
        });
    }

    /** Αποθηκεύει ένα αρχείο (π.χ. Excel) και ανοίγει το μενού «Κοινοποίηση». */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String name = call.getString("name", "DjFah Radio.xlsx");
        String data = call.getString("base64", "");
        String mime = call.getString("mime", "application/octet-stream");
        try {
            File dir = new File(getContext().getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("φάκελος");
            File f = new File(dir, name.replaceAll("[\\\\/:*?\"<>|]", " "));
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Αποθήκευση ή αποστολή");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            JSObject o = new JSObject();
            o.put("path", f.getName());
            call.resolve(o);
        } catch (Exception e) {
            call.reject("Δεν αποθηκεύτηκε το αρχείο: " + e.getMessage());
        }
    }
}
