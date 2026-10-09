// gild-vz: the macOS `vm` backend's launcher (Virtualization.framework).
//
// One process per microVM. It boots a Linux kernel with a copy-on-write root
// disk, an optional virtio-fs share and optional NAT, then exposes the guest's
// virtio-vsock on a unix socket using Firecracker's protocol, so the CLI's
// guest exec contract (src/isolation/session.ts) is reused unchanged:
//   host -> guest: connect to <vsock>, write "CONNECT <port>\n", read "OK <port>\n", then raw bytes;
//   guest -> host: a guest connection to host port N is relayed to the unix socket <vsock>_N
//                  (only ports named with --listen).
// The VM stops when stdin closes, on SIGTERM/SIGINT, or when the guest powers off.
//
//   gild-vz check                 entitlement + host support; prints "ok" and exits 0
//   gild-vz clone <src> <dst>     APFS clonefile (copy-on-write) of a file or a whole directory tree
//   gild-vz run --kernel K --rootfs R --cmdline C --vsock SOCK --serial LOG
//               [--cpus N] [--memory MiB] [--share TAG=DIR] [--net none|nat] [--listen PORT]...
//
// Built and ad-hoc signed with the com.apple.security.virtualization
// entitlement by scripts/build-vz-helper.sh; no developer identity needed.
import Darwin
import Foundation
import Security
import Virtualization

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

func die(_ message: String, _ code: Int32 = 2) -> Never {
  FileHandle.standardError.write(("gild-vz: " + message + "\n").data(using: .utf8)!)
  exit(code)
}

func hasEntitlement() -> Bool {
  guard let task = SecTaskCreateFromSelf(nil) else { return false }
  let value = SecTaskCopyValueForEntitlement(
    task, "com.apple.security.virtualization" as CFString, nil)
  return (value as? Bool) == true
}

// MARK: byte bridging between a unix socket and a vsock connection

/// Live bridges, so the VZVirtioSocketConnection objects (which own their fd) stay alive.
final class Bridges {
  private var live: [ObjectIdentifier: AnyObject] = [:]
  private let lock = NSLock()
  func keep(_ o: AnyObject) { lock.lock(); live[ObjectIdentifier(o)] = o; lock.unlock() }
  func drop(_ o: AnyObject) { lock.lock(); live[ObjectIdentifier(o)] = nil; lock.unlock() }
}
let bridges = Bridges()

func writeAll(_ fd: Int32, _ buf: UnsafeRawPointer, _ n: Int) -> Bool {
  var off = 0
  while off < n {
    let w = write(fd, buf + off, n - off)
    if w < 0 { if errno == EINTR { continue }; return false }
    off += w
  }
  return true
}

/// Copy a -> b until EOF or error, then half-close b.
func pump(_ a: Int32, _ b: Int32) {
  let size = 64 * 1024
  let buf = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 1)
  defer { buf.deallocate() }
  while true {
    let r = read(a, buf, size)
    if r < 0 && errno == EINTR { continue }
    if r <= 0 || !writeAll(b, buf, r) { break }
  }
  shutdown(b, SHUT_WR)
}

/// Runs both directions; when both have ended, closes the unix fd and the vsock connection.
func bridge(_ unixFd: Int32, _ conn: VZVirtioSocketConnection) {
  bridges.keep(conn)
  let vfd = conn.fileDescriptor
  let group = DispatchGroup()
  for (a, b) in [(unixFd, vfd), (vfd, unixFd)] {
    group.enter()
    Thread.detachNewThread { pump(a, b); group.leave() }
  }
  group.notify(queue: .main) {
    close(unixFd)
    conn.close()
    bridges.drop(conn)
  }
}

// MARK: unix sockets

func unixAddress(_ path: String) -> sockaddr_un {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  if bytes.count >= MemoryLayout.size(ofValue: addr.sun_path) { die("socket path too long: \(path)") }
  withUnsafeMutableBytes(of: &addr.sun_path) { dst in
    for (i, c) in bytes.enumerated() { dst[i] = c }
  }
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  return addr
}

