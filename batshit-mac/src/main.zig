const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const runner = @import("runner");
const zero_native = @import("zero-native");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const default_batshit_url = "http://127.0.0.1:5620/";
const default_supervisor_script = "scripts/mac-runtime-supervisor.mjs";
const mac_launch_path = "PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const chromium_build = std.mem.eql(u8, build_options.web_engine, "chromium");
const app_name = if (chromium_build) "Batshit Chromium" else "Batshit";
const app_bundle_id = if (chromium_build) "ai.batshit.mac.chromium" else "ai.batshit.mac";
const max_allowed_origins = base_allowed_origins.len + configured_origin_env_names.len;

extern fn _NSGetExecutablePath(buf: [*]u8, bufsize: *u32) c_int;

const App = struct {
    env_map: *std.process.Environ.Map,
    gpa: std.mem.Allocator,
    io: std.Io,
    handlers: [6]zero_native.BridgeHandler = undefined,
    allowed_origins: [max_allowed_origins][]const u8 = undefined,
    allowed_origin_count: usize = 0,
    bridge_policies: [6]zero_native.BridgeCommandPolicy = undefined,
    builtin_bridge_policies: [1]zero_native.BridgeCommandPolicy = undefined,
    shutdown_thread: ?std.Thread = null,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "batshit",
            .source = zero_native.WebViewSource.assets(.{
                .root_path = "frontend/dist",
                .entry = "index.html",
                .origin = "zero://app",
                .spa_fallback = true,
            }),
            .source_fn = source,
            .stop_fn = stop,
        };
    }

    // The platform keeps AppKit's main thread alive with NSTerminateLater while
    // this joined worker waits for the supervisor. The supervisor writes the
    // shutdown-complete marker that lets AppKit finish termination.
    fn stop(context: *anyopaque, runtime: *zero_native.Runtime) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        if (self.shutdown_thread != null) return;
        self.shutdown_thread = std.Thread.spawn(.{}, stopSupervisorInBackground, .{self}) catch |err| {
            std.debug.print("batshit quit worker failed to start: {s}\n", .{@errorName(err)});
            return;
        };
    }

    fn stopSupervisorInBackground(self: *@This()) void {
        var output: [64 * 1024]u8 = undefined;
        const result = self.runSupervisor("stop", &output) catch |err| {
            std.debug.print("batshit quit cleanup failed: {s}\n", .{@errorName(err)});
            return;
        };
        std.debug.print("batshit quit cleanup: {s}\n", .{result});
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        if (self.env_map.get("BATSHIT_MAC_DIRECT_URL")) |url| {
            if (url.len > 0) return zero_native.WebViewSource.url(url);
        }
        if (self.env_map.get("ZERO_NATIVE_FRONTEND_URL")) |url| {
            if (url.len > 0) return zero_native.WebViewSource.url(url);
        }
        return zero_native.WebViewSource.assets(.{
            .root_path = "frontend/dist",
            .entry = "index.html",
            .origin = "zero://app",
            .spa_fallback = true,
        });
    }

    fn bridge(self: *@This()) zero_native.BridgeDispatcher {
        const origins = self.allowedOrigins();
        self.handlers = .{
            .{ .name = "batshit.runtime.status", .context = self, .invoke_fn = runtimeStatus },
            .{ .name = "batshit.runtime.doctor", .context = self, .invoke_fn = runtimeDoctor },
            .{ .name = "batshit.runtime.start", .context = self, .invoke_fn = runtimeStart },
            .{ .name = "batshit.runtime.stop", .context = self, .invoke_fn = runtimeStop },
            .{ .name = "batshit.runtime.restart", .context = self, .invoke_fn = runtimeRestart },
            .{ .name = "batshit.runtime.appleContainerStart", .context = self, .invoke_fn = runtimeAppleContainerStart },
        };
        self.bridge_policies = .{
            .{ .name = "batshit.runtime.status", .origins = origins },
            .{ .name = "batshit.runtime.doctor", .origins = origins },
            .{ .name = "batshit.runtime.start", .origins = origins },
            .{ .name = "batshit.runtime.stop", .origins = origins },
            .{ .name = "batshit.runtime.restart", .origins = origins },
            .{ .name = "batshit.runtime.appleContainerStart", .origins = origins },
        };
        return .{
            .policy = .{ .enabled = true, .commands = &self.bridge_policies },
            .registry = .{ .handlers = &self.handlers },
        };
    }

    fn builtinBridgePolicy(self: *@This()) zero_native.BridgePolicy {
        self.builtin_bridge_policies = .{
            .{ .name = "zero-native.dialog.saveFile", .origins = self.allowedOrigins() },
        };
        return .{ .enabled = true, .commands = &self.builtin_bridge_policies };
    }

    fn configureAllowedOrigins(self: *@This()) void {
        self.allowed_origin_count = 0;
        for (base_allowed_origins) |origin| self.appendAllowedOrigin(origin);
        for (configured_origin_env_names) |name| {
            const value = self.env_map.get(name) orelse continue;
            const origin = validatedLoopbackOrigin(value) orelse continue;
            self.appendAllowedOrigin(origin);
        }
    }

    fn appendAllowedOrigin(self: *@This(), origin: []const u8) void {
        for (self.allowedOrigins()) |existing| {
            if (std.mem.eql(u8, existing, origin)) return;
        }
        if (self.allowed_origin_count >= self.allowed_origins.len) return;
        self.allowed_origins[self.allowed_origin_count] = origin;
        self.allowed_origin_count += 1;
    }

    fn allowedOrigins(self: *const @This()) []const []const u8 {
        return self.allowed_origins[0..self.allowed_origin_count];
    }

    fn runtimeStatus(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return self.runSupervisor("status", output);
    }

    fn runtimeDoctor(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return self.runSupervisor("doctor", output);
    }

    fn runtimeStart(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return self.runSupervisor("start", output);
    }

    fn runtimeStop(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return self.runSupervisor("stop", output);
    }

    fn runtimeRestart(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return self.runSupervisor("restart", output);
    }

    fn runtimeAppleContainerStart(context: *anyopaque, invocation: zero_native.bridge.Invocation, output: []u8) anyerror![]const u8 {
        _ = invocation;
        const self: *@This() = @ptrCast(@alignCast(context));
        return self.runSupervisor("apple-container-start", output);
    }

    fn runSupervisor(self: *@This(), action: []const u8, output: []u8) anyerror![]const u8 {
        var script_buffer: [std.fs.max_path_bytes]u8 = undefined;
        var node_buffer: [std.fs.max_path_bytes]u8 = undefined;
        const script = self.resolveSupervisorScript(&script_buffer);
        if (!self.scriptExists(script)) {
            return supervisorError(output, "supervisor_script_missing", script);
        }
        const result = if (self.resolveBundledNode(&node_buffer)) |node_command|
            std.process.run(self.gpa, self.io, .{
                .argv = &.{ node_command, script, action },
                .stdout_limit = .limited(output.len),
                .stderr_limit = .limited(16 * 1024),
                .reserve_amount = 4096,
            }) catch |err| return supervisorError(output, "supervisor_failed", @errorName(err))
        else
            std.process.run(self.gpa, self.io, .{
                .argv = &.{ "/usr/bin/env", mac_launch_path, "node", script, action },
                .stdout_limit = .limited(output.len),
                .stderr_limit = .limited(16 * 1024),
                .reserve_amount = 4096,
            }) catch |err| return supervisorError(output, "supervisor_failed", @errorName(err));
        defer self.gpa.free(result.stdout);
        defer self.gpa.free(result.stderr);

        const trimmed = std.mem.trim(u8, result.stdout, " \t\r\n");
        const ok = switch (result.term) {
            .exited => |code| code == 0,
            else => false,
        };
        if (!ok or trimmed.len == 0 or !zero_native.bridge.isValidJsonValue(trimmed)) {
            const detail = if (result.stderr.len > 0) result.stderr else result.stdout;
            return supervisorError(output, "supervisor_command_failed", detail);
        }
        if (trimmed.len > output.len) return error.NoSpaceLeft;
        @memcpy(output[0..trimmed.len], trimmed);
        return output[0..trimmed.len];
    }

    fn resolveBundledNode(self: *@This(), buffer: []u8) ?[]const u8 {
        if (self.env_map.get("BATSHIT_MAC_NODE_RUNTIME")) |node_command| {
            if (node_command.len > 0 and self.scriptExists(node_command)) return node_command;
        }
        if (comptime builtin.os.tag == .macos) {
            var exe_buffer: [std.fs.max_path_bytes]u8 = undefined;
            var len: u32 = exe_buffer.len;
            if (_NSGetExecutablePath(&exe_buffer, &len) == 0) {
                const exe_path = exe_buffer[0..len];
                if (std.fs.path.dirname(exe_path)) |macos_dir| {
                    if (std.fs.path.dirname(macos_dir)) |contents_dir| {
                        const candidate = std.fmt.bufPrint(
                            buffer,
                            "{s}/Resources/runtime/vendor/node/bin/node",
                            .{contents_dir},
                        ) catch return null;
                        if (self.scriptExists(candidate)) return candidate;
                    }
                }
            }
        }
        return null;
    }

    fn scriptExists(self: *@This(), script: []const u8) bool {
        if (std.fs.path.isAbsolute(script)) {
            std.Io.Dir.accessAbsolute(self.io, script, .{}) catch return false;
            return true;
        }
        std.Io.Dir.cwd().access(self.io, script, .{}) catch return false;
        return true;
    }

    fn sanitizeJsonString(input: []const u8, buffer: []u8) []const u8 {
        var index: usize = 0;
        for (input) |char| {
            if (index >= buffer.len) break;
            buffer[index] = if (char == '"' or char == '\\')
                '\''
            else if (char == '\n' or char == '\r' or char == '\t' or char < 0x20)
                ' '
            else
                char;
            index += 1;
        }
        return buffer[0..index];
    }

    fn supervisorError(output: []u8, code: []const u8, detail: []const u8) anyerror![]const u8 {
        var safe_code_buffer: [128]u8 = undefined;
        var safe_detail_buffer: [4096]u8 = undefined;
        const safe_code = sanitizeJsonString(code, &safe_code_buffer);
        const safe_detail = sanitizeJsonString(detail, &safe_detail_buffer);
        return std.fmt.bufPrint(
            output,
            "{{\"success\":false,\"ok\":false,\"error\":\"{s}\",\"detail\":\"{s}\"}}",
            .{ safe_code, safe_detail },
        );
    }

    fn resolveSupervisorScript(self: *@This(), buffer: []u8) []const u8 {
        if (self.env_map.get("BATSHIT_MAC_SUPERVISOR_SCRIPT")) |script| {
            if (script.len > 0) return script;
        }
        if (comptime builtin.os.tag == .macos) {
            var exe_buffer: [std.fs.max_path_bytes]u8 = undefined;
            var len: u32 = exe_buffer.len;
            if (_NSGetExecutablePath(&exe_buffer, &len) == 0) {
                const exe_path = exe_buffer[0..len];
                if (std.fs.path.dirname(exe_path)) |macos_dir| {
                    if (std.fs.path.dirname(macos_dir)) |contents_dir| {
                        return std.fmt.bufPrint(
                            buffer,
                            "{s}/Resources/scripts/mac-runtime-supervisor.mjs",
                            .{contents_dir},
                        ) catch default_supervisor_script;
                    }
                }
            }
        }
        return default_supervisor_script;
    }
};

