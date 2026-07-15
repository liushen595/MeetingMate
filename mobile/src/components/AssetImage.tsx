import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function AssetImage({ assetId, alt, className }: { assetId: string; alt: string; className?: string }) {
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

  if (!src) return <div className={className ? `${className} asset-placeholder` : "asset-placeholder"}>图片加载中</div>;
  return <img alt={alt} className={className} src={src} />;
}