func unixListen(_ path: String) -> Int32 {
  unlink(path)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = unixAddress(path)
  let ok = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if ok != 0 || listen(fd, 64) != 0 { die("listen \(path): \(String(cString: strerror(errno)))") }
  chmod(path, 0o600)
  return fd
}

func unixConnect(_ path: String) -> Int32? {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = unixAddress(path)
  let ok = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if ok != 0 { close(fd); return nil }
  return fd
}

/// Reads "CONNECT <port>\n" byte by byte so no payload byte is consumed.
func readConnect(_ fd: Int32) -> UInt32? {
  var line = [UInt8]()
  var c: UInt8 = 0
  while line.count < 64 {
    if read(fd, &c, 1) != 1 { return nil }
    if c == 10 { break }
    line.append(c)
  }
  let text = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespaces)
  guard text.hasPrefix("CONNECT "), let port = UInt32(text.dropFirst(8)) else { return nil }
  return port
}

// MARK: the VM

struct Options {
  var kernel = "", rootfs = "", cmdline = "", vsock = "", serial = ""
  var cpus = 2, memoryMiB: UInt64 = 1024, net = "none"
  var share: (tag: String, dir: String)?
  var listen: [UInt32] = []
}

func parse(_ args: [String]) -> Options {
  var o = Options()
  var i = 0
  func value() -> String {
    i += 1
    if i >= args.count { die("\(args[i - 1]) needs a value") }
    return args[i]
  }
  while i < args.count {
    switch args[i] {
    case "--kernel": o.kernel = value()
    case "--rootfs": o.rootfs = value()
    case "--cmdline": o.cmdline = value()
    case "--vsock": o.vsock = value()
    case "--serial": o.serial = value()
    case "--cpus": o.cpus = Int(value()) ?? 0
    case "--memory": o.memoryMiB = UInt64(value()) ?? 0
    case "--net": o.net = value()
    case "--listen":
      guard let p = UInt32(value()) else { die("--listen needs a port number") }
      o.listen.append(p)
    case "--share":
      let v = value()
      guard let eq = v.firstIndex(of: "=") else { die("--share needs TAG=DIR") }
      o.share = (String(v[..<eq]), String(v[v.index(after: eq)...]))
    default: die("unknown option \(args[i])")
    }
    i += 1
  }
  for (name, v) in [("--kernel", o.kernel), ("--rootfs", o.rootfs), ("--vsock", o.vsock), ("--serial", o.serial)]
  where v.isEmpty { die("\(name) is required") }
  if o.net != "none" && o.net != "nat" { die("--net is none or nat") }
  return o
}

