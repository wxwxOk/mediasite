"""On-the-fly HLS transcoder: one ffmpeg job per request id, fMP4 segments on disk.

`build_hls_cmd` is pure (unit-testable); `Converter` manages the ffmpeg subprocess lifecycle.
Uses an EVENT playlist so the player can start after the first segment instead of waiting for the
whole transcode (full VOD-on-demand seeking is a later refinement).

PATCH(mediasite): 镜像内 /srv/app/src/stremiosrv/transcode/converter.py 的替换副本（bind mount）。
改动 ①：vaapi 分支由「全硬管线」改为「CPU 软解 + VAAPI 硬编」。原因：HD530 的 VAAPI 硬解
不支持 HEVC Main10（profile 2），10bit x265 源在原链上 ffmpeg 初始化即死且无回退；软解 + 10bit→
nv12 CPU 转换 + hwupload 硬编实测 4.5x 实时（原全软 libx264 仅 1.4x 且 4 核全满）。
改动 ②：copy 分支对 HEVC 源强制 -tag:v hvc1。MKV 源 remux 进 fMP4 时 ffmpeg 默认写 hev1，
浏览器 MSE 只认 hvc1 直接播放失败（mp4 源自带 hvc1 所以此前未暴露）。
改动 ③：转码任务 VOD 预声明——先取整集时长生成全量播放列表（含 ENDLIST）给客户端，
ffmpeg 实际写 *.live.m3u8 工作副本；关键帧对齐整 4s 保证段边界可预测。解决 EVENT 播放列表
"总时长随转码增长、进度条不断变化"的问题。
上游镜像升级后需重新 diff 本文件（改动点均有 PATCH 标记）。
"""
from __future__ import annotations

import logging
import math
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from stremiosrv import metrics
from stremiosrv.transcode.probe import probe_media

logger = logging.getLogger("stremiosrv.transcode")


def build_hls_cmd(media_url: str, decision: dict, profile: str | None, out_dir: str | Path,
                  duration: float | None = None) -> list[str]:
    out_dir = str(out_dir)
    v = decision.get("video", {})
    a = decision.get("audio")
    argv = ["ffmpeg", "-hide_banner", "-y",
            "-protocol_whitelist", "file,crypto,data,http,tcp,tls,https"]

    if v.get("action") == "transcode":
        if profile == "nvenc-linux":
            argv += ["-hwaccel", "cuda"]
        elif profile and profile.startswith("vaapi"):
            # PATCH(mediasite): 不再 -hwaccel vaapi 硬解；初始化 VAAPI 设备供编码器与 hwupload 用
            argv += ["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va"]

    argv += ["-i", media_url, "-map", "0:v:0"]
    if a is not None:
        argv += ["-map", "0:a:0?"]

    # Video
    if v.get("action") == "copy":
        argv += ["-c:v", "copy"]
        # PATCH(mediasite): HEVC 直拷强制 hvc1 tag；非 HEVC 源打该 tag 会被 ffmpeg 判 incompatible 报错，故条件化
        if v.get("codec") == "hevc":
            argv += ["-tag:v", "hvc1"]
    else:
        w = v.get("scale_width")
        if profile == "nvenc-linux":
            argv += ["-vf", f"scale={w}:-2:flags=lanczos,format=yuv420p" if w else "format=yuv420p",
                     "-c:v", "h264_nvenc", "-preset", "p4"]
        elif profile and profile.startswith("vaapi"):
            # PATCH(mediasite): CPU 帧在软解侧完成 scale 与 10bit→nv12 归一再 hwupload（h264_vaapi 只吃 8bit）
            vf = f"scale={w}:-2:flags=lanczos,format=nv12,hwupload" if w else "format=nv12,hwupload"
            argv += ["-vf", vf, "-c:v", "h264_vaapi"]
        else:
            if w:
                argv += ["-vf", f"scale={w}:-2:flags=lanczos"]
            argv += ["-c:v", "libx264", "-preset", "veryfast"]
        # PATCH(mediasite): VOD 预声明要求段边界可预测 → 关键帧对齐整 4s（与 hls_time 一致）
        if duration:
            argv += ["-force_key_frames", "expr:gte(t,n_forced*4)"]

    # Audio
    if a is not None:
        if a.get("action") == "copy":
            argv += ["-c:a", "copy"]
        else:
            argv += ["-c:a", "aac", "-ac", "2", "-ab", "384000"]

    # PATCH(mediasite): VOD 模式下 ffmpeg 的工作播放列表让位 *.live.m3u8，对客户端的
    # master/index 由 ensure_job 预生成（整集时长固定、可拖到已转码区）
    if duration and v.get("action") == "transcode":
        master_pl, media_pl = "master.live.m3u8", "index.live.m3u8"
    else:
        master_pl, media_pl = "master.m3u8", "index.m3u8"
    argv += [
        "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "event",
        "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", f"{out_dir}/seg%d.m4s",
        "-master_pl_name", master_pl, f"{out_dir}/{media_pl}",
    ]
    return argv


