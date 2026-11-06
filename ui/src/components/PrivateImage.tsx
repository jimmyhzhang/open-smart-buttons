import { useEffect, useState } from 'react';
import { privateImage } from '../api';

export function PrivateImage({ id }: { id: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setSrc(undefined);
    void privateImage(id, controller.signal).then(async (response) => {
      if (!response.ok) return;
      const blob = await response.blob();
      if (!controller.signal.aborted) setSrc(url = URL.createObjectURL(blob));
    }).catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src ? <img src={src} alt="" /> : null;
}
