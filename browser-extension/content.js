// Product-page DOM reader; messages are internal to this extension.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'PIRCE_WATCH_READ_SNAPSHOT') return;
  try { sendResponse({ snapshot: PirceWatchExtractor.read(document, location.href) }); }
  catch { sendResponse({ snapshot: null }); }
});
