import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
export interface ServiceOptions {
  name: string
  configDir: string
  platform?: NodeJS.Platform
  home?: string
  executable?: string
  execute?: (file: string, args: string[]) => void
  uid?: number
  findTool?: (tool: string) => string | null
  report?: (message: string) => void
}
const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'"
const unit = (s: string) =>
  '"' +
  s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') +
  '"'
export function servicePath(
  findTool: (tool: string) => string | null = (tool) => Bun.which(tool),
) {
  const dirs = ['node', 'bun', 'git'].flatMap((tool) => {
    const path = findTool(tool)
    if (!path) return []
    if (!isAbsolute(path) || /[:\r\n\0]/.test(path))
      throw Error(
        'Tool path must be absolute and contain no PATH separators or control characters',
      )
    return [dirname(path)]
  })
  // Preserve the resolved tool precedence, without unrelated installer paths.
  return [...new Set([...dirs, '/usr/bin', '/bin'])].join(':')
}

export function servicePlan(opts: ServiceOptions) {
  if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(opts.name))
    throw Error('Invalid runner name')
  if (
    [opts.configDir, opts.home ?? '', opts.executable ?? ''].some((s) =>
      /[\r\n\0]/.test(s),
    )
  )
    throw Error('Service paths must not contain control characters')
  const platform = opts.platform ?? process.platform,
    home = opts.home ?? homedir(),
    exe = resolve(opts.executable ?? process.execPath),
    root = resolve(opts.configDir),
    id = 'gild.runner.' + opts.name
  // Source-mode invocations need Bun + the CLI entry. Compiled installations
  // use the executable alone. Credentials stay in the private config file.
  const command = [
    exe,
    ...(exe === process.execPath && /(?:^|[\\/])bun(?:\.exe)?$/.test(exe)
      ? [resolve(import.meta.dir, 'gild.ts')]
      : []),
    'runner',
    'start',
    '--name',
    opts.name,
    '--config-dir',
    root,
  ]
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', id + '.plist'),
      domain = 'gui/' + (opts.uid ?? process.getuid!())
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(id)}</string><key>ProgramArguments</key><array>${command.map((x) => `<string>${xml(x)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${xml(home)}</string><key>StandardOutPath</key><string>${xml(join(root, 'runners', opts.name + '.service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'runners', opts.name + '.service.log'))}</string></dict></plist>\n`
    return {
      platform,
      file,
      content,
      install: ['launchctl', 'bootstrap', domain, file],
      uninstall: ['launchctl', 'bootout', domain + '/' + id],
      status: ['launchctl', 'print', domain + '/' + id],
    }
  }
  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', id + '.service')
    const content = `[Unit]\nDescription=Gild runner ${opts.name}\nAfter=network-online.target\n\n[Service]\nEnvironment=${unit('PATH=' + servicePath(opts.findTool))}\nExecStart=${command.map(unit).join(' ')}\nWorkingDirectory=${unit(home)}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`
    return {
      platform,
      file,
      content,
      install: ['systemctl', '--user', 'enable', '--now', id + '.service'],
      uninstall: ['systemctl', '--user', 'disable', '--now', id + '.service'],
      status: ['systemctl', '--user', 'status', id + '.service'],
    }
  }
  if (platform === 'win32') {
    const file = join(root, 'runners', id + '.exe')
    // A real SCM host is required: registering the CLI console process with
    // sc.exe would fail service startup (1053). The host starts that process
    // under the chosen user, so it can read their existing runner config.
    const esc = (s: string) => JSON.stringify(s),
      args = command
        .slice(1)
        .map((x) => '"' + x.replaceAll('"', '\\"') + '"')
        .join(' ')
    const source = `using System;using System.Diagnostics;using System.ServiceProcess;public class GildRunnerService:ServiceBase {Process child;public GildRunnerService(){ServiceName=${esc(id)};}protected override void OnStart(string[] a){child=Process.Start(new ProcessStartInfo(${esc(command[0])},${esc(args)}){UseShellExecute=false,WorkingDirectory=${esc(home)}});child.EnableRaisingEvents=true;child.Exited+=(sender,e)=>Environment.Exit(1);}protected override void OnStop(){if(child!=null&&!child.HasExited){Process.Start(new ProcessStartInfo("taskkill.exe", "/PID "+child.Id+" /T /F"){UseShellExecute=false,CreateNoWindow=true}).WaitForExit();child.WaitForExit();}}public static void Main(){ServiceBase.Run(new GildRunnerService());}}`
    const install = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${ps(source)} -ReferencedAssemblies System.ServiceProcess -OutputAssembly ${ps(file)} -OutputType WindowsApplication; $credential=Get-Credential -UserName ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -Message 'Runner service account'; New-Service -Name ${ps(id)} -BinaryPathName ${ps('"' + file + '"')} -DisplayName ${ps('Gild runner ' + opts.name)} -StartupType Automatic -Credential $credential; sc.exe failure ${ps(id)} reset= 86400 actions= restart/5000; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; Start-Service -Name ${ps(id)}`
    return {
      platform,
      file,
      content: '',
      install: ['powershell.exe', '-NoProfile', '-Command', install],
      uninstall: [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `Stop-Service -Name ${ps(id)} -ErrorAction SilentlyContinue; sc.exe delete ${ps(id)}; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`,
      ],
      status: [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        `Get-Service -Name ${ps(id)} | Format-List Name,Status,StartType`,
      ],
    }
  }
  throw Error('Services support macOS, Linux and Windows')
}
export async function runnerService(
  action: 'install' | 'uninstall' | 'status',
  opts: ServiceOptions,
) {
  const plan = servicePlan(opts),
    execute =
      opts.execute ??
      ((file, args) => {
        execFileSync(file, args, { stdio: 'inherit' })
      })
  const report = opts.report ?? console.log
  if (action === 'install') {
    await mkdir(join(plan.file, '..'), { recursive: true })
    if (existsSync(plan.file))
      throw Error('Service definition already exists; uninstall it first')
    if (plan.content)
      await writeFile(plan.file, plan.content, { mode: 0o600, flag: 'wx' })
    try {
      if (plan.platform === 'linux')
        execute('systemctl', ['--user', 'daemon-reload'])
      execute(plan.install[0], plan.install.slice(1))
    } catch (error) {
      // Roll back only the definition created by this invocation. Manager
      // cleanup is best effort; its failure must not prevent file cleanup.
      try {
        execute(plan.uninstall[0], plan.uninstall.slice(1))
      } catch {}
      await rm(plan.file, { force: true })
      if (plan.platform === 'linux') {
        try {
          execute('systemctl', ['--user', 'daemon-reload'])
        } catch {}
      }
      throw Error(
        'Service install failed; the written definition was removed',
        { cause: error },
      )
    }
    if (plan.platform === 'linux')
      report(
        'To keep the runner running after logout and start at boot, run `loginctl enable-linger` as this service user (subject to system policy).',
      )
  } else if (action === 'uninstall') {
    let failure: unknown
    let removed = false
    try {
      execute(plan.uninstall[0], plan.uninstall.slice(1))
    } catch (error) {
      failure = error
    }
    try {
      await rm(plan.file, { force: true })
      removed = true
      if (plan.platform === 'linux')
        execute('systemctl', ['--user', 'daemon-reload'])
    } catch (error) {
      failure ??= error
    } finally {
      report(
        `Runner config remains at ${join(resolve(opts.configDir), 'runners', opts.name + '.json')}, including its gro_/gr_ token. Run \`gild runner remove ${opts.name}\` with the same --config-dir to revoke the runner and delete that config.`,
      )
    }
    if (failure)
      throw Error(
        removed
          ? 'Service manager command failed; the service definition was removed. Check service status before reinstalling.'
          : 'Service uninstall failed; the service definition could not be removed.',
        { cause: failure },
      )
  } else execute(plan.status[0], plan.status.slice(1))
  return plan.file
}
