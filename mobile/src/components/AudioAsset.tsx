import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function AudioAsset({ assetId }: { assetId: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    api
      .getAssetObjectUrl(assetId)
      .then((url) => {
        objectUrl = url;
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setSrc(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  if (!src) return <div className="audio-placeholder">音频加载中</div>;
  return <audio controls preload="metadata" src={src} />;
}
