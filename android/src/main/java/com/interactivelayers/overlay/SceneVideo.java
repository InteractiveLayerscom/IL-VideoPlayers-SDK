package com.interactivelayers.overlay;

import android.content.Context;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.view.Surface;
import android.view.TextureView;
import android.widget.ImageView;
import java.io.IOException;

final class SceneVideo extends TextureView implements TextureView.SurfaceTextureListener {
    private final OverlayScene.Layer layer;
    private final ImageView poster;
    private boolean allowAudio;
    private MediaPlayer player;
    private Surface surface;
    private long time;
    private boolean prepared, active, moving, seeking, rendered, failed;

    SceneVideo(Context context, OverlayScene.Layer layer, ImageView poster, boolean allowAudio) {
        super(context);
        this.layer = layer;
        this.poster = poster;
        this.allowAudio = allowAudio && layer.audio;
        setOpaque(false);
        setSurfaceTextureListener(this);
    }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        if (failed) return;
        surface = new Surface(texture);
        player = new MediaPlayer();
        player.setSurface(surface);
        if (!allowAudio) player.setVolume(0, 0);
        player.setOnPreparedListener(loaded -> {
            if (loaded != player) return;
            prepared = true;
            sync();
        });
        player.setOnSeekCompleteListener(loaded -> { if (loaded == player) seeking = false; });
        player.setOnVideoSizeChangedListener((loaded, w, h) -> resize(w, h));
        player.setOnCompletionListener(loaded -> {
            if (loaded == player && layer.loop) sync();
        });
        player.setOnErrorListener((loaded, what, extra) -> {
            if (loaded == player) fail();
            return true;
        });
        try {
            player.setDataSource(layer.videoUrl);
            player.prepareAsync();
        } catch (IOException | RuntimeException error) {
            fail();
        }
    }

    private void resize(int videoWidth, int videoHeight) {
        if (videoWidth <= 0 || videoHeight <= 0 || getWidth() <= 0 || getHeight() <= 0) return;
        Matrix matrix = new Matrix();
        if (!"fill".equals(layer.fit)) {
            float x = (float) getWidth() / videoWidth;
            float y = (float) getHeight() / videoHeight;
            float factor = "contain".equals(layer.fit) ? Math.min(x, y) : Math.max(x, y);
            matrix.setScale(factor / x, factor / y, getWidth() / 2f, getHeight() / 2f);
        }
        setTransform(matrix);
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {
        if (prepared && player != null) resize(player.getVideoWidth(), player.getVideoHeight());
    }

    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
        release();
        return true;
    }

    @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {
        if (prepared && !rendered) {
            rendered = true;
            poster.setVisibility(INVISIBLE);
        }
    }

    void mute() {
        if (!allowAudio) return;
        allowAudio = false;
        if (player != null) player.setVolume(0, 0);
    }

    void update(long time, boolean active, boolean moving) {
        this.time = time;
        this.active = active;
        this.moving = moving;
        sync();
    }

    boolean rendered() { return rendered; }

    private void sync() {
        if (!prepared || player == null) return;
        try {
            if (!active) {
                if (player.isPlaying()) player.pause();
                return;
            }
            long elapsed = Math.max(0, time - layer.start);
            int end = layer.trimEnd >= 0 ? Math.min(player.getDuration(), layer.trimEnd) : player.getDuration();
            int length = end - layer.trimStart;
            if (length <= 0) { fail(); return; }
            boolean ended = !layer.loop && elapsed >= length;
            int position = layer.trimStart + (int) (layer.loop ? elapsed % length : Math.min(elapsed, length - 1));
            if (!seeking && Math.abs(player.getCurrentPosition() - position) > 350) {
                seeking = true;
                if (android.os.Build.VERSION.SDK_INT >= 26) player.seekTo(position, MediaPlayer.SEEK_CLOSEST);
                else player.seekTo(position);
            }
            if (moving && !ended && !player.isPlaying()) player.start();
            else if ((!moving || ended) && player.isPlaying()) player.pause();
        } catch (IllegalStateException error) {
            fail();
        }
    }

    private void fail() {
        failed = true;
        release();
    }

    private void release() {
        prepared = false;
        rendered = false;
        seeking = false;
        if (player != null) player.release();
        if (surface != null) surface.release();
        player = null;
        surface = null;
        poster.setVisibility(VISIBLE);
    }

    void dispose() {
        failed = true;
        release();
    }
}
