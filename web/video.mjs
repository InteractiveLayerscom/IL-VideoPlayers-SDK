export function nativeProgramTime(video) {
  const origin = video.getStartDate?.()?.getTime();
  return Number.isFinite(origin) ? Math.round(origin + video.currentTime * 1000) : null;
}

export function listenToVideo(video, callback) {
  const events = [
    'playing',
    'pause',
    'timeupdate',
    'seeking',
    'seeked',
    'ended',
    'waiting',
    'emptied',
  ];
  for (const name of events) video.addEventListener(name, callback);
  video.ownerDocument.addEventListener('visibilitychange', callback);
  return () => {
    for (const name of events) video.removeEventListener(name, callback);
    video.ownerDocument.removeEventListener('visibilitychange', callback);
  };
}

export function imageVisible(image) {
  if (!image?.complete || !image.naturalWidth || !image.isConnected || image.ownerDocument.hidden)
    return false;
  const style = image.ownerDocument.defaultView.getComputedStyle(image);
  const rect = image.getBoundingClientRect();
  return (
    style.display !== 'none' &&
    style.visibility === 'visible' &&
    Number(style.opacity) > 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}