const base_allowed_origins = [_][]const u8{
    "zero://app",
    "zero://inline",
    "http://127.0.0.1:5620",
    "http://localhost:5620",
    "http://127.0.0.1:5640",
    "http://localhost:5640",
};

const configured_origin_env_names = [_][]const u8{
    "BATSHIT_FRONTEND_URL",
    "BATSHIT_MAC_DIRECT_URL",
    "ZERO_NATIVE_FRONTEND_URL",
};

const external_link_urls = [_][]const u8{
    "https://*",
    "http://*",
};

fn validatedLoopbackOrigin(value: []const u8) ?[]const u8 {
    const trimmed = std.mem.trim(u8, value, " \t\r\n");
    const origin = if (std.mem.endsWith(u8, trimmed, "/")) trimmed[0 .. trimmed.len - 1] else trimmed;
    const prefixes = [_][]const u8{
        "http://127.0.0.1:",
        "http://localhost:",
    };
    for (prefixes) |prefix| {
        if (!std.mem.startsWith(u8, origin, prefix)) continue;
        const port_text = origin[prefix.len..];
        if (port_text.len == 0 or port_text.len > 5) return null;
        var port: u32 = 0;
        for (port_text) |char| {
            if (char < '0' or char > '9') return null;
            port = port * 10 + (char - '0');
            if (port > 65_535) return null;
        }
        if (port == 0) return null;
        return origin;
    }
    return null;
}

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map, .gpa = init.gpa, .io = init.io };
    app.configureAllowedOrigins();
    defer if (app.shutdown_thread) |thread| thread.join();
    try runner.runWithOptions(app.app(), .{
        .app_name = app_name,
        .window_title = app_name,
        .bundle_id = app_bundle_id,
        .icon_path = "assets/icon.icns",
        .bridge = app.bridge(),
        .builtin_bridge = app.builtinBridgePolicy(),
        .security = .{
            .navigation = .{
                .allowed_origins = app.allowedOrigins(),
                .external_links = .{
                    .action = .open_system_browser,
                    .allowed_urls = &external_link_urls,
                },
            },
        },
    }, init);
}

