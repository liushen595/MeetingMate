import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function AudioAsset({ assetId, fallbackSrc }: { assetId: string; fallbackSrc?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    api
      .getAssetObjectUrl(assetId)
      .then((url) => {
        objectUrl = url;
        setFailed(false);
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setSrc(fallbackSrc ?? null);
        }
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, fallbackSrc]);

  if (!src) return <div className="audio-placeholder">音频暂不可播放</div>;
  return (
    <div className="audio-player-stack">
      <audio controls preload="metadata" src={src} />
      {failed && fallbackSrc && <small>服务器音频流暂不可用，正在播放本机录音。</small>}
    </div>
  );
}
