#!/usr/bin/env node
/**
 * Regenerates the plugin-market index for this repository.
 *
 *   node scripts/generate-index.mjs            # write site/index.json, site/index.html, site/icons
 *   node scripts/generate-index.mjs --check    # validate only, write nothing
 *   node scripts/generate-index.mjs --allow-dirty
 *
 * The index format is "format": 1, described in the DSH docs:
 * https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market.md
 *
 * Every listed version must pin an exact source:
 *   - git: git+<repo url>#<40-hex commit>&path:/<package dir>   (default, no npm account needed)
 *   - npm: <name>@<version>                                     (set "source": "npm" in market.config.json)
 *
 * The generator reads git commit time of each package directory, so the
 * packages must be committed before the index is generated.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = new Set(process.argv.slice(2))
const checkOnly = argv.has('--check')
const allowDirty = argv.has('--allow-dirty')

const errors = []
const warnings = []
const fail = (message) => errors.push(message)
const warn = (message) => warnings.push(message)

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const exists = (file) => fs.existsSync(file)

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    if (allowFailure) return ''
    throw error
  }
}

// The sandboxed Desktop runtime denies piped child processes (EPERM), so the
// git CLI is not always reachable from here. Fall back to reading .git
// directly: the HEAD commit and its committer time are enough to pin an index.
// The per-package history and the uncommitted-changes check are unavailable.
function readGitHeadFallback() {
  const gitDir = path.join(root, '.git')
  try {
    if (!fs.statSync(gitDir).isDirectory()) return null
  } catch {
    return null
  }
  let head
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return null
  }
  let commit = head
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5).trim()
    const refFile = path.join(gitDir, ref)
    if (exists(refFile)) {
      commit = fs.readFileSync(refFile, 'utf8').trim()
    } else if (exists(path.join(gitDir, 'packed-refs'))) {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
      const line = packed.split(/\r?\n/).find((row) => row.endsWith(` ${ref}`))
      if (line) commit = line.split(' ')[0]
    }
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) return null
  const objectFile = path.join(gitDir, 'objects', commit.slice(0, 2), commit.slice(2))
  let timestamp
  try {
    const object = zlib.inflateSync(fs.readFileSync(objectFile)).toString('utf8')
    const match = object.match(/^committer .* (\d+) [+-]\d{4}$/m)
    if (match) timestamp = Number(match[1])
  } catch {
    // A packed object has no loose file; the timestamp stays unknown.
  }
  return { commit, timestamp }
}

let gitCli = false
try {
  gitCli = git(['rev-parse', '--is-inside-work-tree']) === 'true'
} catch {
  gitCli = false
}
const gitFallback = gitCli ? null : readGitHeadFallback()
const isGitRepo = gitCli || Boolean(gitFallback)
if (!isGitRepo) {
  fail('not a git repository: run git init, commit the packages, then regenerate')
}
if (gitFallback) {
  warn(
    'git CLI is unavailable (sandboxed runtime): the index is pinned to HEAD and uncommitted package changes are not detected — commit before pushing',
  )
}

function printProblems() {
  for (const message of warnings) console.warn(`warning: ${message}`)
  for (const message of errors) console.error(`error:   ${message}`)
}

// ---------------------------------------------------------------- config ---

const configFile = path.join(root, 'market.config.json')
if (!exists(configFile)) {
  console.error(`error: missing ${path.relative(root, configFile)}`)
  process.exit(1)
}
const config = readJson(configFile)

const owner = config.github?.owner
const repo = config.github?.repo
const branch = config.github?.branch ?? 'main'
if (!owner || owner === 'USER') fail('market.config.json: set github.owner to your GitHub login')
if (!repo || repo === 'REPO') fail('market.config.json: set github.repo to your repository name')
if (!config.title?.en) fail('market.config.json: title.en is required by the index format')

const repoUrl = `https://github.com/${owner}/${repo}`
const repoGitUrl = `${repoUrl}.git`
const pagesUrl = `https://${String(owner).toLowerCase()}.github.io/${repo}/`
const indexUrl = `${pagesUrl}index.json`

// LocalizedText helper: strings are allowed, but we always emit { en, ... }.
function localizedText(en, ru) {
  if (!en) return undefined
  const value = { en }
  if (ru) value.ru = ru
  return value
}

function readLocaleMeta(packageDir, language) {
  const file = path.join(packageDir, 'locale', `${language}.json`)
  if (!exists(file)) return undefined
  try {
    return readJson(file)?.meta
  } catch (error) {
    warn(`${path.relative(root, file)}: ${error.message}`)
    return undefined
  }
}

// -------------------------------------------------------------- packages ---

const packagesDir = path.join(root, 'packages')
if (!exists(packagesDir)) fail('missing packages/ directory')

const configuredOrder = Object.keys(config.plugins ?? {})
const directories = fs
  .readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const unknownConfigured = configuredOrder.filter((name) => !directories.includes(name))
for (const name of unknownConfigured) warn(`market.config.json: plugins.${name} has no packages/${name} directory`)

const orderedDirectories = [
  ...configuredOrder.filter((name) => directories.includes(name)),
  ...directories.filter((name) => !configuredOrder.includes(name)),
]

const plugins = []
const usedIconFiles = new Map()
const seenNames = new Set()

for (const directoryName of orderedDirectories) {
  const packageDir = path.join(packagesDir, directoryName)
  const relativeDir = `packages/${directoryName}`
  const manifestFile = path.join(packageDir, 'package.json')

  if (!exists(manifestFile)) {
    fail(`${relativeDir}: package.json is missing`)
    continue
  }

  let manifest
  try {
    manifest = readJson(manifestFile)
  } catch (error) {
    fail(`${relativeDir}/package.json: ${error.message}`)
    continue
  }

  const name = manifest.name
  if (!name) {
    fail(`${relativeDir}/package.json: name is missing`)
    continue
  }
  if (!/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name)) {
    fail(`${relativeDir}: "${name}" is not a valid npm package name`)
  }
  if (name !== directoryName) warn(`${relativeDir}: package name "${name}" differs from its directory`)
  if (seenNames.has(name)) fail(`${relativeDir}: duplicate package name "${name}"`)
  seenNames.add(name)

  if (manifest.private === true) warn(`${relativeDir}: "private": true — fine for git installs, blocks npm publish`)

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) {
    fail(`${relativeDir}: version "${manifest.version}" is not an exact SemVer version`)
  }

  const enginesDsh = manifest.engines?.dsh
  if (!enginesDsh) {
    fail(`${relativeDir}: package.json needs "engines": { "dsh": "..." } — the market requires it`)
  } else {
    if (!/\d/.test(enginesDsh) || !/^[\dA-Za-z\s<>=~^*|.+-]+$/.test(enginesDsh)) {
      fail(`${relativeDir}: engines.dsh "${enginesDsh}" is not a valid SemVer range`)
    }
    if (config.enginesDsh && enginesDsh !== config.enginesDsh) {
      warn(`${relativeDir}: engines.dsh "${enginesDsh}" differs from market.config.json enginesDsh`)
    }
  }

  const patchDeclaration = manifest.dsh?.bundle?.patch
  const patchFiles = Array.isArray(patchDeclaration)
    ? patchDeclaration
    : patchDeclaration
      ? [patchDeclaration]
      : []
  if (!patchFiles.length) {
    fail(`${relativeDir}: dsh.bundle.patch is missing — the package is not a bundle`)
  }
  for (const patchFile of patchFiles) {
    if (!exists(path.join(packageDir, patchFile))) {
      fail(`${relativeDir}: dsh.bundle.patch points at missing file ${patchFile}`)
    }
  }

  if (manifest.dsh?.client) {
    const clientEntry = manifest.exports?.['./client']
    if (!clientEntry) {
      fail(`${relativeDir}: declares dsh.client but exports["./client"] is missing`)
    } else if (!exists(path.join(packageDir, clientEntry))) {
      fail(`${relativeDir}: exports["./client"] points at missing file ${clientEntry}`)
    }
  }

  // Icon: inline or relative to the index. Keep the file next to the index.
  const iconDeclaration = manifest.icon ?? './icon.svg'
  let iconReference
  const iconSource = path.resolve(packageDir, iconDeclaration)
  if (exists(iconSource)) {
    const extension = path.extname(iconSource).toLowerCase().replace('.jpeg', '.jpg')
    if (!['.svg', '.png', '.jpg', '.webp'].includes(extension)) {
      warn(`${relativeDir}: icon ${iconDeclaration} has unsupported extension ${extension || '(none)'}`)
    }
    const iconFileName = `${directoryName}${extension}`
    usedIconFiles.set(iconFileName, iconSource)
    iconReference = `icons/${iconFileName}`
  } else {
    warn(`${relativeDir}: no icon file (${iconDeclaration}); the card will use default artwork`)
  }

  // Display metadata: the package locale files win, package.json is the fallback.
  const enMeta = readLocaleMeta(packageDir, 'en')
  const ruMeta = readLocaleMeta(packageDir, 'ru')
  const title = localizedText(enMeta?.title, ruMeta?.title)
  const description = localizedText(
    enMeta?.description ?? manifest.description,
    ruMeta?.description,
  )

  // Source pin and publish time.
  let commit
  let publishTimestamp
  if (gitCli) {
    const dirty = git(['status', '--porcelain', '--', relativeDir], { allowFailure: true })
    if (dirty) {
      const message = `${relativeDir}: uncommitted changes — commit them so the index can pin a real commit`
      if (allowDirty) warn(message)
      else fail(message)
    }
    commit = git(['log', '-1', '--format=%H', '--', relativeDir], { allowFailure: true })
    const commitTime = Number(git(['log', '-1', '--format=%ct', '--', relativeDir], { allowFailure: true }))
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      fail(`${relativeDir}: no commit found for this directory — git add && git commit first`)
    }
    if (!Number.isFinite(commitTime) || commitTime <= 0) {
      fail(`${relativeDir}: cannot read the commit time`)
    } else {
      publishTimestamp = commitTime
    }
  } else if (gitFallback) {
    commit = gitFallback.commit
    publishTimestamp = gitFallback.timestamp
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      fail(`${relativeDir}: cannot resolve the HEAD commit`)
    }
  }

  if (!Number.isInteger(publishTimestamp)) publishTimestamp = Math.floor(Date.now() / 1000)

  let source
  if (config.source === 'npm') {
    source = { type: 'npm' }
    if (config.registry) source.registry = config.registry
    if (!config.npmPublishTimestamps?.[name]?.[manifest.version]) {
      warn(`${relativeDir}: source is npm but no publish time is configured — using the commit time`)
    }
    publishTimestamp = config.npmPublishTimestamps?.[name]?.[manifest.version] ?? publishTimestamp
  } else {
    source = {
      type: 'git',
      url: repoUrl,
      commit,
      path: relativeDir,
    }
  }

  const settings = config.plugins?.[name] ?? {}
  const metadata = {}
  if (settings.category) metadata.category = settings.category
  if (Array.isArray(settings.keywords) && settings.keywords.length) metadata.keywords = settings.keywords
  if (Array.isArray(settings.labels) && settings.labels.length) metadata.labels = settings.labels

  const plugin = {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(iconReference ? { icon: iconReference } : {}),
    ...(config.author ? { author: config.author } : {}),
    homepage: `${repoUrl}/tree/${branch}/${relativeDir}`,
    repository: { url: repoUrl, directory: relativeDir },
    ...(Object.keys(metadata).length ? { metadata } : {}),
    versions: [
      {
        version: manifest.version,
        publishTimestamp,
        source,
        engines: { dsh: enginesDsh ?? '*' },
      },
    ],
  }
  plugins.push(plugin)
}

// ---------------------------------------------------------------- index ---

if (!plugins.length && !errors.length) fail('no plugins found in packages/')

const index = {
  format: 1,
  title: config.title,
  ...(config.description ? { description: config.description } : {}),
  ...(config.categories ? { metadata: { categories: config.categories } } : {}),
  plugins,
}

// A light self-check of the rules the DSH reader enforces.
const checkNames = new Set()
for (const plugin of index.plugins) {
  if (checkNames.has(plugin.name)) fail(`index: duplicate plugin name ${plugin.name}`)
  checkNames.add(plugin.name)
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) fail(`index: ${plugin.name} has no versions`)
  const versions = new Set()
  for (const version of plugin.versions ?? []) {
    if (versions.has(version.version)) fail(`index: ${plugin.name} repeats version ${version.version}`)
    versions.add(version.version)
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0) {
      fail(`index: ${plugin.name}@${version.version} has an invalid publishTimestamp`)
    }
    if (!version.engines?.dsh) fail(`index: ${plugin.name}@${version.version} has no engines.dsh`)
    if (version.source?.type === 'git') {
      if (!/^[0-9a-f]{40}$/.test(version.source.commit ?? '')) {
        fail(`index: ${plugin.name}@${version.version} has an invalid git commit`)
      }
      if (!String(version.source.url).startsWith('https://')) {
        fail(`index: ${plugin.name}@${version.version} git url must be https`)
      }
      if (!version.source.path) fail(`index: ${plugin.name}@${version.version} git source has no path`)
    } else if (version.source?.type !== 'npm') {
      fail(`index: ${plugin.name}@${version.version} has an unsupported source type`)
    }
  }
}

// ----------------------------------------------------------------- write ---

const siteDir = path.join(root, 'site')
const iconsDir = path.join(siteDir, 'icons')

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderHtml() {
  const marketTitle = index.title?.ru ?? index.title?.en
  const marketDescription = index.description?.ru ?? index.description?.en ?? ''
  const cards = index.plugins
    .map((plugin) => {
      const title = plugin.title?.ru ?? plugin.title?.en ?? plugin.name
      const englishTitle = plugin.title?.en && plugin.title?.ru ? plugin.title.en : ''
      const description = plugin.description?.ru ?? plugin.description?.en ?? ''
      const version = plugin.versions[0]
      const installSpec =
        version.source.type === 'git'
          ? `git+${version.source.url}.git#${version.source.commit}&path:/${version.source.path}`
          : `${plugin.name}@${version.version}`
      const icon = plugin.icon
        ? `<img class="icon" src="${htmlEscape(plugin.icon)}" alt="" loading="lazy">`
        : '<div class="icon icon-placeholder"></div>'
      return `      <article class="card">
        ${icon}
        <div class="body">
          <h2>${htmlEscape(title)}${englishTitle ? ` <span class="alt">${htmlEscape(englishTitle)}</span>` : ''}</h2>
          <p>${htmlEscape(description)}</p>
          <p class="meta"><code>${htmlEscape(plugin.name)}</code> · ${htmlEscape(version.version)} · dsh ${htmlEscape(version.engines.dsh)}</p>
          <p class="meta">Установка: <code>${htmlEscape(installSpec)}</code></p>
        </div>
      </article>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(marketTitle)}</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --card:#1c1f26; --line:#2a2f3a; --text:#e6e8ee; --muted:#9aa3b2; --accent:#7aa2ff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:48px 20px 72px; background:var(--bg); color:var(--text); font:16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  .lead { color: var(--muted); margin: 0 0 28px; }
  .howto { background: var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 20px; margin: 0 0 28px; }
  .howto ol { margin: 8px 0 0; padding-left: 20px; }
  .howto code { word-break: break-all; }
  .card { display:flex; gap:16px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin: 0 0 14px; }
  .icon { width:44px; height:44px; flex:0 0 44px; border-radius:10px; object-fit:contain; background:#0f1115; }
  .icon-placeholder { background:#242833; }
  .body { min-width: 0; }
  h2 { font-size: 18px; margin: 0 0 6px; }
  .alt { color: var(--muted); font-size: 13px; font-weight: 400; }
  .body p { margin: 0 0 6px; color: var(--muted); }
  .meta { font-size: 13px; }
  code { font: 12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); background:#0f1115; border:1px solid var(--line); border-radius:6px; padding:1px 5px; }
  footer { margin-top: 32px; color: var(--muted); font-size: 13px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${htmlEscape(marketTitle)}</h1>
  <p class="lead">${htmlEscape(marketDescription)}</p>
  <section class="howto">
    <strong>Как поставить плагины</strong>
    <ol>
      <li>В DSH включите экспериментальный бандл <em>Custom plugin market</em> (Plugins → More рядом с «Experimental plugins»).</li>
      <li>Plugins → <em>Discover</em> → <em>Add index source</em> и вставьте <code>${htmlEscape(indexUrl)}</code>.</li>
      <li>Выберите плагин и нажмите <em>Install</em> — DSH покажет версию, источник и коммит.</li>
    </ol>
    <p>Командная строка для ручной установки: <code>dsh plugin --profile &lt;profile&gt; add &lt;spec&gt;</code>, spec указан в карточке.</p>
  </section>
${cards}
  <footer>Индекс: <a href="index.json">index.json</a> · исходники: <a href="${htmlEscape(repoUrl)}">${htmlEscape(repoUrl)}</a></footer>
</main>
</body>
</html>
`
}

if (errors.length) {
  printProblems()
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s) — index NOT written`)
  process.exit(1)
}

if (checkOnly) {
  printProblems()
  console.log(`OK: ${index.plugins.length} plugin(s): ${index.plugins.map((plugin) => plugin.name).join(', ')}`)
  process.exit(0)
}

fs.mkdirSync(iconsDir, { recursive: true })
for (const file of fs.readdirSync(iconsDir)) {
  if (!usedIconFiles.has(file)) fs.rmSync(path.join(iconsDir, file), { force: true })
}
for (const [fileName, source] of usedIconFiles) {
  fs.copyFileSync(source, path.join(iconsDir, fileName))
}
fs.writeFileSync(path.join(siteDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
fs.writeFileSync(path.join(siteDir, 'index.html'), renderHtml(), 'utf8')
fs.writeFileSync(path.join(siteDir, '.nojekyll'), '', 'utf8')

printProblems()
console.log(`\nindex written: ${path.relative(root, path.join(siteDir, 'index.json'))}`)
console.log(`index URL:     ${indexUrl}`)
console.log('plugins:')
for (const plugin of index.plugins) {
  const version = plugin.versions[0]
  console.log(
    `  - ${plugin.name}@${version.version}  (${version.source.type}` +
      `${version.source.type === 'git' ? `, ${version.source.commit.slice(0, 12)}` : ''})`,
  )
}
