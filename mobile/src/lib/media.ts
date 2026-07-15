import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";

export async function captureImageFromCamera() {
  const photo = await Camera.getPhoto({
    quality: 82,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Prompt,
  });
  if (!photo.dataUrl) throw new Error("没有读取到图片数据");
  const blob = dataUrlToBlob(photo.dataUrl);
  const { width, height } = await getImageSize(blob);
  return { blob, width, height, filename: `photo-${Date.now()}.${photo.format || "jpg"}`, contentType: blob.type || "image/jpeg" };
}

export async function readImageFile(file: File) {
  const { width, height } = await getImageSize(file);
  return { blob: file, width, height, filename: file.name, contentType: file.type || "image/jpeg" };
}

export function dataUrlToBlob(dataUrl: string) {
  const [meta, data] = dataUrl.split(",");
  const contentType = /data:(.*);base64/.exec(meta)?.[1] ?? "application/octet-stream";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: contentType });
}

export function getImageSize(blob: Blob) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片尺寸"));
    };
    image.src = url;
  });
}

export function formatDuration(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}
