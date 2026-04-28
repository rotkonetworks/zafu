// CSP-compliant replacement for @protobufjs/inquire, which uses
// eval("quire".replace(/^/,"re")) to dynamically require optional
// dependencies (e.g. long.js). Chrome MV3 CSP blocks any eval, so we
// alias the package to this no-op. protobufjs handles a null return
// by falling back to built-in BigInt handling.
module.exports = function inquire(_moduleName) {
  return null;
};
