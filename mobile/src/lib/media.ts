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

export async function normalizeRecordedAudio(blob: Blob, fallbackDurationMs: number) {
  try {
    const audioContext = new AudioContext();
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const wav = encodeWavFromAudioBuffer(decoded, 16000);
    await audioContext.close();
    return {
      blob: wav,
      contentType: "audio/wav",
      extension: "wav",
      durationMs: Math.max(1, Math.round(decoded.duration * 1000)),
    };
  } catch {
    return {
      blob,
      contentType: blob.type || "audio/webm",
      extension: blob.type.includes("mp4") ? "m4a" : "webm",
      durationMs: Math.max(1, fallbackDurationMs),
    };
  }
}

function encodeWavFromAudioBuffer(buffer: AudioBuffer, targetSampleRate: number) {
  const samples = downmixAndResample(buffer, targetSampleRate);
  const dataLength = samples.length * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function downmixAndResample(buffer: AudioBuffer, targetSampleRate: number) {
  const sourceLength = buffer.length;
  const sourceSampleRate = buffer.sampleRate;
  const targetLength = Math.max(1, Math.round((sourceLength * targetSampleRate) / sourceSampleRate));
  const mono = new Float32Array(sourceLength);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let index = 0; index < sourceLength; index += 1) mono[index] += channelData[index] / buffer.numberOfChannels;
  }

  if (sourceSampleRate === targetSampleRate) return mono;

  const resampled = new Float32Array(targetLength);
  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = (index * (sourceLength - 1)) / Math.max(1, targetLength - 1);
    const left = Math.floor(sourceIndex);
    const right = Math.min(sourceLength - 1, left + 1);
    const weight = sourceIndex - left;
    resampled[index] = mono[left] * (1 - weight) + mono[right] * weight;
  }
  return resampled;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}
