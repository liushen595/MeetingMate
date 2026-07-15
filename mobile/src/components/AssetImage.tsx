import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function AssetImage({ assetId, alt, className, fallbackSrc }: { assetId: string; alt: string; className?: string; fallbackSrc?: string }) {
  const [src, setSrc] = useState<string | null>(fallbackSrc ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(fallbackSrc ?? null);
    setFailed(false);
    api
      .getAssetObjectUrl(assetId)
      .then((url) => {
        objectUrl = url;
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active && !fallbackSrc) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, fallbackSrc]);

  if (!src) return <div className={className ? `${className} asset-placeholder` : "asset-placeholder"}>{failed ? "原图加载失败" : "图片加载中"}</div>;
  return <img alt={alt} className={className} src={src} />;
}
