import { existsSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const fail = (message) => {
  console.error('validate-manifest: ' + message)
  process.exit(1)
}

if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) fail('missing dsh.bundle.patch')
if (!existsSync(pkg.dsh.bundle.patch)) fail('patch file not found: ' + pkg.dsh.bundle.patch)
if (!pkg.dsh.client || pkg.dsh.client.platform !== 'web') fail('missing dsh.client.platform = web')
if (!pkg.exports || !pkg.exports['.'] || !pkg.exports['./client']) fail('exports must expose "." and "./client"')
for (const artifact of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/client.d.ts']) {
  if (!existsSync(artifact)) fail('missing build artifact: ' + artifact + ' (run npm run build)')
}
if (!pkg.peerDependencies || !pkg.peerDependencies.react) fail('missing react peer dependency')
console.log('manifest OK: ' + pkg.name + '@' + pkg.version)
