function isBundledEntry(url, entryUrl) {
  try {
    const page = new URL(url);
    const entry = new URL(entryUrl);
    if (page.protocol !== 'file:' || page.username || page.password || entry.protocol !== 'file:') return false;
    page.hash = ''; page.search = ''; entry.hash = ''; entry.search = '';
    return page.href === entry.href;
  } catch { return false; }
}

function isTrustedIpc(event, window, entryUrl) {
  try {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame && event.senderFrame === window.webContents.mainFrame
      && isBundledEntry(event.senderFrame.url, entryUrl));
  } catch { return false; }
}
module.exports = { isBundledEntry, isTrustedIpc };