class Converter:
    # How long to wait for a terminated ffmpeg to actually exit before killing it and reclaiming its
    # directory. Short on purpose: SIGTERM ends an encode promptly, and the alternative is holding a
    # request open behind a wedged child.
    STOP_TIMEOUT = 5.0

    def __init__(self, cache_root: str, profile: str | None):
        self.base = Path(cache_root) / "transcode"
        self.profile = profile
        self._jobs: dict[str, subprocess.Popen] = {}
        # job_id -> monotonic time of the last request a CLIENT made for this job's output. The
        # sweep below spares any job whose ffmpeg is alive, which means a transcode nobody is
        # reading was protected by its own liveness: a crashed player left ffmpeg encoding at full
        # tilt forever, and because each playback attempt carries a fresh job id, repeated attempts
        # stacked several at once. Whether the encoder runs is not evidence that anyone is watching.
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def job_dir(self, job_id: str) -> Path:
        """Directory holding one job's HLS output.

        `job_id` arrives straight from the URL and now selects a tree to DELETE, so it is validated
        here — one chokepoint — rather than at each call site. The separator and dot checks are what
        make this robust to the encodings that survive client-side normalisation: `%2e%2e` reaches
        the route as a literal `..`, and because the transcode base sits directly under the cache
        root, `/hlsv2/%2e%2e/certificates.pem` resolved onto the server's TLS private key and
        returned it with a 200. The resolve() comparison is defence in depth for symlinked roots.
        """
        if not job_id or job_id in (".", "..") or "/" in job_id or chr(92) in job_id:
            raise ValueError(f"unsafe transcode job id: {job_id!r}")
        candidate = self.base / job_id
        try:
            if candidate.resolve().parent != self.base.resolve():
                raise ValueError(f"unsafe transcode job id: {job_id!r}")
        except OSError as e:
            raise ValueError(f"unresolvable transcode job id: {job_id!r}") from e
        return candidate

    def job_file(self, job_id: str, filename: str) -> Path:
        """One artefact inside a job directory (playlist, init segment, or media segment).

        `filename` is the same hole from the other end: a job id can be perfectly well-formed while
        the file name walks out of the directory it names.
        """
        if not filename or filename in (".", "..") or "/" in filename or chr(92) in filename:
            raise ValueError(f"unsafe transcode file name: {filename!r}")
        d = self.job_dir(job_id)
        candidate = d / filename
        try:
            if candidate.resolve().parent != d.resolve():
                raise ValueError(f"unsafe transcode file name: {filename!r}")
        except OSError as e:
            raise ValueError(f"unresolvable transcode file name: {filename!r}") from e
        return candidate

    def _remove_job_dir(self, job_id: str) -> None:
        try:
            d = self.job_dir(job_id)
        except ValueError:
            return  # never delete a tree an unsafe id named; the route rejects it separately
        shutil.rmtree(d, ignore_errors=True)

    @staticmethod
    def _write_vod_playlists(d: Path, duration: float) -> None:
        """PATCH(mediasite): 预声明整片播放列表——客户端立刻拿到固定总时长与完整进度条；
        尚未产出的片段由读取路由等待（serve_file 的 _wait_file）。

        master 里不写 CODECS：转码输出的 avc1 profile/level 无法事先准确获知，写错会引发
        hls.js 的支持性误判（宁缺毋滥）；单档播放也不依赖分辨率/码率标注。
        """
        n = max(1, math.ceil(duration / 4.0))
        lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4",
                 "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD",
                 "#EXT-X-INDEPENDENT-SEGMENTS", '#EXT-X-MAP:URI="init.mp4"']
        for i in range(n):
            seg = 4.0 if i < n - 1 else max(0.04, duration - 4.0 * (n - 1))
            lines += [f"#EXTINF:{seg:.3f},", f"seg{i}.m4s"]
        lines.append("#EXT-X-ENDLIST")
        (d / "index.m3u8").write_text("\n".join(lines) + "\n")
        (d / "master.m3u8").write_text(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nindex.m3u8\n")

    def ensure_job(self, job_id: str, media_url: str, decision: dict) -> Path:
        # PATCH(mediasite): 转码任务先取整集时长，供 VOD 预声明；probe 失败退回 EVENT 老行为
        duration: float | None = None
        if (decision.get("video") or {}).get("action") == "transcode":
            try:
                duration = float(probe_media(media_url).get("format", {}).get("duration") or 0) or None
            except Exception:
                duration = None
        with self._lock:
            existing = self._jobs.get(job_id)
            if existing is not None and existing.poll() is None:
                self._seen[job_id] = time.monotonic()
                return self.job_dir(job_id)
            d = self.job_dir(job_id)
            d.mkdir(parents=True, exist_ok=True)
            argv = build_hls_cmd(media_url, decision, self.profile, d, duration)
            # Not a context manager on purpose: this handle IS ffmpeg's stderr for the lifetime
            # of the child process, so closing it at the end of a with-block would truncate the
            # job's log the moment it starts writing. Released when the Popen is collected.
            log = open(d / "ffmpeg.log", "wb")  # noqa: SIM115
            self._jobs[job_id] = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=log)
            if duration:
                self._write_vod_playlists(d, duration)
            # Counts as activity immediately, or the reaper could take a transcode in the window
            # between starting it and the player's first segment request.
            self._seen[job_id] = time.monotonic()
            # Counted here, not in the route: the early return above means a player re-fetching
            # master.m3u8 mid-playback reuses this job, and counting requests would multiply it.
            metrics.record_hls_session(decision)
            return d

    def touch(self, job_id: str) -> None:
        """Record that a client just asked for this job's playlist or a segment."""
        with self._lock:
            if job_id in self._jobs:
                self._seen[job_id] = time.monotonic()

    def reap_idle(self, idle_after: float) -> list[str]:
        """End transcodes nothing has read for `idle_after` seconds. Returns the ids reaped.

        `/destroy` cannot be the only path that stops an encoder: a crashed app, a player that
        refuses the stream, and a dropped connection all skip it, and the process left behind holds
        a GPU as firmly as a wanted one. A job with no recorded activity at all is reaped too --
        treating "unknown" as "still wanted" is exactly how this went unnoticed.
        """
        now = time.monotonic()
        with self._lock:
            idle = [jid for jid, p in self._jobs.items()
                    if p.poll() is None and now - self._seen.get(jid, 0.0) >= idle_after]
        for job_id in idle:
            logger.info("transcode gc: no client for %.0fs, ending job %s", idle_after, job_id)
            self.stop(job_id)
        return idle

    def active_count(self) -> int:
        """Number of ffmpeg transcode jobs currently running (for the admin transcode/GPU card)."""
        with self._lock:
            return sum(1 for p in self._jobs.values() if p.poll() is None)

    def _end(self, p: subprocess.Popen | None) -> None:
        """Terminate a job's ffmpeg and wait for it to actually go away.

        The wait is the point. ffmpeg creates a new file per segment, so removing the tree while the
        child is still alive races it and can leave freshly-written segments behind — which is the
        very leak this code exists to close.
        """
        if p is None or p.poll() is not None:
            return
        p.terminate()
        try:
            p.wait(timeout=self.STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            p.kill()

    def stop(self, job_id: str) -> None:
        """End a job and reclaim its disk.

        The directory goes even when no process is tracked: after a restart the handles are gone but
        the segments are not, and a client calling /destroy on a job this process never started is
        the only signal we will ever get that its output is finished with.
        """
        with self._lock:
            p = self._jobs.pop(job_id, None)
            self._seen.pop(job_id, None)
        self._end(p)
        self._remove_job_dir(job_id)

    def stop_all(self) -> None:
        with self._lock:
            jobs = list(self._jobs.items())
            self._jobs.clear()
            self._seen.clear()
        for job_id, p in jobs:
            self._end(p)
            self._remove_job_dir(job_id)

    def sweep(self, max_age: float = 0.0) -> int:
        """Delete job directories that no live ffmpeg owns. Returns how many were removed.

        Two callers, two ages. At startup it runs with `max_age=0`: this process owns nothing yet,
        so every directory present belongs to a run that is already gone. The periodic caller passes
        a grace, so a job merely between segment writes is never mistaken for garbage.

        A sweep is needed because `/destroy` cannot be the only reclaim path — a killed TV app, a
        dropped connection and a container restart all skip it. One directory on a real box outlived
        two months and two restarts holding 173 files, because nothing ever swept.
        """
        try:
            names = os.listdir(self.base)
        except OSError:
            return 0  # nothing has transcoded yet
        with self._lock:
            live = {jid for jid, p in self._jobs.items() if p.poll() is None}
        now = time.time()
        removed: list[str] = []
        for name in names:
            if name in live:
                continue
            d = self.base / name
            try:
                if not d.is_dir():
                    continue  # only job directories; never a stray file sitting beside them
                # Clamped at zero: `now` is read once before the loop, and a directory
                # stamped a hair later reads as negative age -- which at max_age=0 skips the very
                # sweep that is supposed to take no grace.
                if max(0.0, now - d.stat().st_mtime) < max_age:
                    continue
            except OSError:
                continue
            shutil.rmtree(d, ignore_errors=True)
            if not d.exists():
                removed.append(name)
        if removed:
            with self._lock:
                for name in removed:
                    self._jobs.pop(name, None)
                    self._seen.pop(name, None)
            logger.info("transcode gc: reclaimed %d orphaned job dir(s)", len(removed))
        return len(removed)


def run_transcode_gc(converter: Converter, interval: int = 60, max_age: int = 600,
                     idle_after: int = 300) -> None:
    """Background loop reclaiming abandoned transcodes and their output. Runs forever.

    Two reclaims, in order. `reap_idle` ends encoders nothing is reading -- a crashed player holds
    a GPU otherwise -- and `sweep` deletes directories no encoder owns. The reap comes first so a
    job it just ended is eligible for the sweep in the same pass rather than the next one.
    """
    if not logger.handlers:  # match the evictor: uvicorn doesn't surface our INFO logs by default
        h = logging.StreamHandler()
        h.setFormatter(logging.Formatter("%(asctime)s [transcode] %(message)s"))
        logger.addHandler(h)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    while True:
        time.sleep(interval)
        try:
            converter.reap_idle(idle_after)
        except Exception:
            logger.exception("transcode reap failed")
        try:
            converter.sweep(max_age=max_age)
        except Exception:
            logger.exception("transcode gc pass failed")
