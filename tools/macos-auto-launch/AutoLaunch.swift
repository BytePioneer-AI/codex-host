import AppKit
import OSLog

struct Configuration: Decodable {
    var bundleIdentifiers: [String] = ["com.openai.codex"]
    var launcherPath = "/Applications/codexhost.app/Contents/MacOS/codexhost"
    var dataDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/codexhost/auto-launch").path
    var fixture = false
}

@MainActor
final class AutoInject: NSObject {
    private let configuration: Configuration
    private let workspace = NSWorkspace.shared
    private let logger = Logger(subsystem: "ai.bytepioneer.codexhost.auto-launch", category: "launch")
    private var seen: Set<pid_t> = []
    private var launcher: Process?
    private var lastFailure: Date?
    private let directory: URL

    init(configuration: Configuration) throws {
        self.configuration = configuration
        directory = URL(fileURLWithPath: configuration.dataDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        super.init()
    }

    func start() {
        // Installing/restarting the listener must never interrupt an existing chat.
        seen = Set(workspace.runningApplications.filter(isTarget).map(\.processIdentifier))
        let center = workspace.notificationCenter
        center.addObserver(self, selector: #selector(applicationStarted(_:)),
                           name: NSWorkspace.willLaunchApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(applicationStarted(_:)),
                           name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(applicationStopped(_:)),
                           name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        event("listening", detail: "Existing app processes left untouched: \(seen.sorted())")
    }

    private func isTarget(_ application: NSRunningApplication) -> Bool {
        guard let identifier = application.bundleIdentifier,
              configuration.bundleIdentifiers.contains(identifier),
              let bundle = application.bundleURL else { return false }
        // The unified Electron Codex/ChatGPT app is supported; unrelated native
        // ChatGPT apps are deliberately excluded.
        return configuration.fixture || FileManager.default.fileExists(
            atPath: bundle.appendingPathComponent("Contents/Resources/app.asar").path)
    }

    @objc private func applicationStarted(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication,
              isTarget(application), application.processIdentifier > 0,
              seen.insert(application.processIdentifier).inserted else { return }
        let pid = application.processIdentifier
        event("detected", pid: pid)
        Task {
            // Give LaunchServices a moment to finish recording the process.
            try? await Task.sleep(for: .milliseconds(100))
            await consider(application)
        }
    }

    @objc private func applicationStopped(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else { return }
        seen.remove(application.processIdentifier)
    }

    private func consider(_ application: NSRunningApplication) async {
        let pid = application.processIdentifier
        guard !application.isTerminated else { return }
        if launcher?.isRunning == true {
            if processArguments(pid).contains("--remote-debugging-port=") {
                event("already-controlled", pid: pid, detail: "Started by this listener")
                return
            }
            // A fast quit/reopen can overlap the old supervisor's cleanup.
            // Do not mistake that freshly opened original app for a managed one.
            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(100))
                guard !application.isTerminated else { return }
                if launcher?.isRunning != true { break }
            }
            if launcher?.isRunning == true {
                event("skipped", pid: pid, detail: "Previous supervisor is still cleaning up")
                return
            }
        }
        // A manually launched codexhost has not necessarily published its
        // runtime descriptor yet. Check the live launcher, not just its file.
        if liveExternalLauncher() {
            if processArguments(pid).contains("--remote-debugging-port=") {
                event("already-controlled", pid: pid, detail: "Existing codexhost launcher")
                return
            }
            // The previous controlled app may have just quit, leaving its
            // launcher briefly alive. Wait for cleanup before taking over.
            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(100))
                guard !application.isTerminated else { return }
                if !liveExternalLauncher() { break }
            }
            if liveExternalLauncher() {
                event("skipped", pid: pid, detail: "Another codexhost launch is in progress")
                return
            }
        }
        // A second app installation must not cause an existing session to close.
        if workspace.runningApplications.contains(where: {
            isTarget($0) && $0.processIdentifier != pid && !$0.isTerminated
        }) {
            event("skipped", pid: pid, detail: "Another Codex/ChatGPT instance is already running")
            return
        }
        // Never take over an app that has been open long enough to be in use.
        if let date = application.launchDate, Date().timeIntervalSince(date) > 8 {
            event("skipped", pid: pid, detail: "Launch notification arrived too late")
            return
        }
        if let lastFailure, Date().timeIntervalSince(lastFailure) < 30 {
            event("skipped", pid: pid, detail: "Recent launch failure; avoiding a restart loop")
            return
        }
        guard FileManager.default.isExecutableFile(atPath: configuration.launcherPath) else {
            event("error", pid: pid, detail: "codexhost executable is missing; app left untouched")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: configuration.launcherPath)
        process.arguments = ["launch"]
        var environment = ProcessInfo.processInfo.environment
        // This documented launcher switch disables all automatic console opens.
        environment["CODEXHOST_CONSOLE"] = "0"
        if let bundle = application.bundleURL {
            environment["CODEXHOST_INSTALL_ROOT"] = bundle.path
        }
        process.environment = environment
        let logURL = directory.appendingPathComponent("launcher.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        do {
            let output = try FileHandle(forWritingTo: logURL)
            try output.seekToEnd()
            process.standardOutput = output
            process.standardError = output
            try process.run()
            // Keep the Process alive for its supervisor lifetime. A separate
            // task observes exit; the listener itself remains event-driven.
            launcher = process
            event("handoff", pid: pid, detail: "Silent codexhost launch PID \(process.processIdentifier)")
            Task {
                while process.isRunning {
                    try? await Task.sleep(for: .seconds(1))
                }
                try? output.close()
                if process.terminationStatus != 0 {
                    lastFailure = Date()
                    event("error", detail: "codexhost exited with status \(process.terminationStatus); no automatic retry")
                } else {
                    event("launcher-exited", detail: "Controlled app session ended")
                }
                if launcher === process { launcher = nil }
            }
        } catch {
            lastFailure = Date()
            event("error", pid: pid, detail: "Unable to start codexhost: \(error.localizedDescription)")
        }
    }

    private func capture(_ arguments: [String]) -> String {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return "" }
            return String(decoding: data, as: UTF8.self)
        } catch { return "" }
    }

    private func processArguments(_ pid: pid_t) -> String {
        capture(["-p", String(pid), "-o", "args="]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func liveExternalLauncher() -> Bool {
        let rows = capture(["-axo", "pid=,comm="]).split(separator: "\n")
        for row in rows {
            let fields = row.split(maxSplits: 1, whereSeparator: \.isWhitespace)
            guard fields.count == 2, fields[1] == configuration.launcherPath,
                  let pid = pid_t(fields[0]), pid != ProcessInfo.processInfo.processIdentifier else { continue }
            let arguments = processArguments(pid)
            // `console`, `broker`, and read-only CLI commands are not supervisors.
            if arguments == configuration.launcherPath ||
                arguments == configuration.launcherPath + " launch" ||
                arguments.hasPrefix(configuration.launcherPath + " launch ") {
                return true
            }
        }
        return false
    }

    private func event(_ name: String, pid: pid_t? = nil, detail: String = "") {
        logger.notice("\(name, privacy: .public) pid=\(pid ?? 0) \(detail, privacy: .public)")
        let record: [String: Any] = [
            "time": ISO8601DateFormatter().string(from: Date()),
            "event": name, "pid": pid ?? 0, "detail": detail
        ]
        guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        data.append(0x0a)
        let url = directory.appendingPathComponent("events.jsonl")
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        if let size = attributes?[.size] as? NSNumber, size.intValue > 1_048_576 {
            let previous = directory.appendingPathComponent("events.previous.jsonl")
            try? FileManager.default.removeItem(at: previous)
            try? FileManager.default.moveItem(at: url, to: previous)
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        if let file = try? FileHandle(forWritingTo: url) {
            _ = try? file.seekToEnd()
            try? file.write(contentsOf: data)
            try? file.close()
        }
    }
}

@main
@MainActor
enum Main {
    static func main() throws {
        var configuration = Configuration()
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.count == 2, arguments[0] == "--fixture-config" {
            configuration = try JSONDecoder().decode(Configuration.self,
                from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
            guard configuration.fixture,
                  !configuration.bundleIdentifiers.contains("com.openai.codex") else {
                fatalError("Fixture configuration must not target the real app")
            }
        } else {
            var index = 0
            var provided: Set<String> = []
            while index < arguments.count {
                let option = arguments[index]
                guard index + 1 < arguments.count, provided.insert(option).inserted,
                      arguments[index + 1].hasPrefix("/") else {
                    fatalError("Expected each option once with an absolute path")
                }
                switch option {
                case "--launcher": configuration.launcherPath = arguments[index + 1]
                case "--data-directory": configuration.dataDirectory = arguments[index + 1]
                default: fatalError("Unknown option: \(option)")
                }
                index += 2
            }
        }
        let listener = try AutoInject(configuration: configuration)
        listener.start()
        withExtendedLifetime(listener) { RunLoop.main.run() }
    }
}
