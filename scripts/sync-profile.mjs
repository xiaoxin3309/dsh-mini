// Put the built plugin into every DSH profile that installs dsh-mini as a normal
// package (no `link:`). Development happens in this directory; the profile gets
// a copy of exactly what `npm pack` would ship.
//
// Why a copy instead of a link: a link makes the profile and the working tree the
// same files, so "one-click update" cannot replace the installed plugin without
// destroying uncommitted work, and a stray `npm install` can rip the link out.
// With two copies each side has one owner — we write to the profile, npm writes to
// the profile, and the working tree stays ours.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginDir = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const profilesRoot = join(homedir(), '.dsh', 'profiles')

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

function targets() {
  const found = []
  for (const profile of readdirSync(profilesRoot)) {
    const manifestPath = join(profilesRoot, profile, 'package.json')
    if (!existsSync(manifestPath)) continue
    let dependency
    try { dependency = JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.['dsh-mini'] } catch { continue }
    if (typeof dependency !== 'string' || dependency === '' || dependency.startsWith('link:')) continue
    found.push({ profile, dir: join(profilesRoot, profile, 'node_modules', 'dsh-mini') })
  }
  return found
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

for (const { profile, dir } of list) {
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
  console.log(`${profile}: synced ${manifest.version} -> ${dir}`)
}

rmSync(staging, { recursive: true, force: true })
console.log('done. restart DSH for the plugin half; the native shell is picked up on next launch.')
