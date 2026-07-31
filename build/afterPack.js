"use strict";

/**
 * Ad-hoc re-sign the packaged app.
 *
 * We modify the prebuilt Electron bundle (icon, asar), which breaks its
 * factory ad-hoc signature. A BROKEN signature downloaded from the internet
 * gets Gatekeeper's dead-end "app is damaged" dialog; a VALID ad-hoc one gets
 * the recoverable "unidentified developer" flow (right-click → Open). Signing
 * with "-" costs nothing and needs no Apple account.
 */

const { execSync } = require("child_process");
const path = require("path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: "inherit" });
  execSync(`codesign --verify --deep --strict "${app}"`, { stdio: "inherit" });
};
