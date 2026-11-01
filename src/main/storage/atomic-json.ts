import * as nodeFs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, basename, join } from 'node:path'

/** The fs surface the atomic writer needs. Injectable so tests can simulate a kill mid-write. */
export interface AtomicFs {
  mkdir(dir: string): Promise<void>
  /** Create the file exclusively (`wx`, mode 0o600; EEXIST if anything is there, symlinks included), write the bytes and fsync them. */
  writeSynced(file: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(file: string): Promise<void>
  readFileSync(file: string): string
  writeSyncedSync(file: string, data: string): void
  renameSync(from: string, to: string): void
  mkdirSync(dir: string): void
  rmSync(file: string): void
  readdirSync(dir: string): string[]
}

export const realFs: AtomicFs = {
  mkdir: async (dir) => {
    await nodeFs.promises.mkdir(dir, { recursive: true })
  },
  writeSynced: async (file, data) => {
    const fh = await nodeFs.promises.open(file, 'wx', 0o600)
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
  },
  rename: (from, to) => nodeFs.promises.rename(from, to),
  rm: (file) => nodeFs.promises.rm(file, { force: true }),
  readFileSync: (file) => nodeFs.readFileSync(file, 'utf8'),
  writeSyncedSync: (file, data) => {
    const fd = nodeFs.openSync(file, 'wx', 0o600)
    try {
      nodeFs.writeSync(fd, data)
      nodeFs.fsyncSync(fd)
    } finally {
      nodeFs.closeSync(fd)
    }
  },
  renameSync: (from, to) => nodeFs.renameSync(from, to),
  mkdirSync: (dir) => {
    nodeFs.mkdirSync(dir, { recursive: true })
  },
  rmSync: (file) => nodeFs.rmSync(file, { force: true }),
  readdirSync: (dir) => nodeFs.readdirSync(dir)
}

const TMP_SUFFIX = '.tmp'
const TMP_ATTEMPTS = 4 // first try plus 3 retries on EEXIST

function tmpNameFor(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`
}

const isExists = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'EEXIST'

/**
 * Write `data` to `file` so a crash at any point leaves either the old or the new
 * complete file, never a partial one: write to a sibling temp file, fsync, rename over.
 * The temp file is created exclusively; on EEXIST a new name is tried (up to 3 retries) and the
 * existing entry is left alone. On any other failure the temp file is removed and the original is untouched.
 */
export async function writeFileAtomic(file: string, data: string, fs: AtomicFs = realFs): Promise<void> {
  await fs.mkdir(dirname(file))
  for (let attempt = 1; ; attempt++) {
    const tmp = tmpNameFor(file)
    try {
      await fs.writeSynced(tmp, data)
    } catch (err) {
      if (isExists(err) && attempt < TMP_ATTEMPTS) continue // not ours: never remove it
      if (!isExists(err)) await fs.rm(tmp).catch(() => undefined)
      throw err
    }
    try {
      await fs.rename(tmp, file)
    } catch (err) {
      await fs.rm(tmp).catch(() => undefined)
      throw err
    }
    return
  }
}

/** Synchronous variant, used on quit when the event loop is going away. */
export function writeFileAtomicSync(file: string, data: string, fs: AtomicFs = realFs): void {
  fs.mkdirSync(dirname(file))
  for (let attempt = 1; ; attempt++) {
    const tmp = tmpNameFor(file)
    try {
      fs.writeSyncedSync(tmp, data)
    } catch (err) {
      if (isExists(err) && attempt < TMP_ATTEMPTS) continue
      if (!isExists(err)) {
        try {
          fs.rmSync(tmp)
        } catch {
          /* best effort */
        }
      }
      throw err
    }
    try {
      fs.renameSync(tmp, file)
    } catch (err) {
      try {
        fs.rmSync(tmp)
      } catch {
        /* best effort */
      }
      throw err
    }
    return
  }
}

export type ReadResult =
  | { status: 'missing' }
  | { status: 'ok'; value: unknown }
  | { status: 'corrupt'; error: string }

/** Read and JSON-parse a file. A missing file is not an error; unreadable or unparsable is `corrupt`. */
export function readJsonFileSync(file: string, fs: AtomicFs = realFs): ReadResult {
  let text: string
  try {
    text = fs.readFileSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'corrupt', error: String((err as Error).message) }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) as unknown }
  } catch (err) {
    return { status: 'corrupt', error: String((err as Error).message) }
  }
}

/** Move a bad file aside as `<file>.corrupt-<timestamp>` so the user's data is never silently destroyed. */
export function backupCorruptFile(file: string, fs: AtomicFs = realFs): string | null {
  const dest = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, dest)
    return dest
  } catch {
    return null
  }
}

/** Remove temp files left by a previous run that died mid-write. */
export function cleanStaleTmp(file: string, fs: AtomicFs = realFs): void {
  const dir = dirname(file)
  const prefix = `${basename(file)}.`
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (n.startsWith(prefix) && n.endsWith(TMP_SUFFIX)) {
      try {
        fs.rmSync(join(dir, n))
      } catch {
        /* best effort */
      }
    }
  }
}
