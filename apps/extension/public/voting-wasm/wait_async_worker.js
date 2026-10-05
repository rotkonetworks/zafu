// Atomics.waitAsync fallback helper for js-sys's futures executor (see
// build-wasm.sh). Same script the stock glue would start from a blob: URL.
onmessage = function (ev) {
  let [ia, index, value] = ev.data;
  ia = new Int32Array(ia.buffer);
  let result = Atomics.wait(ia, index, value);
  postMessage(result);
};
