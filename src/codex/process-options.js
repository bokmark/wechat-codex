export function codexProcessOptions(codexPath, platform = process.platform) {
  const windowsScript = platform === "win32" && /\.(?:cmd|bat)$/i.test(String(codexPath));
  return windowsScript ? { shell: true, windowsHide: true } : {};
}
