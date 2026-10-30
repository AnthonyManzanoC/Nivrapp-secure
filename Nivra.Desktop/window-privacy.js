'use strict';

// Start protected while account policy restores; background previews remain
// protected even if the foreground user permits screenshots.
function installWindowPrivacy(window) {
  let protectedByPolicy = true;
  const apply = () => {
    if (!window.isDestroyed()) window.setContentProtection(protectedByPolicy || !window.isFocused());
  };
  window.on('blur', apply); window.on('focus', apply);
  apply();
  return { setProtected(enabled) { protectedByPolicy = enabled; apply(); } };
}
module.exports = { installWindowPrivacy };
