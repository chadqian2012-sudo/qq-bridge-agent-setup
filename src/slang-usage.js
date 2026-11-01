// Count accepted learner calls separately; missing usage remains unknown.
export function createSlangUsage({ read, write, log = () => {} }) {
  const blank = () => ({ calls: 0, measured: 0, unknown: 0, input: 0, output: 0 });
  let writable = true;
  let data = { extraction: blank(), research: blank() };
  try {
    const saved = read();
    if (saved) {
      for (const kind of Object.keys(data)) {
        for (const field of Object.keys(data[kind])) {
          const value = Number(saved[kind]?.[field] ?? 0);
          if (!Number.isFinite(value) || value < 0) throw new Error('invalid slang usage data');
          data[kind][field] = value;
        }
      }
    }
  } catch (error) { writable = false; log('黑话用量读取失败，暂停写入', error); }
  function save() {
    if (!writable) return;
    try { write(data); } catch (error) { writable = false; log('黑话用量写入失败，暂停写入', error); }
  }
  function accepted(kind) {
    if (!data[kind] || !writable) return;
    data[kind].calls += 1;
    save();
  }
  function completed(kind, usage) {
    if (!data[kind] || !writable) return;
    if (data[kind].measured + data[kind].unknown >= data[kind].calls) return;
    if (usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
      data[kind].measured += 1;
      data[kind].input += usage.input;
      data[kind].output += usage.output;
    } else data[kind].unknown += 1;
    save();
  }
  function summary() {
    if (!writable) return { available: false };
    const result = { available: true };
    for (const kind of Object.keys(data)) {
      const row = data[kind];
      result[kind] = { ...row, pending: Math.max(0, row.calls - row.measured - row.unknown) };
    }
    return result;
  }
  function reset() {
    if (!writable) return;
    data = { extraction: blank(), research: blank() };
    save();
  }
  return { accepted, completed, summary, reset };
}
