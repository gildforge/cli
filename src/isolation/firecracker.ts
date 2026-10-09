// Linux backend: one Firecracker microVM per job.
// Rootfs is shared and read-only; the job work directory is packed into a
// per-VM ext4 image attached as a second drive, so the base image is never
// written and nothing of the host is visible to the guest.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net'
import { tmpdir } from 'node:os'
import {
  mkdir,
  mkdtemp,
  open as openFile,
  rm,
  truncate,
  readFile,
} from 'node:fs/promises'
import { existsSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { bootNetArgs, networkState, planNetwork } from './network'
import {
  checkGuestProtocol,
  guestExec,
  guestFiles,
  guestPing,
  guestPty,
  readOneMessage,
  guestPut,
  GuestProtocolError,
  type Channel,
  type Isolation,
  type Opener,
} from './session'

export interface FirecrackerConfig {
  firecracker: string
  kernel: string
  /** Read-only base image containing gild-guest-agent and /init-gild.sh. */
  rootfs: string
  memoryMiB: number
  vcpus: number
  /** Guest vsock port the agent listens on. */
  port: number
  /** `block` = no network device; `allow` = tap or refuse; `auto` = tap when set up, else none. */
  egress: 'auto' | 'block' | 'allow'
}

export const GUEST_WORK = '/workspace'

export function firecrackerAvailable(
  c: Pick<FirecrackerConfig, 'firecracker' | 'kernel' | 'rootfs'>,
) {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
    accessSync(c.kernel, constants.R_OK)
    accessSync(c.rootfs, constants.R_OK)
    execFileSync(c.firecracker, ['--version'], { stdio: 'ignore' })
    execFileSync('mke2fs', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Minimal HTTP/1.1 over the API unix socket (Bun's node:http lacks socketPath).
function api(socket: string, method: string, path: string, body: unknown) {
  return new Promise<void>((resolve, reject) => {
    const data = JSON.stringify(body)
    const sock = createConnection(socket)
    let text = ''
    sock.on('error', reject)
    sock.on('connect', () =>
      sock.write(
        `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`,
      ),
    )
    let done = false
    const finish = () => {
      if (done) return
      done = true
      sock.destroy()
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 500)
      if (status < 300) resolve()
      else
        reject(
          new Error(`firecracker ${method} ${path}: ${text.slice(0, 300)}`),
        )
    }
    // Firecracker answers 204 without closing: the header block is the reply.
    sock.on('data', (c) => {
      text += c
      if (text.includes('\r\n\r\n')) finish()
    })
    sock.on('close', finish)
  })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function vsockChannel(uds: string, port: number): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createConnection(uds)
    let head = Buffer.alloc(0),
      ready = false,
      dataCb: (c: Buffer) => void = () => {},
      closeCb: (e?: Error) => void = () => {}
    const channel: Channel = {
      write: (d) => void sock.write(d),
      onData: (cb) => (dataCb = cb),
      onClose: (cb) => (closeCb = cb),
      close: () => sock.destroy(),
    }
    sock.on('error', (e) => (ready ? closeCb(e) : reject(e)))
    sock.on('close', () =>
      ready ? closeCb() : reject(new Error('vsock closed')),
    )
    sock.on('connect', () => sock.write(`CONNECT ${port}\n`))
    sock.on('data', (chunk) => {
      if (ready) return dataCb(chunk)
      head = Buffer.concat([head, chunk])
      const nl = head.indexOf('\n')
      if (nl < 0) return
      if (!head.subarray(0, nl).toString().startsWith('OK'))
        return reject(new Error('vsock refused: ' + head.subarray(0, nl)))
      ready = true
      resolve(channel)
      const rest = head.subarray(nl + 1)
      if (rest.length) dataCb(rest)
    })
  })
}

export interface BootTimings {
  imageMs: number
  bootToAgentMs: number
}

export async function startFirecracker(
  cfg: FirecrackerConfig,
  work: string,
  vmDir: string,
  log: (line: string) => void = () => {},
): Promise<Isolation & { timings: BootTimings; pid: number }> {
  await mkdir(vmDir, { recursive: true, mode: 0o700 })
  // Unix socket paths are limited to ~108 bytes, so they live in a short dir.
  const sockDir = await mkdtemp(join(tmpdir(), 'gf-'))
  const apiSock = join(sockDir, 'a'),
    uds = join(sockDir, 'v'),
    image = join(vmDir, 'work.ext4')
  // Pack the checkout into a fresh ext4 image (no root needed).
  const t0 = Date.now()
  const used = Number(
    execFileSync('du', ['-sk', work], { encoding: 'utf8' }).split(/\s+/)[0],
  )
  const sizeMiB = Math.max(256, Math.ceil((used * 2) / 1024) + 128)
  await (await openFile(image, 'w', 0o600)).close()
  await truncate(image, sizeMiB << 20)
  execFileSync('mke2fs', ['-q', '-t', 'ext4', '-d', work, '-F', image], {
    stdio: 'ignore',
  })
  const timings: BootTimings = { imageMs: Date.now() - t0, bootToAgentMs: 0 }

  const plan = planNetwork(
    cfg.egress,
    networkState(),
    join(tmpdir(), `gild-vm-slots-${process.getuid?.() ?? 0}`),
  )
  log(plan.note)
  const serial = await openFile(join(vmDir, 'serial.log'), 'w', 0o600)
  const fc: ChildProcess = spawn(cfg.firecracker, ['--api-sock', apiSock], {
    stdio: ['ignore', serial.fd, serial.fd],
  })
  const listeners: Server[] = []
  const kill = () => {
    try {
      fc.kill('SIGKILL')
    } catch {}
    plan.release()
  }
  try {
    for (let i = 0; i < 2500 && !existsSync(apiSock); i++) await wait(2)
    await api(apiSock, 'PUT', '/machine-config', {
      vcpu_count: cfg.vcpus,
      mem_size_mib: cfg.memoryMiB,
      smt: false,
    })
    await api(apiSock, 'PUT', '/boot-source', {
      kernel_image_path: cfg.kernel,
      // i8042 flags skip a 500 ms keyboard probe; measured 1.2 s -> 0.3 s boot.
      boot_args:
        'console=ttyS0 reboot=k panic=1 pci=off init=/init-gild.sh i8042.noaux i8042.nokbd i8042.nopnp i8042.dumbkbd quiet loglevel=1' +
        (plan.net ? ' ' + bootNetArgs(plan.net) : ''),
    })
    await api(apiSock, 'PUT', '/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: cfg.rootfs,
      is_root_device: true,
      is_read_only: true,
    })
    await api(apiSock, 'PUT', '/drives/work', {
      drive_id: 'work',
      path_on_host: image,
      is_root_device: false,
      is_read_only: false,
    })
    await api(apiSock, 'PUT', '/vsock', {
      vsock_id: 'vsock0',
      guest_cid: 3,
      uds_path: uds,
    })
    if (plan.net)
      await api(apiSock, 'PUT', '/network-interfaces/eth0', {
        iface_id: 'eth0',
        guest_mac: plan.net.mac,
        host_dev_name: plan.net.tap,
      })
    const t1 = Date.now()
    await api(apiSock, 'PUT', '/actions', { action_type: 'InstanceStart' })
    const open: Opener = () => vsockChannel(uds, cfg.port)
    for (;;) {
      try {
        checkGuestProtocol(await guestPing(open), cfg.rootfs)
        break
      } catch (e) {
        if (e instanceof GuestProtocolError) throw e
        if (Date.now() - t1 > 20_000)
          throw new Error(
            'microVM agent did not come up: ' + (e as Error).message,
          )
        if (fc.exitCode !== null)
          throw new Error(
            'firecracker exited: ' +
              (await readFile(join(vmDir, 'serial.log'), 'utf8')).slice(-400),
          )
        await wait(5)
      }
    }
    timings.bootToAgentMs = Date.now() - t1
    log(
      `microVM ready in ${timings.bootToAgentMs} ms (image ${timings.imageMs} ms)`,
    )
    return {
      level: 'vm',
      backend: 'firecracker',
      label: 'vm (firecracker)',
      timings,
      pid: fc.pid!,
      guestPath: (p) =>
        p === work
          ? GUEST_WORK
          : p.startsWith(work + '/')
            ? GUEST_WORK + p.slice(work.length)
            : p,
      put: (p, content, mode) =>
        guestPut(
          open,
          p === work || p.startsWith(work + '/')
            ? GUEST_WORK + p.slice(work.length)
            : p,
          content,
          mode,
        ),
      exec: (argv, o) => guestExec(open, argv, o),
      pty: (request) => guestPty(open, request),
      files: guestFiles(open),
      onGuestMessage: (port, handler) => {
        // Firecracker maps a guest connection to host port N onto <uds>_N.
        const server = createServer((c) => {
          void readOneMessage(c)
            .then(handler, () => {})
            .finally(() => c.destroy())
        })
        server.listen(`${uds}_${port}`)
        listeners.push(server)
      },
      close: async () => {
        for (const l of listeners) l.close()
        kill()
        await serial.close()
        await rm(sockDir, { recursive: true, force: true })
        await rm(vmDir, { recursive: true, force: true })
      },
    }
  } catch (e) {
    kill()
    await serial.close().catch(() => {})
    await rm(sockDir, { recursive: true, force: true })
    throw e
  }
}
