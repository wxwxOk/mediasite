"""Decide, per stream, whether to copy or transcode — from the client's declared codec support
plus the probe result. Pure function (no ffmpeg), so it's unit-testable anywhere.

PATCH(mediasite): 镜像内 /srv/app/src/stremiosrv/transcode/fingerprint.py 的替换副本（bind mount）。
唯一改动：copy 决策带上源视频编码，供 converter.py 对 HEVC 流强制 hvc1 tag（浏览器 MSE 只认
hvc1，ffmpeg 默认写 hev1 会直接播放失败）。上游镜像升级后需重新 diff 本文件（改动点均有 PATCH 标记）。
"""
from __future__ import annotations


def decide(
    probe: dict,
    video_codecs: list[str],
    audio_codecs: list[str],
    max_audio_channels: int,
    max_width: int,
) -> dict:
    streams = probe.get("streams", [])
    v = next((s for s in streams if s.get("track") == "video"), None)
    a = next((s for s in streams if s.get("track") == "audio"), None)
    out: dict = {}
    if v is not None:
        over_width = v.get("width", 0) > max_width
        unsupported = v.get("codec") not in video_codecs
        if unsupported or over_width:
            out["video"] = {
                "action": "transcode",
                "scale_width": min(v.get("width", max_width), max_width),
            }
        else:
            # PATCH(mediasite): 带出源编码，converter.py 据此决定是否强制 -tag:v hvc1
            out["video"] = {"action": "copy", "codec": v.get("codec")}
    if a is not None:
        bad_codec = a.get("codec") not in audio_codecs
        too_many = a.get("channels", 2) > max_audio_channels
        out["audio"] = {"action": "transcode" if (bad_codec or too_many) else "copy"}
    return out
