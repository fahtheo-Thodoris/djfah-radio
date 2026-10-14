package com.djfah.radio;

import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Metadata;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.metadata.icy.IcyInfo;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * Υπηρεσία αναπαραγωγής ραδιοφώνου: παίζει και με κλειδωμένη οθόνη,
 * δείχνει κουμπιά στην οθόνη κλειδώματος και διαβάζει τους τίτλους (ICY).
 */
@OptIn(markerClass = UnstableApi.class)
public class PlaybackService extends MediaSessionService {

    /** Ο τίτλος του τραγουδιού που στέλνει ο σταθμός. */
    public interface TitleListener {
        void onTitle(String title);
    }

    public static volatile TitleListener titleListener;
    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("DjFahRadio/1.0 (Android)")
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000);
        ExoPlayer player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http)))
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(), true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onMetadata(@NonNull Metadata metadata) {
                for (int i = 0; i < metadata.length(); i++) {
                    Metadata.Entry e = metadata.get(i);
                    if (e instanceof IcyInfo) {
                        String t = ((IcyInfo) e).title;
                        TitleListener l = titleListener;
                        if (l != null) l.onTitle(t == null ? "" : t);
                    }
                }
            }
        });
        session = new MediaSession.Builder(this, player).build();
    }

    @Override
    public MediaSession onGetSession(@NonNull MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Αν ο χρήστης κλείσει την εφαρμογή ενώ δεν παίζει τίποτα, κλείνει και η υπηρεσία.
        Player p = session != null ? session.getPlayer() : null;
        if (p == null || !p.getPlayWhenReady() || p.getMediaItemCount() == 0) {
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        super.onDestroy();
    }
}