test "runtime source defaults to packaged doctor assets" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    var app = App{ .env_map = &env, .gpa = std.testing.allocator, .io = std.testing.io };

    const source_value = try App.source(&app);

    try std.testing.expectEqual(zero_native.WebViewSourceKind.assets, source_value.kind);
    try std.testing.expectEqualStrings("frontend/dist", source_value.asset_options.?.root_path);
}

test "configured local frontend origin is trusted by navigation and bridge policies" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("BATSHIT_FRONTEND_URL", "http://127.0.0.1:5650/");
    var app = App{ .env_map = &env, .gpa = std.testing.allocator, .io = std.testing.io };

    app.configureAllowedOrigins();

    try std.testing.expectEqualStrings("http://127.0.0.1:5650", app.allowedOrigins()[base_allowed_origins.len]);
    try std.testing.expect(app.bridge().policy.allows("batshit.runtime.status", "http://127.0.0.1:5650"));
    try std.testing.expect(app.builtinBridgePolicy().allows("zero-native.dialog.saveFile", "http://127.0.0.1:5650"));
}

test "configured frontend origin accepts only explicit loopback http ports" {
    try std.testing.expectEqualStrings("http://localhost:5650", validatedLoopbackOrigin(" http://localhost:5650/ ").?);
    try std.testing.expectEqualStrings("http://127.0.0.1:1", validatedLoopbackOrigin("http://127.0.0.1:1").?);
    try std.testing.expect(validatedLoopbackOrigin("https://127.0.0.1:5650") == null);
    try std.testing.expect(validatedLoopbackOrigin("http://0.0.0.0:5650") == null);
    try std.testing.expect(validatedLoopbackOrigin("http://localhost:5650/setup") == null);
    try std.testing.expect(validatedLoopbackOrigin("http://localhost:0") == null);
    try std.testing.expect(validatedLoopbackOrigin("http://localhost:65536") == null);
    try std.testing.expect(validatedLoopbackOrigin("http://localhost:999999999999999999999999") == null);
}
