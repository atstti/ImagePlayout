export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--.-";
  const tenths = Math.floor(Math.max(0, seconds) * 10 + 1e-7);
  const whole = Math.floor(tenths / 10),
    hours = Math.floor(whole / 3600);
  const minutes = String(Math.floor(whole / 60) % 60).padStart(2, "0");
  const rest = String(whole % 60).padStart(2, "0") + "." + (tenths % 10);
  return (
    (hours ? String(hours).padStart(2, "0") + ":" : "") + minutes + ":" + rest
  );
}

export function formatRemaining(duration, currentTime) {
  if (!Number.isFinite(duration) || !Number.isFinite(currentTime))
    return "--:--.-";
  return formatTime(
    Math.ceil(Math.max(0, duration - currentTime) * 10 - 1e-7) / 10,
  );
}
