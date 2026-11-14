// Keras exports declare a flexible batch size ([-1, 28, 28, 1]), which LiteRT.js 2.6.0 can't run:
// a [1,28,28,1] tensor is rejected by its strict shape comparison, and [-1,28,28,1] crashes.
// Rewrite the leading -1 of every tensor's shape / shape_signature to 1, in place.
// Values are overwritten int32 → int32, so the file size and every offset stay the same.
//
// tflite schema field ids: Model.subgraphs = 2, SubGraph.tensors = 0, Tensor.shape = 0,
// Tensor.shape_signature = 7.

/** Patches `buf` in place (pass a copy if the original must stay untouched) and returns it. */
export function fixBatchSize(buf: Uint8Array): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // absolute position of field i in table t, or 0
  const field = (t: number, i: number) => {
    const vt = t - dv.getInt32(t, true), vsize = dv.getUint16(vt, true), o = 4 + 2 * i;
    if (o >= vsize) return 0;
    const fo = dv.getUint16(vt + o, true);
    return fo ? t + fo : 0;
  };
  const deref = (p: number) => p + dv.getUint32(p, true);
  const vec = (t: number, i: number) => {
    const p = field(t, i);
    if (!p) return null;
    const v = deref(p);
    return { n: dv.getUint32(v, true), at: v + 4 };
  };
  try {
    const model = deref(0);
    const subs = vec(model, 2); // Model.subgraphs
    if (!subs) return buf;
    for (let s = 0; s < subs.n; s++) {
      const sg = deref(subs.at + 4 * s);
      const tensors = vec(sg, 0); // SubGraph.tensors
      if (!tensors) continue;
      for (let k = 0; k < tensors.n; k++) {
        const t = deref(tensors.at + 4 * k);
        for (const f of [0, 7]) { // Tensor.shape, Tensor.shape_signature
          const v = vec(t, f);
          if (v && v.n > 0 && dv.getInt32(v.at, true) === -1) dv.setInt32(v.at, 1, true);
        }
      }
    }
  } catch (e) {
    console.warn("Could not patch batch size", e);
  }
  return buf;
}
