// Notes live in your home folder, so they survive a reload.
const file = async (os) => `${(await os.process.env()).HOME}/Documents/notes.json`;

export async function loadNotes(os) {
  try {
    return JSON.parse(await os.fs.readTextFile(await file(os)));
  } catch {
    return [];
  }
}

export async function saveNotes(os, notes) {
  await os.fs.writeTextFile(await file(os), JSON.stringify(notes, null, 2));
}
