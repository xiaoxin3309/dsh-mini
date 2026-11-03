// Put the built plugin into every DSH profile that installs dsh-mini as a normal
// package (no `link:`). Development happens in this directory; the profile gets a
// copy of exactly what `npm pack` would ship.
//
// Why a copy instead of a link: a link makes the profile and the working tree the
// same files, so "one-click update" cannot replace the installed plugin without
// destroying uncommitted work, and a stray `npm install` can rip the link out.
// With two copies each side has one owner — we write to the profile, npm writes to
// the profile, and the working tree stays ours.
//
// Why a copy is not enough any more: a profile that is managed by pnpm keeps
// `package.json` + `pnpm-lock.yaml`, and the plugin manager re-installs from that
// lockfile. A copy-only deploy left the lockfile pointing at an old version, and the
// next install silently rolled the plugin back (2026-11-03: iPad lost the import
// button because the desktop profile had been reverted to 0.1.12). So before copying
// we pin the profile's manifests to the version we are about to place on disk.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginDir = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const profilesRoot = join(homedir(), '.dsh', 'profiles')
const dshHome = join(homedir(), '.dsh')

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

function targets() {
  const found = []
  for (const profile of readdirSync(profilesRoot)) {
    const profileDir = join(profilesRoot, profile)
    const manifestPath = join(profileDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let dependency
    try { dependency = JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.['dsh-mini'] } catch { continue }
    if (typeof dependency !== 'string' || dependency === '' || dependency.startsWith('link:')) continue
    found.push({ profile, profileDir, dependency, dir: join(profileDir, 'node_modules', 'dsh-mini') })
  }
  return found
}

/** The pnpm that ships inside DSH's runtime, else whatever is on PATH. */
function findPnpm() {
  const runtimes = join(dshHome, 'dsh-runtimes')
  if (existsSync(runtimes)) {
    for (const runtime of readdirSync(runtimes)) {
      const base = join(runtimes, runtime, 'dependencies')
      const node = join(base, 'node', 'bin', 'node.exe')
      const pnpm = join(base, 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(node) && existsSync(pnpm)) return { node, pnpm }
    }
  }
  return null
}

/** Is this exact version actually on the registry? A fresh local build may not be. */
async function isPublished(version) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${manifest.name}/-/${manifest.name}-${version}.tgz`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * pnpm refuses versions younger than its `minimumReleaseAge`; listing the exact
 * version as an exception is the same trick the plugin's own updater uses.
 */
function ensureReleaseAgeExclude(profileDir, version) {
  const workspace = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) return
  const spec = `${manifest.name}@${version}`
  const text = readFileSync(workspace, 'utf8')
  if (text.includes(spec)) return
  const lines = text.trimEnd().split(/\r?\n/)
  const index = lines.findIndex((line) => /^minimumReleaseAgeExclude:/i.test(line))
  if (index === -1) {
    lines.push('minimumReleaseAgeExclude:', `  - ${spec}`)
  } else {
    let at = index + 1
    while (at < lines.length && /^\s+-\s/.test(lines[at])) at += 1
    lines.splice(at, 0, `  - ${spec}`)
  }
  writeFileSync(workspace, `${lines.join('\n')}\n`, 'utf8')
}

/**
 * Point the profile's manifests at `version` so a later lockfile-driven install
 * cannot drag the plugin back to an older release. Returns a short status used in
 * the sync line.
 */
function pinManifests(profileDir, version) {
  const pnpm = findPnpm()
  if (pnpm !== null && existsSync(join(profileDir, 'pnpm-lock.yaml'))) {
    ensureReleaseAgeExclude(profileDir, version)
    try {
      execFileSync(
        pnpm.node,
        [
          pnpm.pnpm,
          'add',
          `${manifest.name}@${version}`,
          '--save-exact',
          '--config.minimum-release-age=0',
          '--lockfile-only',
          '--reporter=append-only',
          '-C',
          profileDir,
        ],
        { stdio: 'inherit' },
      )
      return 'pnpm-pinned'
    } catch (error) {
      console.warn(`pin via pnpm failed (${error?.message ?? error}) — manifests may still point at the old version`)
      return 'pin-failed'
    }
  }
  const manifestPath = join(profileDir, 'package.json')
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    raw.dependencies = { ...raw.dependencies, [manifest.name]: version }
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    return 'manifest-pinned'
  } catch {
    return 'pin-failed'
  }
}

const list = targets()
if (list.length === 0) {
  console.log('no profile installs dsh-mini as a package (all link: or none) — nothing to sync')
  process.exit(0)
}

console.log(`packing ${manifest.name}@${manifest.version} …`)
const staging = mkdtempSync(join(tmpdir(), 'dsh-mini-sync-'))
// Keep npm's cache inside our staging dir: on this machine the global cache lives
// under `C:\Program Files\nodejs\node_cache`, which a normal user cannot write
// (npm dies with EPERM before it ever packs anything).
const cacheDir = join(staging, 'npm-cache')
const packArgs = ['pack', '--pack-destination', staging, '--cache', cacheDir, '--silent']
// Run npm's own entry point through this node binary: `npm.cmd` needs a shell, and a
// shell would put the arguments through Windows quoting rules for no reason.
const npmCli = join(resolve(process.execPath, '..'), 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (existsSync(npmCli)) {
  execFileSync(process.execPath, [npmCli, ...packArgs], { cwd: pluginDir, stdio: 'inherit' })
} else {
  execFileSync('npm', packArgs, { cwd: pluginDir, shell: true, stdio: 'inherit' })
}
const tarball = readdirSync(staging).find((name) => name.endsWith('.tgz'))
if (tarball === undefined) throw new Error('npm pack produced no tarball')
execFileSync('tar', ['-xzf', join(staging, tarball), '-C', staging], { stdio: 'inherit' })
const packed = join(staging, 'package')

const published = await isPublished(manifest.version)
if (!published) {
  console.warn(
    `warning: ${manifest.name}@${manifest.version} is not on the registry — pinning the manifest needs a published ` +
      'version, so this deploy only replaces files and a later plugin-manager install may roll it back.',
  )
}

for (const { profile, profileDir, dir } of list) {
  const pinned = published ? pinManifests(profileDir, manifest.version) : 'copy-only'
  if (existsSync(dir)) {
    // Move aside rather than delete in place: a half-copied plugin is worse than an
    // old one, and the rename is instant.
    const aside = `${dir}.old-${stamp}`
    renameSync(dir, aside)
    cpSync(packed, dir, { recursive: true })
    rmSync(aside, { recursive: true, force: true })
  } else {
    cpSync(packed, dir, { recursive: true })
  }
  console.log(`${profile}: synced ${manifest.version} (${pinned}) -> ${dir}`)
}

rmSync(staging, { recursive: true, force: true })
console.log('done. restart DSH for the plugin half; the native shell is picked up on next launch.')