final class Machine: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
  let o: Options
  var vm: VZVirtualMachine!
  var device: VZVirtioSocketDevice!
  let listener = VZVirtioSocketListener()
  var stopping = false

  init(_ o: Options) { self.o = o }

  func configuration() throws -> VZVirtualMachineConfiguration {
    let c = VZVirtualMachineConfiguration()
    let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: o.kernel))
    boot.commandLine = o.cmdline
    c.bootLoader = boot
    c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                     min(o.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    c.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize, o.memoryMiB << 20)
    // The root disk is the caller's per-VM clone; the base image is never attached.
    let disk = try VZDiskImageStorageDeviceAttachment(
      url: URL(fileURLWithPath: o.rootfs), readOnly: false)
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
    FileManager.default.createFile(atPath: o.serial, contents: nil, attributes: [.posixPermissions: 0o600])
    guard let out = FileHandle(forWritingAtPath: o.serial),
      let input = FileHandle(forReadingAtPath: "/dev/null")
    else { throw NSError(domain: "gild-vz", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot open \(o.serial)"]) }
    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: input, fileHandleForWriting: out)
    c.serialPorts = [console]
    c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    if let s = o.share {
      let fs = VZVirtioFileSystemDeviceConfiguration(tag: s.tag)
      fs.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: s.dir), readOnly: false))
      c.directorySharingDevices = [fs]
    }
    if o.net == "nat" {
      let n = VZVirtioNetworkDeviceConfiguration()
      n.attachment = VZNATNetworkDeviceAttachment()
      n.macAddress = VZMACAddress.randomLocallyAdministered()
      c.networkDevices = [n]
    }
    try c.validate()
    return c
  }

  func start() {
    let t0 = Date()
    do {
      vm = VZVirtualMachine(configuration: try configuration())
    } catch { die("configuration: \(error.localizedDescription)") }
    vm.delegate = self
    device = vm.socketDevices.first as? VZVirtioSocketDevice
    listener.delegate = self
    for p in o.listen { device.setSocketListener(listener, forPort: p) }
    let server = unixListen(o.vsock)
    Thread.detachNewThread { self.accept(server) }
    vm.start { result in
      switch result {
      case .success: print("started \(Int(Date().timeIntervalSince(t0) * 1000))")
      case .failure(let e): die("start: \(e.localizedDescription)", 1)
      }
    }
  }

  func accept(_ server: Int32) {
    while true {
      let fd = Darwin.accept(server, nil, nil)
      if fd < 0 { if errno == EINTR { continue }; return }
      Thread.detachNewThread {
        guard let port = readConnect(fd) else { close(fd); return }
        DispatchQueue.main.async {
          self.device.connect(toPort: port) { result in
            switch result {
            case .success(let conn):
              let ok = Array("OK \(port)\n".utf8)
              if writeAll(fd, ok, ok.count) { bridge(fd, conn) } else { close(fd); conn.close() }
            case .failure:
              close(fd)
            }
          }
        }
      }
    }
  }

  // Guest -> host: relay to <vsock>_<port> when something listens there.
  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                from socketDevice: VZVirtioSocketDevice) -> Bool {
    guard let fd = unixConnect("\(o.vsock)_\(connection.destinationPort)") else { return false }
    bridge(fd, connection)
    return true
  }

  func stop(_ code: Int32) {
    if stopping { return }
    stopping = true
    unlink(o.vsock)
    if vm.canStop {
      vm.stop { _ in exit(code) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(code) }
    } else { exit(code) }
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) { unlink(o.vsock); exit(0) }
  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    die("stopped: \(error.localizedDescription)", 1)
  }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "check":
  if !hasEntitlement() { die("missing com.apple.security.virtualization entitlement (run scripts/build-vz-helper.sh)", 1) }
  if !VZVirtualMachine.isSupported { die("Virtualization.framework is not supported on this host", 1) }
  print("ok")
  exit(0)
case "clone":
  guard args.count == 3 else { die("usage: gild-vz clone <src> <dst>") }
  if clonefile(args[1], args[2], UInt32(CLONE_NOFOLLOW)) != 0 {
    die("clone \(args[1]): \(String(cString: strerror(errno)))", 1)
  }
  exit(0)
case "run":
  let machine = Machine(parse(Array(args.dropFirst())))
  var sources: [DispatchSourceSignal] = []
  for s in [SIGTERM, SIGINT, SIGHUP] {
    signal(s, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: s, queue: .main)
    src.setEventHandler { machine.stop(0) }
    src.resume()
    sources.append(src)
  }
  // The CLI holds our stdin: when it goes away, so does the VM.
  Thread.detachNewThread {
    var b: UInt8 = 0
    while read(0, &b, 1) > 0 {}
    DispatchQueue.main.async { machine.stop(0) }
  }
  DispatchQueue.main.async { machine.start() }
  withExtendedLifetime(sources) { dispatchMain() }
default:
  die("usage: gild-vz check | clone <src> <dst> | run --kernel K --rootfs R --cmdline C --vsock SOCK --serial LOG [...]")
}
