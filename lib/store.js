import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Dosya bozuksa hata fırlatır: örnek veriyle üzerine yazıp gerçek veriyi kaybetmemek için. */
export function loadState(file, createInitial) {
  if (!existsSync(file)) {
    const initial = createInitial();
    saveState(file, initial);
    return initial;
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Önce geçici dosyaya yazar, sonra taşır: yarım kalan yazma veriyi bozmaz. */
export function saveState(file, state) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
}
